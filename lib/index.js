import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { constants, realpathSync, statSync } from "node:fs";
import { cpus, homedir, totalmem } from "node:os";
import { lstat, mkdir, mkdtemp, open, readdir, realpath } from "node:fs/promises";
import z$1 from "@deepseek-ai/schemastery";
//#region lib/types/mount-policy.js
/**
* Canonical host-mount policy for protected-mode guests.
*
* The Phase-1 screen was a fixed string list: it blocked every `/Users/...`
* mount (even one the user explicitly chose) while missing canonicalized
* paths, symlink escapes, and control-plane directories like the DSH profile.
* This module replaces it with a real decision procedure:
*
* 1. an explicit approval intent is required — a mount is allowed only under
*    a root the user explicitly approved;
* 2. paths are canonicalized before any comparison (`~` expansion, `..`
*    normalization, realpath of the nearest existing ancestor), so
*    path-prefix tricks (`/Users-evil`, `/etcx`) and symlink detours through
*    blocked roots cannot slip past;
* 3. runtime-safe checks: broad roots (`/`, `/Users`, `/home`, the home
*    directory itself) are refused as mounts because they expose every home
*    or every control file, and control subtrees (DSH profile, SSH, cloud
*    credentials, Docker config, macOS Library, the system tree) are refused
*    wherever they resolve;
* 4. a mount that would CONTAIN a blocked root (an ancestor of it) is refused
*    too — read-only access does not relax any rule, since reading the DSH
*    profile or SSH keys is exactly the leak.
*
* Residual risk, stated honestly: a not-yet-existing leaf can later be
* replaced by a symlink into a blocked root. The manager canonicalizes at
* admission and the Docker backend re-checks before `create`; live acceptance
* must verify the mount inside the guest.
* @module
*/
/** Roots that may never be mounted, nor mounted as part of anything broader. */
const BLOCKED_EXACT_ROOTS = [
	"/",
	"/Users",
	"/home",
	"/private",
	"/System/Volumes"
];
/** Subtrees that may never be entered by a protected-mode mount. */
const BLOCKED_SUBTREES = [
	"/etc",
	"/private/etc",
	"/var",
	"/private/var",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/opt",
	"/Applications",
	"/Library",
	"/System",
	"/root",
	"/proc",
	"/sys",
	"/dev",
	"/home/root"
];
/** Home-relative control directories that may never be entered (joined to the home). */
const HOME_CONTROL_DIRS = [
	".dsh",
	".ssh",
	".aws",
	".gnupg",
	".docker",
	".config",
	".colima",
	".lima",
	".kube",
	".Trash",
	"Library",
	"Applications",
	".npm",
	".zshrc",
	".bashrc",
	".profile"
];
function splitPath(path) {
	return path.split(sep).filter((part) => part.length > 0);
}
/** True when `child` is `parent` or below it, on path-segment boundaries. */
function isSameOrUnder(parent, child) {
	return child === parent || child.startsWith(parent === sep ? parent : parent + sep);
}
/** Expand a leading `~` and normalize `.`/`..` without touching the filesystem. */
function expandAndNormalize(path, home) {
	let text = path;
	if (text === "~") text = home;
	else if (text.startsWith("~/") || text.startsWith("~\\")) text = join(home, text.slice(2));
	if (!isAbsolute(text)) throw new Error(`mount path '${path}' must be absolute or start with ~/`);
	const out = [];
	for (const part of splitPath(resolve(text))) if (part === "..") out.pop();
	else out.push(part);
	return sep + out.join(sep);
}
/**
* Canonicalize a host path: expand `~`, normalize, then resolve symlinks for
* the nearest existing ancestor so a symlinked directory above the target
* cannot smuggle the path into a blocked root. A path whose every ancestor is
* missing fails closed.
* @param path - the raw host path from configuration or user input.
* @param context - policy context providing realpath/exists/homedir.
* @returns the canonical absolute path.
* @throws when the path is relative or no ancestor exists.
*/
function canonicalizeHostPath(path, context) {
	let current = expandAndNormalize(path, context.homedir);
	const suffix = [];
	for (;;) {
		if (current === sep) break;
		if (context.exists(current)) {
			const real = context.realpath(current);
			return suffix.length === 0 ? real : resolve(real, ...suffix);
		}
		suffix.unshift(splitPath(current).at(-1));
		current = parse(current).dir;
	}
	throw new Error(`mount path '${path}' has no existing ancestor to canonicalize`);
}
function blockedSubtrees(context) {
	const home = context.homedir;
	const homeControls = HOME_CONTROL_DIRS.map((dir) => join(home, dir));
	const extras = (context.extraBlockedSubtrees ?? []).map((extra) => resolve(extra));
	return [
		...BLOCKED_SUBTREES,
		...homeControls,
		...extras
	];
}
/**
* Decide whether one host mount may be shared with a protected-mode guest.
* @param mount - the requested mount with its visible access mode.
* @param context - policy context (approval roots, canonicalization, home).
* @returns the decision with a precise reason when denied.
*/
function evaluateHostMount(mount, context) {
	const deny = (reason) => ({
		ok: false,
		reason
	});
	let canonical;
	try {
		canonical = canonicalizeHostPath(mount.hostPath, context);
	} catch (error) {
		return deny(`the mount ${mount.hostPath} cannot be validated: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (BLOCKED_EXACT_ROOTS.includes(canonical)) return deny(`the mount ${mount.hostPath} is not allowed: ${canonical} exposes every account and control file on the host`);
	for (const root of blockedSubtrees(context)) {
		if (isSameOrUnder(canonical, root)) return deny(`the mount ${mount.hostPath} is not allowed: ${canonical} contains the control path ${root}`);
		if (isSameOrUnder(root, canonical)) return deny(`the mount ${mount.hostPath} is not allowed: ${canonical} is inside the blocked path ${root}`);
	}
	if (canonical === context.homedir) return deny(`the mount ${mount.hostPath} is not allowed: the home directory itself may never be shared`);
	if (!context.approvedRoots.some((root) => {
		let canonicalRoot;
		try {
			canonicalRoot = canonicalizeHostPath(root, context);
		} catch {
			return false;
		}
		return isSameOrUnder(canonicalRoot, canonical);
	})) return deny(`the mount ${mount.hostPath} is not allowed: no explicit approval covers ${canonical}`);
	if (expandAndNormalizeGuest(mount.guestPath) === sep) return deny(`the mount ${mount.hostPath} is not allowed: the guest path may not be /`);
	return {
		ok: true,
		canonicalPath: canonical
	};
}
function expandAndNormalizeGuest(path) {
	if (!path.startsWith("/")) throw new Error(`guest path '${path}' must be absolute`);
	const out = [];
	for (const part of splitPath(path)) if (part === "..") out.pop();
	else out.push(part);
	return sep + out.join(sep);
}
/**
* Build a policy context backed by the real filesystem.
* @param options - approved roots, extra blocked subtrees, home override.
* @returns a context usable by {@link evaluateHostMount}.
*/
function makeFsMountPolicyContext(options) {
	return {
		realpath: (path) => realpathSync(path),
		exists: (path) => {
			try {
				statSync(path);
				return true;
			} catch {
				return false;
			}
		},
		homedir: options.homedir ?? homedir(),
		approvedRoots: options.approvedRoots,
		...options.extraBlockedSubtrees !== void 0 ? { extraBlockedSubtrees: options.extraBlockedSubtrees } : {}
	};
}
//#endregion
//#region lib/types/environments.js
/** Mint an environment id from a generated raw string (single brand site). */
function asEnvironmentId(raw) {
	if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(raw)) throw new Error(`wrapvm-isolate: invalid environment id '${raw}'`);
	return raw;
}
//#endregion
//#region lib/types/workspace-copy.js
/** Bounded, explicit project snapshots. No symlinks, credentials or host deletion. */
var ExcludedContentError = class extends Error {};
const COPY_LIMITS = {
	files: 5e3,
	bytes: 64 * 1024 * 1024,
	fileBytes: 2 * 1024 * 1024
};
const excludedNames = new Set([
	".git",
	".dev",
	".dsh",
	".ssh",
	".aws",
	".gnupg",
	".docker",
	".kube",
	".npmrc",
	".pypirc",
	".netrc",
	".yarnrc.yml",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".next",
	"dist",
	"build",
	"coverage",
	".wrapvm-exports",
	".wrapvm-snapshot.json"
]);
function excludedPath(path) {
	return path.split("/").some((part) => excludedNames.has(part) || /^\.env(?:\.|$)/i.test(part) || /(?:\.(?:pem|key|p12|pfx|keystore)|^id_(?:rsa|ed25519|ecdsa)|^credentials(?:\.|$)|^secrets?(?:\.|$))/i.test(part));
}
function filePath(value) {
	if (!value || isAbsolute(value) || value.includes("\\") || Array.from(value).some((char) => char.charCodeAt(0) < 32) || value.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("vm_workspace: expected a relative file path inside the project");
	if (excludedPath(value)) throw new Error(`vm_workspace: excluded path ${value}`);
	return value;
}
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function projectRoot(path) {
	const root = await realpath(path);
	if (!(await lstat(root)).isDirectory()) throw new Error("vm_prepare: workspace is not a directory");
	const context = makeFsMountPolicyContext({ approvedRoots: [root] });
	const decision = evaluateHostMount({
		hostPath: root,
		guestPath: "/mnt/project",
		access: "read-only"
	}, context);
	if (!decision.ok) throw new Error(`vm_prepare: unsafe workspace: ${decision.reason}`);
	return root;
}
/** Revalidate all ancestors and use O_NOFOLLOW for the final file. */
async function readProjectFile(root, name) {
	filePath(name);
	if (await realpath(root) !== root) throw new Error("vm_workspace: project root changed");
	let parent = root;
	for (const part of name.split("/").slice(0, -1)) {
		parent = join(parent, part);
		if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error("vm_workspace: symlink or non-directory ancestor");
	}
	const path = join(root, name);
	const resolved = relative(root, await realpath(path));
	if (resolved.startsWith(".." + sep) || isAbsolute(resolved)) throw new Error("vm_workspace: file escapes project");
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > COPY_LIMITS.fileBytes) throw new Error(`vm_workspace: unsupported or oversized file ${name}`);
		const buffer = Buffer.alloc(COPY_LIMITS.fileBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		const after = await handle.stat();
		if (size > COPY_LIMITS.fileBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) throw new Error(`vm_workspace: file changed during snapshot: ${name}`);
		const bytes = buffer.subarray(0, size);
		if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString("utf8"))) throw new ExcludedContentError(`vm_workspace: private key content excluded: ${name}`);
		return {
			path: name,
			hash: hashBytes(bytes),
			size,
			executable: (before.mode & 73) !== 0,
			data: bytes.toString("base64")
		};
	} finally {
		await handle.close();
	}
}
async function snapshotProject(root, signal, paths) {
	const result = {
		files: [],
		excluded: [],
		excludedCount: 0,
		bytes: 0
	};
	if (root === null) return result;
	const exclude = (name) => {
		result.excludedCount++;
		if (result.excluded.length < 100) result.excluded.push(name);
	};
	let visited = 0;
	const visit = async (name) => {
		signal.throwIfAborted();
		if (++visited > 2e4) throw new Error("vm_workspace: project entry limit exceeded");
		if (excludedPath(name)) {
			exclude(name);
			return;
		}
		const path = join(root, name);
		const info = await lstat(path);
		if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || !info.isDirectory() && !info.isFile()) {
			exclude(name);
			return;
		}
		if (info.isDirectory()) {
			if (paths) throw new Error("vm_workspace: targeted transfers require individual file paths, not directories");
			if (name.split("/").length > 40) throw new Error("vm_workspace: project nesting limit exceeded");
			if (await realpath(path) !== path) throw new Error("vm_workspace: directory changed during snapshot");
			for (const child of (await readdir(path)).sort()) await visit(name ? `${name}/${child}` : child);
		} else {
			let file;
			try {
				file = await readProjectFile(root, name);
			} catch (error) {
				if (error instanceof ExcludedContentError) {
					exclude(name);
					return;
				}
				throw error;
			}
			result.bytes += file.size;
			result.files.push(file);
			if (result.files.length > COPY_LIMITS.files || result.bytes > COPY_LIMITS.bytes) throw new Error("vm_workspace: project exceeds 5000 files or 64 MiB; narrow the session workspace");
		}
	};
	if (paths) for (const path of new Set(paths)) {
		filePath(path);
		await visit(path);
	}
	else for (const name of (await readdir(root)).sort()) await visit(name);
	return result;
}
/** Export to a NEW review directory. Never overwrite the host project's original files. */
async function exportReview(root, files, baseline, signal) {
	if (await projectRoot(root) !== root) throw new Error("vm_workspace: project identity changed");
	const parsed = files.map((f) => {
		filePath(f.path);
		const bytes = Buffer.from(f.data, "base64");
		if (bytes.length > COPY_LIMITS.fileBytes || hashBytes(bytes) !== f.hash || bytes.length !== f.size) throw new Error("vm_workspace: invalid guest file payload");
		return {
			...f,
			bytes
		};
	});
	if (parsed.length > COPY_LIMITS.files || parsed.reduce((n, f) => n + f.size, 0) > COPY_LIMITS.bytes) throw new Error("vm_workspace: export exceeds limits");
	const conflicts = [];
	for (const file of parsed) {
		signal.throwIfAborted();
		const base = baseline.find((f) => f.path === file.path);
		try {
			if ((await readProjectFile(root, file.path)).hash !== base?.hash) conflicts.push(file.path);
		} catch (error) {
			if (error.code !== "ENOENT" || base) conflicts.push(file.path);
		}
	}
	const parent = join(root, ".wrapvm-exports");
	await mkdir(parent, { mode: 448 }).catch((error) => {
		if (error.code !== "EEXIST") throw error;
	});
	if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error("vm_workspace: unsafe export directory");
	const directory = await mkdtemp(join(parent, "review-"));
	for (const file of parsed) {
		signal.throwIfAborted();
		const path = join(directory, file.path);
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		if (await realpath(dirname(path)) !== dirname(path)) throw new Error("vm_workspace: export directory changed");
		const handle = await open(path, "wx", file.executable ? 448 : 384);
		try {
			await handle.writeFile(file.bytes);
		} finally {
			await handle.close();
		}
	}
	return {
		directory,
		conflicts
	};
}
//#endregion
//#region lib/types/preparation.js
/** Session-scoped provisioning, durable retries and workspace identity. No Remote impersonation. */
const preparationSchema = z.object({
	id: z.string().uuid(),
	session: z.string(),
	sourceRoot: z.string().nullable(),
	mode: z.enum([
		"copy",
		"empty",
		"bind-readonly",
		"bind-readwrite"
	]),
	environmentId: z.string().nullable(),
	containerId: z.string().nullable(),
	guestPath: z.string(),
	phase: z.enum(["preparing", "ready"]),
	input: z.object({
		displayName: z.string(),
		image: z.string(),
		internetAccess: z.boolean(),
		limits: z.object({
			cpuMillis: z.number(),
			memoryBytes: z.number()
		}),
		mounts: z.array(z.object({
			hostPath: z.string(),
			guestPath: z.string(),
			access: z.enum(["read-only", "read-write"])
		}))
	}),
	files: z.array(z.object({
		path: z.string(),
		hash: z.string(),
		size: z.number(),
		executable: z.boolean()
	})),
	snapshot: z.string(),
	excluded: z.array(z.string()),
	excludedCount: z.number()
});
/** Shared with GUI bind/unbind so a late prepare cannot overwrite a newer user selection. */
var SessionOperations = class {
	pending = /* @__PURE__ */ new Map();
	async run(session, work) {
		const next = (this.pending.get(session) ?? Promise.resolve()).catch(() => {}).then(work);
		this.pending.set(session, next);
		try {
			return await next;
		} finally {
			if (this.pending.get(session) === next) this.pending.delete(session);
		}
	}
};
function preparationKey(session, root, mode, environmentId) {
	return createHash("sha256").update(JSON.stringify([
		session,
		root,
		mode,
		environmentId ?? null
	])).digest("hex");
}
const snapshotIdentity = (files) => createHash("sha256").update(JSON.stringify(files)).digest("hex");
/** Caller holds the session operation queue. Persist intent BEFORE any Docker effects. */
async function prepareEnvironment(ports, session, root, requested, signal) {
	signal.throwIfAborted();
	const mode = requested.workspaceMode ?? (root === null ? "empty" : "copy");
	if (mode.startsWith("bind-") && root === null) throw new Error("vm_prepare: no session project to share");
	const binding = ports.bindings.binding(session);
	const baseKey = preparationKey(session, root, mode);
	const base = ports.store.get(baseKey);
	const selected = requested.environmentId ?? binding?.environmentId;
	const selectedKey = selected ? preparationKey(session, root, mode, selected) : void 0;
	const key = selectedKey && ports.store.get(selectedKey) ? selectedKey : selected && base?.environmentId === selected ? baseKey : selected && (requested.environmentId || base) ? selectedKey : baseKey;
	let record = ports.store.get(key);
	if (record && requested.environmentId && requested.environmentId !== record.environmentId) throw new Error("vm_prepare: this workspace already has a prepared environment; use it or change the session project");
	if (record && (record.session !== session || record.sourceRoot !== root || record.mode !== mode || record.guestPath !== `/home/user/workspace/projects/${record.id}` || record.snapshot !== snapshotIdentity(record.files))) throw new Error("vm_prepare: stored preparation does not match this session/project");
	let initial;
	if (!record) {
		initial = await snapshotProject(mode === "copy" ? root : null, signal);
		const id = randomUUID();
		const selected = requested.environmentId ?? binding?.environmentId ?? null;
		if (selected && !ports.get(asEnvironmentId(selected))) throw new Error("vm_prepare: selected environment is missing; no replacement was created");
		if (selected && mode.startsWith("bind-")) throw new Error("vm_prepare: bind mounts require a new environment; use copy mode with the selected environment");
		record = {
			id,
			session,
			sourceRoot: root,
			mode,
			environmentId: selected,
			containerId: null,
			guestPath: `/home/user/workspace/projects/${id}`,
			phase: "preparing",
			input: {
				displayName: root ? basename(root) : "Agent workspace",
				image: ports.defaults.image,
				limits: {
					cpuMillis: ports.defaults.cpuMillis,
					memoryBytes: ports.defaults.memoryBytes
				},
				internetAccess: ports.defaults.internetAccess,
				mounts: mode.startsWith("bind-") && root ? [{
					hostPath: root,
					guestPath: `/home/user/workspace/projects/${id}`,
					access: mode === "bind-readwrite" ? "read-write" : "read-only"
				}] : []
			},
			files: initial.files.map(({ data: _data, ...f }) => f),
			snapshot: snapshotIdentity(initial.files.map(({ data: _data, ...f }) => f)),
			excluded: initial.excluded,
			excludedCount: initial.excludedCount
		};
		await ports.store.put(key, record);
	}
	if (record.mode.startsWith("bind-") && record.environmentId === null) await ports.approveMount(record.sourceRoot, record.mode, signal);
	signal.throwIfAborted();
	if (record.environmentId === null) {
		const op = await ports.create(record.input, `prepare:${record.id}`, signal);
		if (op.state !== "completed") throw new Error(`vm_prepare: ${op.errorCode ?? op.state}: ${op.error ?? "environment preparation did not complete"}`);
		record = {
			...record,
			environmentId: op.environmentId
		};
		await ports.store.put(key, record);
	}
	if (!record.environmentId) throw new Error("vm_prepare: missing committed environment identity");
	const environmentId = asEnvironmentId(record.environmentId);
	const descriptor = ports.get(environmentId);
	if (!descriptor) throw new Error("vm_prepare: prepared environment was removed; no replacement was created");
	if (record.containerId && descriptor.containerId !== record.containerId) throw new Error("vm_prepare: container identity changed");
	const containerId = await ports.running(environmentId, signal);
	if (!record.containerId) {
		record = {
			...record,
			containerId
		};
		await ports.store.put(key, record);
	}
	await ports.install(record, initial, signal);
	if (record.phase !== "ready") {
		signal.throwIfAborted();
		record = {
			...record,
			phase: "ready"
		};
		await ports.store.put(key, record);
	}
	signal.throwIfAborted();
	const current = ports.bindings.binding(session);
	if (current?.environmentId !== environmentId) await ports.bindings.bind(session, environmentId, (current?.generation ?? 0) + 1, { allowShared: requested.environmentId !== void 0 });
	return record;
}
//#endregion
//#region lib/types/guest-workspace.js
/** Fixed guest program. Payloads are JSON on stdin, never interpolated shell code. */
const GUEST_WORKSPACE_PROGRAM = String.raw`
import os, sys, json, stat, hashlib, base64, tempfile, shutil
p=json.load(sys.stdin)
root=p['root']
if not root.startswith('/home/user/workspace/projects/') or any(x in ('','.', '..') for x in root.split('/')[1:]): raise ValueError('invalid workspace root')
def directory(path, create=False):
    current='/'
    for part in path.split('/')[1:]:
        current=os.path.join(current,part)
        if create:
            try: os.mkdir(current,0o700)
            except FileExistsError: pass
        if not stat.S_ISDIR(os.lstat(current).st_mode): raise ValueError('symlink or non-directory in workspace')
def path_for(base,name):
    if not name or name.startswith('/') or '\\' in name or any(x in ('','.', '..') for x in name.split('/')) or any(ord(x)<32 for x in name): raise ValueError('invalid relative path')
    return os.path.join(base,name)
def read(path):
    directory(os.path.dirname(path))
    fd=os.open(path, os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        info=os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>2097152: raise ValueError('unsupported file')
        data=f.read(2097153)
        if len(data)>2097152: raise ValueError('file too large')
        return data, bool(info.st_mode & 0o111)
def write_new(base,item):
    path=path_for(base,item['path']); directory(os.path.dirname(path),True)
    data=base64.b64decode(item['data'],validate=True)
    if len(data)>2097152 or hashlib.sha256(data).hexdigest()!=item['hash']: raise ValueError('invalid file data')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700 if item['executable'] else 0o600)
    with os.fdopen(fd,'wb') as f: f.write(data)
action=p['action']
marker=os.path.join(root,'.wrapvm-snapshot.json')
if action=='probe':
    if not os.path.lexists(root): print(json.dumps({'ready':False}))
    else:
        directory(root)
        data,_=read(marker)
        if json.loads(data)['snapshot']!=p['snapshot']: raise ValueError('workspace belongs to another snapshot')
        print(json.dumps({'ready':True}))
elif action=='install':
    directory(os.path.dirname(root),True)
    if os.path.lexists(root): raise ValueError('workspace already exists; probe before retry')
    stage=tempfile.mkdtemp(prefix='.wrapvm-stage-',dir=os.path.dirname(root))
    try:
        for item in p['files']: write_new(stage,item)
        with open(os.path.join(stage,'.wrapvm-snapshot.json'),'x') as f: json.dump({'snapshot':p['snapshot']},f)
        if os.path.lexists(root): raise ValueError('workspace appeared during preparation')
        os.rename(stage,root)
        print(json.dumps({'ready':True}))
    finally:
        if os.path.isdir(stage) and not os.path.islink(stage): shutil.rmtree(stage)
elif action=='import':
    directory(root); imported=[]; unchanged=[]; conflicts=[]
    for item in p['files']:
        path=path_for(root,item['path'])
        if os.path.lexists(path):
            data,_=read(path)
            if hashlib.sha256(data).hexdigest()==item['hash']: unchanged.append(item['path'])
            else: conflicts.append(item['path'])
        else:
            try: write_new(root,item); imported.append(item['path'])
            except FileExistsError: conflicts.append(item['path'])
    print(json.dumps({'imported':imported,'unchanged':unchanged,'conflicts':conflicts}))
elif action=='read':
    directory(root); result=[]; total=0
    for name in p['paths']:
        data,executable=read(path_for(root,name)); total+=len(data)
        if len(result)>=100 or total>67108864: raise ValueError('export limit exceeded')
        result.append({'path':name,'hash':hashlib.sha256(data).hexdigest(),'size':len(data),'executable':executable,'data':base64.b64encode(data).decode()})
    print(json.dumps({'files':result}))
else: raise ValueError('unknown workspace operation')
`;
//#endregion
//#region lib/types/agent-workspaces.js
function currentProject(ctx, execution) {
	const session = execution.agent?.session;
	if (!session) throw new Error("vm_prepare: tool call has no conversation");
	const directory = ctx.get("workingDirectory");
	const effective = directory?.get(session);
	return effective && (session.header.cwd || effective !== directory?.defaultDirectory) ? effective : session.header.cwd ?? null;
}
function workspaceInfo(record) {
	return record ? {
		phase: record.phase,
		mode: record.mode,
		sourceRoot: record.sourceRoot,
		guestPath: record.guestPath,
		snapshot: record.snapshot,
		files: record.files.length,
		excluded: record.excluded,
		excludedCount: record.excludedCount
	} : null;
}
async function targetOperation(runtime, record, signal, task) {
	if (!record.environmentId || !record.containerId) throw new Error("vm_workspace: environment not prepared");
	const id = asEnvironmentId(record.environmentId);
	const release = await runtime.leases.acquireExecution(id, "vm_workspace");
	try {
		signal.throwIfAborted();
		if (runtime.manager.uncertainty(id)) throw new Error("vm_workspace: environment outcome is unknown");
		const capture = await runtime.backend.captureTarget(id, signal);
		if (capture.kind !== "captured" || capture.target.containerId !== record.containerId) throw new Error("vm_workspace: container identity changed");
		if ((await runtime.backend.verifyTarget(capture.target, signal)).container.kind !== "owned") throw new Error("vm_workspace: container ownership cannot be verified");
		return await task(capture.target.containerId);
	} finally {
		release();
	}
}
async function guest(runtime, id, record, action, data, signal) {
	const result = await runtime.run([
		runtime.binary,
		"exec",
		"-i",
		id,
		"/opt/wrap/bin/wrap-entrypoint",
		"python3",
		"-c",
		GUEST_WORKSPACE_PROGRAM
	], {
		signal,
		maxBytes: 92 * 1024 * 1024,
		stdin: JSON.stringify({
			action,
			root: record.guestPath,
			snapshot: record.snapshot,
			...data
		})
	});
	if (result.exitCode !== 0) throw new Error(`vm_workspace: guest ${action} failed: ${result.stderr.slice(-2e3)}`);
	return JSON.parse(result.stdout);
}
async function prepareForAgent(ctx, runtime, execution, args) {
	const session = execution.agent?.session.id;
	if (!session) throw new Error("vm_prepare: tool call has no conversation");
	const signal = AbortSignal.any([execution.signal, runtime.lifetime]);
	const path = args.workspaceMode === "empty" ? null : currentProject(ctx, execution);
	const root = path === null ? null : await projectRoot(path);
	if (!runtime.defaults.internetAccess && !runtime.current(session) && !runtime.bindings.binding(session)) throw new Error("vm_prepare: profile disallows internet; this desktop backend cannot create offline environments. No resources allocated.");
	let lifecycle = "reused";
	const record = await prepareEnvironment({
		...runtime,
		get: (id) => runtime.manager.get(id),
		create: async (input, key, ended) => {
			const image = await runtime.run([
				runtime.binary,
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				input.image
			], { signal: ended });
			if (image.exitCode !== 0 || !image.stdout.trim()) throw new Error(`vm_prepare: configured image ${input.image} is not available locally; ask the user to install it or choose an installed image in plugin configuration`);
			lifecycle = "created";
			return await runtime.manager.create(input, {
				idempotencyKey: key,
				signal: ended
			});
		},
		running: async (id, ended) => {
			if (runtime.manager.uncertainty(id)) throw new Error("vm_prepare: environment has an uncertain operation; inspect it before retrying");
			let target = await runtime.backend.captureTarget(id, ended);
			if (target.kind !== "captured") throw new Error(`vm_prepare: environment ${target.kind}; no replacement created`);
			const health = await runtime.backend.probe(target.target, ended);
			if (health.phase === "paused" || health.phase === "stopped" || health.phase === "created") {
				const resume = health.phase === "paused";
				const op = await (resume ? runtime.manager.resume(id, { signal: ended }) : runtime.manager.start(id, { signal: ended }));
				if (op.state !== "completed") throw new Error(`vm_prepare: ${op.error ?? op.state}`);
				lifecycle = resume ? "resumed" : "started";
				target = await runtime.backend.captureTarget(id, ended);
				if (target.kind !== "captured") throw new Error("vm_prepare: target unavailable after start");
			}
			const ready = await runtime.backend.probe(target.target, ended);
			if (ready.phase !== "running" || ready.shell.kind !== "available") throw new Error("vm_prepare: guest is not ready; retry preparation once startup has completed");
			return target.target.containerId;
		},
		approveMount: async (source, mode, ended) => {
			const approval = ctx.get("approval");
			if (!approval || !execution.agent) throw new Error("vm_prepare: explicit host mount approval is unavailable; use copy mode");
			const decision = await approval.request({
				agent: execution.agent,
				toolName: "vm_prepare",
				callId: execution.callId,
				signal: ended,
				reason: `Share exactly ${source} with this VM in ${mode === "bind-readwrite" ? "READ/WRITE (guest can change host files)" : "read-only"} mode? This shares the full project, including files excluded from copy mode.`
			});
			if (decision !== "allowed-once") throw new Error(`vm_prepare: host mount ${decision}`);
			runtime.backend.approveMounts([{ hostPath: source }]);
		},
		install: async (item, initial, ended) => await targetOperation(runtime, item, ended, async (id) => {
			if (item.mode.startsWith("bind-")) {
				if ((await runtime.run([
					runtime.binary,
					"exec",
					id,
					"/opt/wrap/bin/wrap-entrypoint",
					"test",
					"-d",
					item.guestPath
				], { signal: ended })).exitCode !== 0) throw new Error("vm_prepare: shared workspace unavailable");
				return;
			}
			if (z.object({ ready: z.boolean() }).parse(await guest(runtime, id, item, "probe", {}, ended)).ready) return;
			if (item.phase === "ready") throw new Error("vm_prepare: prepared workspace disappeared; refusing to recreate it");
			const snapshot = initial ?? await snapshotProject(item.mode === "copy" ? item.sourceRoot : null, ended);
			if (snapshotIdentity(snapshot.files.map(({ data: _data, ...f }) => f)) !== item.snapshot) throw new Error("vm_prepare: host files changed after interrupted preparation; original intent preserved, no overwrite performed");
			z.object({ ready: z.literal(true) }).parse(await guest(runtime, id, item, "install", { files: snapshot.files }, ended));
		})
	}, session, root, args, signal);
	await runtime.select(record);
	return {
		ready: true,
		environmentId: record.environmentId,
		action: lifecycle,
		internetAccess: runtime.manager.get(asEnvironmentId(record.environmentId))?.internetAccess ?? false,
		workspace: workspaceInfo(record),
		next: "Use vm_shell, vm_browser or vm_desktop. The viewer is optional."
	};
}
async function workspaceForAgent(ctx, runtime, execution, args) {
	const signal = AbortSignal.any([execution.signal, runtime.lifetime]);
	signal.throwIfAborted();
	const session = execution.agent?.session.id;
	if (!session) throw new Error("vm_workspace: tool call has no conversation");
	const record = runtime.current(session);
	if (!record || record.environmentId !== runtime.bindings.binding(session)?.environmentId) throw new Error("vm_workspace: call vm_prepare for the current project first");
	if (args.action === "status") return { workspace: workspaceInfo(record) };
	if (record.phase !== "ready" || record.mode !== "copy" || !record.sourceRoot) throw new Error("vm_workspace: import/export requires a prepared project copy");
	const current = currentProject(ctx, execution);
	if (!current || await projectRoot(current) !== record.sourceRoot) throw new Error("vm_workspace: session project changed; call vm_prepare first");
	if (!args.paths?.length || args.paths.length > 100) throw new Error("vm_workspace: specify between 1 and 100 relative file paths");
	const paths = [...new Set(args.paths.map(filePath))];
	return await targetOperation(runtime, record, signal, async (id) => {
		if (args.action === "import") {
			const snapshot = await snapshotProject(record.sourceRoot, signal, paths);
			return z.object({
				imported: z.array(z.string()),
				unchanged: z.array(z.string()),
				conflicts: z.array(z.string())
			}).parse(await guest(runtime, id, record, "import", { files: snapshot.files }, signal));
		}
		if (args.action !== "export") throw new Error("vm_workspace: unknown action");
		const result = z.object({ files: z.array(z.object({
			path: z.string(),
			hash: z.string(),
			size: z.number(),
			executable: z.boolean(),
			data: z.string()
		})).max(100) }).parse(await guest(runtime, id, record, "read", { paths }, signal));
		if (result.files.length !== paths.length || result.files.some((f, i) => f.path !== paths[i])) throw new Error("vm_workspace: guest returned unrequested paths");
		return {
			...await exportReview(record.sourceRoot, result.files, record.files, signal),
			files: paths,
			appliedToOriginals: false,
			next: "Review exported files; originals have not been overwritten."
		};
	});
}
//#endregion
//#region lib/types/vm-skills.js
/** Bundled VM guidance. These strings never read paths supplied by a caller. */
const common = "Do not fall back to Mac tools or change permissions yourself. Do not restart or delete an environment to troubleshoot. Runtime policy and current status take precedence over earlier conversation text.";
/** Fixed guidance distributed with the bundle. */
const vmSkills = Object.freeze({
	"use-vm": `When the user requests VM work, call vm_prepare with a short description. It creates/reuses/starts/resumes an environment, copies the current session project and selects it automatically. Do not ask the user to create or select an environment in the GUI. No project means an empty persistent workspace. Use environmentId only for an explicitly requested managed environment (discover with vm_environments). Inspect exclusions and use the returned guestPath. Defaults are configured by the profile, including internet access. The selection routes vm_* tools only; ordinary host tools remain available. ${common}`,
	"vm-workspace": `Use vm_shell with {command, description, workdir?, timeoutMs?}; workdir is an absolute guest path and defaults to the project prepared by vm_prepare, otherwise /home/user/workspace. Install dependencies and work with files in the guest. Default preparation copies working files once, excludes credentials, .git, dependencies and build/cache directories, and never recopies on retry. Use vm_workspace status to inspect the manifest summary. Use vm_workspace import with relative paths to add files; differing guest files are reported as conflicts and never overwritten. Use vm_workspace export with relative paths to create a new .wrapvm-exports review directory in the current host project; host conflicts are reported and originals are preserved. Bind mounts require native approval and are never implied by copy mode. ${common}`,
	"vm-browser": `Use vm_browser with action open, tabs, navigate, eval, content, or close. open requires url; navigate requires targetId and url; eval requires targetId and expression; content and close require targetId. Use the target id returned by tabs or open. Inspect the page before interacting and allow time for it to load. ${common}`,
	"vm-desktop": `Use vm_desktop with {argv, timeoutMs?}; argv is passed literally to agent-desktop in the guest. Inspect the desktop and identify the intended application before input. ${common}`,
	"vm-development": `Run development commands with vm_shell in the guest. Open guest-local services in vm_browser. A persistent guest process facility is not available until vm_process is registered; do not substitute a host job or claim that a detached command is managed. ${common}`,
	"vm-recovery": `If the environment is stopped, paused, unavailable, or a request times out, inspect vm_status and call vm_prepare to start/resume the same environment. For missing environments, uncertain operations or changed workspace snapshots, report the specific blocker; never silently replace, reset or delete it. Check the result before retrying an operation whose outcome is uncertain. ${common}`
});
/** Names accepted by the bundled skill loader. */
const vmSkillNames = Object.freeze(Object.keys(vmSkills));
/** Read a bundled skill by exact name, rejecting all other input. */
function readVmSkill(name) {
	if (!Object.hasOwn(vmSkills, name)) throw new Error("load_vm_skill: unknown bundled VM skill");
	return vmSkills[name];
}
//#endregion
//#region lib/types/inventory.js
/**
* Durable environment inventory.
*
* The inventory is the authoritative record of which environments this
* plugin owns: identity, immutable container id, ownership labels, image
* digest, desired configuration, and the operation log used for crash
* recovery. It persists through the DSH storage domain (never browser local
* state). This package declares the domain spec structurally and ships a
* store port plus two implementations:
*
* - {@link MemoryInventoryStore} — tests and dry runs;
* - {@link DomainInventoryStore} — package-local adapter over the DSH
*   storage-domain `KvTable` face, storing one atomic snapshot record.
*
* Ownership is decided by labels plus immutable container ids, never by
* container names. Reads validate every record and fail closed: a corrupt
* record throws instead of silently shrinking the inventory.
* @module
*/
/** Domain name for the inventory (matches the storage-domain unit-name rules). */
const WRAPVM_ENVIRONMENT_DOMAIN = "wrapvm_environments";
/** Label marking every backend resource this plugin owns. */
const OWNERSHIP_LABEL = "dsh.wrapvm.environment";
/** Label carrying the durable environment id on every owned resource. */
const ENVIRONMENT_ID_LABEL = "dsh.wrapvm.environment-id";
/** Container name derived from the durable id (names stay disposable; ids own). */
function containerNameFor(id) {
	return `dsh-wrapvm-${id}`;
}
const environmentMountSchema = z.object({
	hostPath: z.string().min(1),
	guestPath: z.string().startsWith("/"),
	access: z.enum(["read-only", "read-write"])
});
const positiveSafeInt = z.number().refine((value) => Number.isSafeInteger(value) && value >= 1, { message: "must be a positive safe integer" });
const environmentLimitsSchema = z.object({
	cpuMillis: positiveSafeInt,
	memoryBytes: positiveSafeInt,
	diskBytes: positiveSafeInt.optional()
});
const environmentPortsSchema = z.object({
	viewerPort: z.int().min(1).max(65535),
	cdpPort: z.int().min(1).max(65535)
});
/**
* Ports as they appear inside a captured target or a create request: the
* backend may not have resolved ephemeral loopback ports yet, so 0 is a
* legal "unresolved" placeholder there (the driver refuses to settle one).
*/
const unresolvedPortsSchema = z.object({
	viewerPort: z.int().min(0).max(65535),
	cdpPort: z.int().min(0).max(65535)
});
/** Persisted shape of a create request: the full intent, validated at the boundary. */
const environmentCreateInputSchema = z.object({
	displayName: z.string().min(1),
	image: z.string().min(1),
	limits: environmentLimitsSchema,
	internetAccess: z.boolean(),
	mounts: z.array(environmentMountSchema),
	ports: unresolvedPortsSchema.optional()
});
/**
* Persisted shape of an admission-captured target (immutable destination
* snapshot). Passthrough on purpose: identity fields the backend adds at
* capture (network id, volume driver, and any later creation-identity
* fields) must survive persistence untouched — stripping them would silently
* weaken preview invalidation and recovery after a reload.
*/
const environmentTargetSchema = z.object({
	environmentId: z.string().min(3).max(64),
	containerId: z.string().min(1),
	containerName: z.string().min(1),
	networkName: z.string().min(1),
	volumeName: z.string().min(1),
	ports: unresolvedPortsSchema,
	imageDigest: z.string().min(1).optional(),
	capturedAt: z.number(),
	networkId: z.string().min(1).optional(),
	volumeDriver: z.string().min(1).optional(),
	volumeToken: z.string().min(1).optional(),
	volumeCreatedAt: z.string().min(1).optional()
}).loose();
/** Persisted discriminated operation payload: every kind's full parameters. */
const environmentOperationPayloadSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("create"),
		input: environmentCreateInputSchema
	}),
	z.object({ kind: z.literal("start") }),
	z.object({ kind: z.literal("stop") }),
	z.object({ kind: z.literal("pause") }),
	z.object({ kind: z.literal("resume") }),
	z.object({
		kind: z.literal("bind"),
		sessionKey: z.string().min(1),
		generation: z.number().int()
	}),
	z.object({
		kind: z.literal("unbind"),
		sessionKey: z.string().min(1)
	}),
	z.object({
		kind: z.literal("update-limits"),
		limits: environmentLimitsSchema
	}),
	z.object({
		kind: z.literal("remove"),
		deleteVolumes: z.boolean()
	})
]);
/** Stored descriptor record: the single source validated at the durable boundary. */
const environmentDescriptorSchema = z.object({
	id: z.string().min(3).max(64),
	backend: z.literal("docker"),
	containerId: z.string().min(1),
	ownership: z.enum(["plugin", "imported"]),
	image: z.string().min(1),
	digest: z.string().min(1),
	createdAt: z.number(),
	mounts: z.array(environmentMountSchema),
	limits: environmentLimitsSchema,
	internetAccess: z.boolean(),
	displayName: z.string().min(1).optional(),
	volumeName: z.string().min(1).optional(),
	networkName: z.string().min(1).optional(),
	ports: environmentPortsSchema.optional(),
	desiredPhase: z.enum([
		"running",
		"stopped",
		"paused"
	]).optional()
});
const environmentOperationSchema = z.object({
	id: z.string().min(1),
	environmentId: z.string().min(3).max(64),
	kind: z.enum([
		"create",
		"start",
		"stop",
		"pause",
		"resume",
		"bind",
		"unbind",
		"update-limits",
		"remove"
	]),
	state: z.enum([
		"requested",
		"running",
		"completed",
		"failed"
	]),
	error: z.string().optional(),
	errorCode: z.string().optional(),
	idempotencyKey: z.string().min(1).optional(),
	requestedAt: z.number().optional(),
	settledAt: z.number().optional(),
	payload: environmentOperationPayloadSchema.optional(),
	target: environmentTargetSchema.optional(),
	requestSignature: z.string().min(1).optional()
});
/**
* Structural declaration of the inventory domain, shaped to match the DSH
* storage-domain `DomainSpec` (name/version/layout/tables with zod value
* schemas). The adapter wiring (later phase) passes it through `defineDomain`
* and `ctx.storageDomain.open`; this package deliberately does not import the
* storage packages so it adds no dependency here.
*/
const wrapvmInventoryDomainSpec = {
	name: WRAPVM_ENVIRONMENT_DOMAIN,
	version: 1,
	layout: "per-record",
	tables: { snapshots: { valueSchema: z.object({
		environments: z.record(z.string(), environmentDescriptorSchema),
		operations: z.record(z.string(), environmentOperationSchema.strict())
	}) } }
};
/**
* Deterministic canonical JSON: object keys sorted, `undefined`/functions/
* symbols dropped. Used for the persisted request signature and for the
* removal preview's snapshot-equality check, so two semantically identical
* requests always produce byte-identical text regardless of key order.
* @param value - plain data (the persisted record shapes).
* @returns the canonical JSON text.
*/
function canonicalJson(value) {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (typeof value !== "object") return "null";
	return `{${Object.entries(value).filter(([, entry]) => entry !== void 0 && typeof entry !== "function" && typeof entry !== "symbol").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
/**
* Canonical semantic signature of a mutation request: kind, environment, and
* full parameters. Deliberately excludes operation id, timestamps, and the
* captured target so a retried request matches, while a DIFFERENT request
* reusing the same idempotency key never does. For `create` the environment
* id is generated by the manager per request, not supplied by the caller, so
* it is not part of the semantic request; for every other kind the target
* environment IS part of the request.
* @param operation - the requested operation (payload carries the parameters).
* @returns the canonical signature text.
*/
function operationRequestSignature(operation) {
	return canonicalJson({
		kind: operation.kind,
		environmentId: operation.kind === "create" ? null : operation.environmentId,
		payload: operation.payload ?? null
	});
}
/** Persists the entire inventory as one atomically replaced storage-domain record. */
var DomainInventoryStore = class {
	snapshots;
	constructor(snapshots) {
		this.snapshots = snapshots;
	}
	load() {
		const value = this.snapshots.get("current");
		if (value === void 0) return Promise.resolve(void 0);
		const parsed = wrapvmInventoryDomainSpec.tables.snapshots.valueSchema.parse(value);
		const environments = {};
		const operations = {};
		for (const [key, record] of Object.entries(parsed.environments)) environments[key] = parseDescriptor(record, key);
		for (const [key, record] of Object.entries(parsed.operations)) operations[key] = parseOperation(record, key);
		return Promise.resolve({
			environments,
			operations
		});
	}
	async save(snapshot) {
		const environments = {};
		const operations = {};
		for (const [key, record] of Object.entries(snapshot.environments)) environments[key] = parseDescriptor(record, key);
		for (const [key, record] of Object.entries(snapshot.operations)) operations[key] = parseOperation(record, key);
		await this.snapshots.put("current", {
			environments,
			operations
		});
	}
};
function parseDescriptor(value, key) {
	try {
		const record = environmentDescriptorSchema.parse(value);
		if (record.id !== key) throw new Error("record id does not match its key");
		return record;
	} catch (error) {
		throw new Error(`wrapvm-isolate: inventory record '${key}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function parseOperation(value, key) {
	try {
		const record = environmentOperationSchema.strict().parse(value);
		if (record.id !== key || record.payload !== void 0 && record.payload.kind !== record.kind || record.target !== void 0 && record.target.environmentId !== record.environmentId) throw new Error("operation identity or payload does not match its record");
		return record;
	} catch (error) {
		throw new Error(`wrapvm-isolate: operation record '${key}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* Durable inventory with serialized mutations and an operation log.
*
* Every mutation goes through one internal write chain (no torn snapshots),
* validates records at the boundary, and keeps operations durable so a crash
* between "requested" and "settled" is visible to reconciliation.
*/
var Inventory = class {
	store;
	snapshot = {
		environments: {},
		operations: {}
	};
	chain = Promise.resolve();
	initialized = false;
	constructor(store) {
		this.store = store;
	}
	/**
	* Load and validate the persisted snapshot. Fail-closed: an invalid record
	* rejects initialization; the manager must not run on a half-read inventory.
	* @returns this inventory, ready for use.
	*/
	async initialize() {
		const snapshot = await this.store.load();
		this.snapshot = {
			environments: {},
			operations: {}
		};
		if (snapshot !== void 0) {
			const environments = {};
			for (const [key, record] of Object.entries(snapshot.environments)) environments[key] = parseDescriptor(record, key);
			const operations = {};
			for (const [key, record] of Object.entries(snapshot.operations)) operations[key] = parseOperation(record, key);
			this.snapshot = {
				environments,
				operations
			};
		}
		this.initialized = true;
		return this;
	}
	/** All inventory descriptors, ordered by creation time. */
	list() {
		this.assertReady();
		return Object.values(this.snapshot.environments).sort((a, b) => a.createdAt - b.createdAt);
	}
	/** Read one descriptor by durable id. */
	get(id) {
		this.assertReady();
		return this.snapshot.environments[id];
	}
	/** Read one descriptor by immutable container id (never by name). */
	getByContainerId(containerId) {
		this.assertReady();
		return Object.values(this.snapshot.environments).find((record) => record.containerId === containerId);
	}
	/** Read one operation by identity. */
	operation(id) {
		this.assertReady();
		return this.snapshot.operations[id];
	}
	/** Operations for one environment, oldest first. */
	operationsFor(environmentId) {
		this.assertReady();
		return Object.values(this.snapshot.operations).filter((record) => record.environmentId === environmentId).sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0));
	}
	/** Find an operation by caller idempotency key (dedup of duplicate requests). */
	findByIdempotencyKey(key) {
		this.assertReady();
		return Object.values(this.snapshot.operations).find((record) => record.idempotencyKey === key);
	}
	/** All durable operation records, including unresolved create intents. */
	allOperations() {
		this.assertReady();
		return Object.values(this.snapshot.operations);
	}
	/** Operations left unsettled by an interruption; reconciliation input. */
	pendingOperations() {
		this.assertReady();
		return Object.values(this.snapshot.operations).filter((record) => record.state === "requested" || record.state === "running");
	}
	/**
	* Operations settled `completed` but whose outcome may not have reached the
	* descriptor table (a legacy split write interrupted in between): the
	* recovery pass re-applies their durable outcome deterministically.
	* @returns completed operations, oldest first.
	*/
	completedOperations() {
		this.assertReady();
		return Object.values(this.snapshot.operations).filter((record) => record.state === "completed").sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0));
	}
	/**
	* Apply one mutation to the snapshot and persist it, serialized behind all
	* earlier mutations. The mutator sees the current snapshot and returns the
	* next one; it must not mutate the input.
	* @param mutate - pure snapshot transition.
	* @returns the snapshot the mutation landed with.
	*/
	async transact(mutate) {
		this.assertReady();
		const run = this.chain.then(async () => {
			this.assertReady();
			const next = mutate(this.snapshot);
			try {
				await this.store.save(next);
			} catch (error) {
				this.initialized = false;
				throw error;
			}
			this.snapshot = next;
			return next;
		});
		this.chain = run.then(() => void 0, () => void 0);
		return run;
	}
	/** Insert or replace one descriptor (validated). */
	async putDescriptor(descriptor) {
		const record = parseDescriptor(descriptor, descriptor.id);
		await this.transact((snapshot) => ({
			...snapshot,
			environments: {
				...snapshot.environments,
				[record.id]: record
			}
		}));
	}
	/** Remove one descriptor (its operation log is pruned by the caller). */
	async deleteDescriptor(id) {
		await this.transact((snapshot) => {
			const environments = {};
			for (const [key, record] of Object.entries(snapshot.environments)) if (key !== id) environments[key] = record;
			return {
				...snapshot,
				environments
			};
		});
	}
	/** Persist one operation record (validated). */
	async putOperation(operation) {
		const record = parseOperation(operation, operation.id);
		await this.transact((snapshot) => ({
			...snapshot,
			operations: {
				...snapshot.operations,
				[record.id]: record
			}
		}));
	}
	/**
	* Commit one settled operation AND its inventory outcome in a single
	* durable transaction. This is the atomic unit crash recovery relies on:
	* an observer either sees the settled record with its outcome applied, or
	* sees neither — never a `completed` create whose descriptor was lost, or
	* a removed environment whose record survived the deletion.
	* @param operation - the settled operation record (validated).
	* @param outcome - descriptor transition the outcome applies, and the
	* environment whose operation log is pruned with the commit (removals).
	*/
	async commitSettlement(operation, outcome = {}) {
		const record = parseOperation(operation, operation.id);
		await this.transact((snapshot) => {
			const applied = outcome.apply === void 0 ? snapshot.environments : outcome.apply(snapshot.environments);
			const environments = {};
			for (const [key, value] of Object.entries(applied)) environments[key] = parseDescriptor(value, key);
			let operations = {
				...snapshot.operations,
				[record.id]: record
			};
			if (outcome.pruneOperationsFor !== void 0) {
				const pruned = {};
				for (const [key, value] of Object.entries(operations)) if (value.environmentId !== outcome.pruneOperationsFor) pruned[key] = value;
				operations = pruned;
			}
			return {
				environments,
				operations
			};
		});
	}
	/** Drop the operation log of a removed environment. */
	async pruneOperations(environmentId) {
		await this.transact((snapshot) => {
			const operations = {};
			for (const [key, record] of Object.entries(snapshot.operations)) if (record.environmentId !== environmentId) operations[key] = record;
			return {
				...snapshot,
				operations
			};
		});
	}
	assertReady() {
		if (!this.initialized) throw new Error("wrapvm-isolate: inventory used before initialize()");
	}
};
//#endregion
//#region lib/types/docker-backend.js
/**
* Docker backend driver.
*
* One environment is one container plus a persistent named volume and a
* per-environment isolated network. The driver speaks the Docker CLI through
* an injected {@link EngineRunner} (production wires `ctx.subprocess.spawn`;
* tests script a fake engine), so no live daemon is required to exercise it.
*
* Guarantees this backend actually enforces, and refuses to claim otherwise:
* - workspace persists in a named volume; host directories attach only as
*   explicitly approved mounts validated by the canonical mount policy, and
*   they are passed with explicit `--mount type=bind` grammar (never the
*   ambiguous `-v host:guest,ro` form, which mounts read-WRITE at a path
*   ending in `,ro`); ambiguous separators and control characters are refused;
* - every published port binds the host loopback interface only;
* - each environment uses a separate bridge network; when an
*   environment declares no Internet access the network is `--internal`, so
*   Docker itself enforces the absence of egress;
* - `--security-opt no-new-privileges`, `--cap-drop ALL` with the minimal
*   add set the desktop image needs, and a pids limit;
* - CPU/RAM map to `--cpus`/`--memory`, with `--memory-swap` pinned to the
*   memory limit on create AND on update (an update that moved memory without
*   swap would silently re-open swap headroom);
* - disk quotas are NOT enforced by overlay2 on macOS/Windows: any attempt to
*   set one fails closed with `disk-quota-unsupported`, never silently ignored.
*
* Capability contract (inspected from the sibling wrap image sources, not
* guessed): the image entrypoint `/opt/wrap/bin/wrap-entrypoint` starts as
* uid 0 and `exec setpriv --reuid --regid --init-groups` down to uid/gid 1000
* — that requires CAP_SETUID/CAP_SETGID, so `--cap-drop ALL` alone would make
* the container fail to start and the add set below is the minimum that keeps
* the image's own startup contract working. Chrome runs with `--no-sandbox`
* per the image's own `/etc/wrap/chrome-flags.conf` (Docker's default seccomp
* refuses the unprivileged namespaces Chrome's sandbox needs), so the SUID
* sandbox helper is not part of the contract. DECLARED DEVIATION: the image
* advertises passwordless `sudo` for in-guest root, and `no-new-privileges`
* makes setuid escalation impossible — guest package installs must run as the
* configured user (the image's mise/npm path); nothing here promises `sudo`
* works, and isolation is never weakened to restore it. Final compatibility
* still requires live acceptance on a real engine.
*
* Ownership is labels plus immutable ids, verified at every decision point:
* - listings used for id matching run `--no-trunc`; the authoritative id is
*   always the inspected `.Id`, never a truncated `docker ps` cell;
* - create adoption inspects the full container (labels, id, image, attached
*   network and volume) and fails closed on foreign, multiple, or conflicting
*   claimants instead of adopting the first row;
* - `already exists` on network/volume create is only tolerated after the
*   existing resource is inspected and its ownership labels confirmed;
* - every mutation re-verifies container (and, for removal, network/volume)
*   ownership and identity immediately before the CLI mutation, so a forged
*   or stale target never deletes or stops a foreign resource;
* - volumes have no immutable id. Identity is the derived name, the ownership
*   labels, the driver, the inspected `CreatedAt`, and a creation-incarnation
*   token label this backend mints at volume create. Removal with an explicit
*   volume choice refuses until that identity was captured (fresh
*   `captureTarget`); a recreated volume is invalidated by token/CreatedAt
*   mismatch. The modeled threat is stale state, crashes, and name collision
*   — a hostile local daemon can lie about any inspection and is out of scope.
* - reconciliation reports unregistered owned containers instead of adopting
*   or deleting them, and never controls a container it cannot match to an
*   inventory record.
*
* Guest-controlled processes cannot establish control-plane isolation: health
* reports unknown until a trusted host-side mechanism can verify it.
* @module
*/
const defaultDockerBackendConfig = {
	binary: "docker",
	guestWorkspace: "/home/user/workspace",
	viewerGuestPort: 6080,
	cdpGuestPort: 9223,
	guestEntrypoint: "/opt/wrap/bin/wrap-entrypoint",
	controlPlaneProbes: ["http://172.17.0.1:8765/", "http://host.docker.internal:8765/"],
	pidsLimit: 512,
	commandTimeoutMs: 12e4
};
/**
* Creation-incarnation token label. Minted per volume create and carried on
* the volume: a recreated volume gets a fresh token, invalidating targets and
* removal previews captured against the old incarnation. Docker volumes have
* no immutable id, so this plus the inspected `CreatedAt` is the identity.
*/
const VOLUME_TOKEN_LABEL = "dsh.wrapvm.volume-token";
/** Reject paths that cannot be represented unambiguously in mount options. */
function hasUnsafePathCharacters(path) {
	return /[\u0000-\u001f\u007f,:"\\]/.test(path);
}
/** Explicit bind-mount argv with validated options. */
function bindMountArgv(src, dst, readOnly) {
	return ["--mount", `type=bind,src=${src},dst=${dst}${readOnly ? ",readonly" : ""}`];
}
function cores(cpuMillis) {
	return (cpuMillis / 1e3).toFixed(3);
}
function volumeNameFor(id) {
	return `dsh-wrapvm-${id}-data`;
}
function networkNameFor(id) {
	return `dsh-wrapvm-${id}`;
}
const dockerInspectSchema = z.object({
	Id: z.string(),
	Image: z.string(),
	State: z.object({ Status: z.string() }),
	Config: z.object({
		Image: z.string(),
		Entrypoint: z.array(z.string()).nullable().optional(),
		Cmd: z.array(z.string()).nullable().optional(),
		Env: z.array(z.string()).nullable().optional(),
		User: z.string().optional(),
		Labels: z.record(z.string(), z.string()).optional()
	}),
	HostConfig: z.object({
		Memory: z.number().optional(),
		NanoCpus: z.number().optional(),
		MemorySwap: z.number().optional(),
		PidsLimit: z.number().nullable().optional(),
		Privileged: z.boolean().optional(),
		CapAdd: z.array(z.string()).nullable().optional(),
		CapDrop: z.array(z.string()).nullable().optional(),
		SecurityOpt: z.array(z.string()).nullable().optional(),
		PidMode: z.string().optional(),
		IpcMode: z.string().optional(),
		UsernsMode: z.string().optional(),
		UTSMode: z.string().optional(),
		CgroupnsMode: z.string().optional(),
		Devices: z.array(z.unknown()).nullable().optional(),
		DeviceRequests: z.array(z.unknown()).nullable().optional(),
		DeviceCgroupRules: z.array(z.string()).nullable().optional(),
		NetworkMode: z.string().optional(),
		PortBindings: z.record(z.string(), z.array(z.object({
			HostIp: z.string(),
			HostPort: z.string()
		})).nullable()).optional()
	}).optional(),
	NetworkSettings: z.object({
		Networks: z.record(z.string(), z.object({ NetworkID: z.string().optional() }).optional()).optional(),
		Ports: z.record(z.string(), z.array(z.object({
			HostIp: z.string(),
			HostPort: z.string()
		})).nullable().optional()).optional()
	}).optional(),
	Mounts: z.array(z.object({
		Type: z.string().optional(),
		Name: z.string().optional(),
		Source: z.string().optional(),
		Destination: z.string().optional(),
		RW: z.boolean().optional()
	}).optional()).optional()
});
const imageInspectSchema = z.object({
	Id: z.string(),
	Config: z.object({
		Entrypoint: z.array(z.string()).nullable(),
		Cmd: z.array(z.string()).nullable(),
		Env: z.array(z.string()).nullable(),
		User: z.string()
	})
});
const dockerPsEntrySchema = z.object({
	ID: z.string(),
	State: z.string(),
	Image: z.string()
});
const networkInspectSchema = z.object({
	Name: z.string(),
	Id: z.string(),
	Internal: z.boolean().optional(),
	Labels: z.record(z.string(), z.string()).optional()
});
const volumeInspectSchema = z.object({
	Name: z.string(),
	Driver: z.string(),
	CreatedAt: z.string().optional(),
	Labels: z.record(z.string(), z.string()).optional()
});
/** Refusal codes surfaced on failed operations (machine-readable). */
const DOCKER_BACKEND_ERROR_CODES = {
	diskQuotaUnsupported: "disk-quota-unsupported",
	mountDenied: "mount-denied",
	privilegedDenied: "privileged-denied",
	portConflict: "port-conflict",
	containerMissing: "container-missing",
	invalidTransition: "invalid-transition",
	engineUnavailable: "engine-unavailable",
	/** Observed labels contradict plugin ownership of the target environment. */
	resourceForeign: "resource-foreign",
	/** Identity conflict: multiple claimants, or a resource replaced since capture. */
	resourceConflict: "resource-conflict",
	/** Ownership could not be confirmed (ambiguous engine answer): fail closed. */
	resourceUnverified: "resource-unverified"
};
/**
* The Docker implementation of {@link EnvironmentBackendDriver}.
*/
var DockerEnvironmentBackend = class {
	runner;
	config;
	mountPolicy;
	inventory;
	now;
	lastReport;
	constructor(runner, config, mountPolicy, inventory, now = () => Date.now()) {
		this.runner = runner;
		this.config = config;
		this.mountPolicy = mountPolicy;
		this.inventory = inventory;
		this.now = now;
	}
	/** Record host paths explicitly selected in a create request. */
	approveMounts(mounts) {
		this.mountPolicy = {
			...this.mountPolicy,
			approvedRoots: [...this.mountPolicy.approvedRoots, ...mounts.map((mount) => mount.hostPath)]
		};
	}
	/** The most recent reconciliation report, if reconcile() has run. */
	get reconciliationReport() {
		return this.lastReport;
	}
	async engineRun(argv, signal) {
		const deadline = AbortSignal.timeout(this.config.commandTimeoutMs);
		const bounded = AbortSignal.any([signal, deadline]);
		bounded.throwIfAborted();
		const result = await this.runner([this.config.binary, ...argv], bounded);
		bounded.throwIfAborted();
		return result;
	}
	/** Fail-closed engine health check used before any mutation batch. */
	async engineAvailable(signal) {
		try {
			return (await this.engineRun([
				"version",
				"--format",
				"{{.Server.Version}}"
			], signal)).exitCode === 0;
		} catch {
			return false;
		}
	}
	async inspectContainer(containerId, signal) {
		const result = await this.engineRun([
			"inspect",
			"--format",
			"{{json .}}",
			containerId
		], signal);
		if (result.exitCode !== 0) {
			if (/No such (container|object)/i.test(result.stderr)) return { kind: "missing" };
			return {
				kind: "unknown",
				reason: `container inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
			};
		}
		try {
			return {
				kind: "found",
				value: dockerInspectSchema.parse(JSON.parse(result.stdout.trim()))
			};
		} catch (error) {
			return {
				kind: "unknown",
				reason: `container inspect output is unparsable: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
	async inspectNetwork(networkName, signal) {
		const result = await this.engineRun([
			"network",
			"inspect",
			"--format",
			"{{json .}}",
			networkName
		], signal);
		if (result.exitCode !== 0) {
			if (/No such network|not found/i.test(result.stderr)) return { kind: "missing" };
			return {
				kind: "unknown",
				reason: `network inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
			};
		}
		try {
			return {
				kind: "found",
				value: networkInspectSchema.parse(JSON.parse(result.stdout.trim()))
			};
		} catch (error) {
			return {
				kind: "unknown",
				reason: `network inspect output is unparsable: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
	async inspectVolume(volumeName, signal) {
		const result = await this.engineRun([
			"volume",
			"inspect",
			"--format",
			"{{json .}}",
			volumeName
		], signal);
		if (result.exitCode !== 0) {
			if (/No such volume/i.test(result.stderr)) return { kind: "missing" };
			return {
				kind: "unknown",
				reason: `volume inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
			};
		}
		try {
			return {
				kind: "found",
				value: volumeInspectSchema.parse(JSON.parse(result.stdout.trim()))
			};
		} catch (error) {
			return {
				kind: "unknown",
				reason: `volume inspect output is unparsable: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
	/** Reason the labels contradict plugin ownership of `id`, or undefined when they confirm it. */
	ownershipMismatch(labels, id) {
		if (labels?.["dsh.wrapvm.environment"] !== "1") return `the ${OWNERSHIP_LABEL}=1 ownership label is absent`;
		const claimed = labels[ENVIRONMENT_ID_LABEL];
		if (claimed !== id) return `the environment id label claims ${claimed ?? "nothing"}, not ${id}`;
	}
	/**
	* Reconcile durable inventory against observed backend state via labels and
	* immutable container ids. Never adopts by name, never touches foreign
	* containers, never deletes anything.
	*/
	async reconcile(signal) {
		const report = await this.reconcileReport(signal);
		this.lastReport = report;
		return report.confirmed;
	}
	/** Full three-way reconciliation split (confirmed / unregistered / missing / conflicts). */
	async reconcileReport(signal) {
		const listed = await this.engineRun([
			"ps",
			"-a",
			"--no-trunc",
			"--filter",
			`label=${OWNERSHIP_LABEL}=1`,
			"--format",
			"{{json .}}"
		], signal);
		if (listed.exitCode !== 0) throw new Error(`wrapvm-isolate: cannot list owned containers: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`);
		const entries = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => dockerPsEntrySchema.parse(JSON.parse(line)));
		const inventoryRecords = this.inventory.list();
		const byEnvId = /* @__PURE__ */ new Map();
		for (const record of inventoryRecords) byEnvId.set(record.id, record);
		const confirmed = [];
		const unregistered = [];
		const conflicts = [];
		const seenContainers = /* @__PURE__ */ new Map();
		for (const entry of entries) {
			const observed = await this.inspectContainer(entry.ID, signal);
			if (observed.kind === "missing") continue;
			if (observed.kind === "unknown") {
				conflicts.push({
					containerId: entry.ID,
					environmentId: "",
					reason: `ownership could not be confirmed: ${observed.reason}`
				});
				continue;
			}
			const containerId = observed.value.Id;
			const labels = observed.value.Config.Labels;
			if (labels?.["dsh.wrapvm.environment"] !== "1") {
				conflicts.push({
					containerId,
					environmentId: "",
					reason: "the ownership label claim is contradicted by the inspected container"
				});
				continue;
			}
			const claimedId = labels[ENVIRONMENT_ID_LABEL];
			if (claimedId === void 0) {
				conflicts.push({
					containerId,
					environmentId: "",
					reason: "owned label without environment id label"
				});
				continue;
			}
			const environmentId = asEnvironmentId(claimedId);
			const record = byEnvId.get(environmentId);
			if (record === void 0) {
				unregistered.push(this.observedDescriptor(environmentId, containerId, observed.value));
				continue;
			}
			if (seenContainers.has(environmentId)) {
				conflicts.push({
					containerId,
					environmentId,
					reason: "a second container claims the same environment id"
				});
				continue;
			}
			seenContainers.set(environmentId, containerId);
			if (record.containerId !== containerId && record.containerId !== "") {
				conflicts.push({
					containerId,
					environmentId,
					reason: `inventory binds container ${record.containerId}, backend shows ${containerId}`
				});
				continue;
			}
			confirmed.push(this.observedDescriptor(environmentId, containerId, observed.value, record));
		}
		return {
			confirmed,
			unregistered,
			missing: inventoryRecords.filter((record) => !seenContainers.has(record.id)).map((record) => record.id),
			conflicts
		};
	}
	observedDescriptor(id, containerId, inspected, base) {
		const networks = Object.keys(inspected.NetworkSettings?.Networks ?? {});
		const ports = this.parsePublishedPorts(inspected);
		return {
			...base ?? {
				id,
				backend: "docker",
				ownership: "plugin",
				image: inspected.Config.Image,
				digest: inspected.Image,
				createdAt: this.now(),
				mounts: [],
				limits: {
					cpuMillis: Math.round((inspected.HostConfig?.NanoCpus ?? 0) / 1e6) || 2e3,
					memoryBytes: inspected.HostConfig?.Memory || 4 * 2 ** 30
				},
				internetAccess: true
			},
			id,
			containerId,
			image: inspected.Config.Image,
			digest: inspected.Image,
			...networks.length > 0 ? { networkName: networks[0] } : {},
			...ports !== void 0 ? { ports } : {}
		};
	}
	matchesPortBindings(bindings, requested, configured) {
		if (bindings === void 0) return false;
		const expected = [[`${this.config.viewerGuestPort}/tcp`, requested?.viewerPort], [`${this.config.cdpGuestPort}/tcp`, requested?.cdpPort]];
		if (Object.entries(bindings).some(([key, value]) => value != null && !expected.some(([port]) => port === key))) return false;
		return expected.every(([key, port]) => {
			const values = bindings[key];
			if (values?.length !== 1 || values[0]?.HostIp !== "127.0.0.1") return false;
			const actual = values[0].HostPort;
			if (port !== void 0) return actual === String(port);
			if (configured) return actual === "" || actual === "0";
			return /^[0-9]+$/.test(actual) && Number(actual) > 0 && Number(actual) <= 65535;
		});
	}
	parsePublishedPorts(inspected) {
		const ports = inspected.NetworkSettings?.Ports;
		if (ports === void 0) return void 0;
		const read = (guestPort) => {
			const binding = ports[`${guestPort}/tcp`]?.[0];
			if (binding === void 0 || binding.HostPort === "") return void 0;
			return Number(binding.HostPort);
		};
		const viewerPort = read(this.config.viewerGuestPort);
		const cdpPort = read(this.config.cdpGuestPort);
		if (viewerPort === void 0 || cdpPort === void 0) return void 0;
		return {
			viewerPort,
			cdpPort
		};
	}
	networkIdOf(inspected, networkName) {
		return inspected.NetworkSettings?.Networks?.[networkName]?.NetworkID;
	}
	/**
	* Acquire a verified target for one environment id: labels plus full
	* immutable ids plus observed network/volume identity, read from the
	* inspected descriptors. Foreign or multiple claimants fail closed.
	*/
	async captureTarget(environmentId, signal) {
		const listing = await this.listOwnedContainerIds(environmentId, signal);
		if (listing.kind === "unknown") return {
			kind: "unknown",
			reason: listing.reason
		};
		if (listing.ids.length > 1) return {
			kind: "conflicting",
			reason: `${listing.ids.length} containers claim environment id ${environmentId}`
		};
		if (listing.ids.length === 0) return { kind: "absent" };
		const listingId = listing.ids[0];
		if (listingId === void 0) return {
			kind: "unknown",
			reason: "container listing was empty"
		};
		const observed = await this.inspectContainer(listingId, signal);
		if (observed.kind === "missing") return {
			kind: "unknown",
			reason: "the listing claimed a container the inspect cannot find"
		};
		if (observed.kind === "unknown") return {
			kind: "unknown",
			reason: observed.reason
		};
		const inspected = observed.value;
		if (inspected.Id !== listingId) return {
			kind: "conflicting",
			reason: `the listing id ${listingId} resolves to inspected id ${inspected.Id}`
		};
		const mismatch = this.ownershipMismatch(inspected.Config.Labels, environmentId);
		if (mismatch !== void 0) return {
			kind: "foreign",
			reason: `container ${inspected.Id}: ${mismatch}`
		};
		const networkName = networkNameFor(environmentId);
		const volumeName = volumeNameFor(environmentId);
		const network = await this.inspectNetwork(networkName, signal);
		if (network.kind !== "found") return {
			kind: "unknown",
			reason: network.kind === "missing" ? `network ${networkName} is missing` : network.reason
		};
		const networkMismatch = this.ownershipMismatch(network.value.Labels, environmentId);
		if (networkMismatch !== void 0) return {
			kind: "foreign",
			reason: `network ${networkName}: ${networkMismatch}`
		};
		const volume = await this.inspectVolume(volumeName, signal);
		if (volume.kind !== "found") return {
			kind: "unknown",
			reason: volume.kind === "missing" ? `volume ${volumeName} is missing` : volume.reason
		};
		const volumeMismatch = this.ownershipMismatch(volume.value.Labels, environmentId);
		if (volumeMismatch !== void 0) return {
			kind: "foreign",
			reason: `volume ${volumeName}: ${volumeMismatch}`
		};
		const running = inspected.State.Status === "running" || inspected.State.Status === "paused";
		const attachedId = this.networkIdOf(inspected, networkName);
		if (!(running ? attachedId === network.value.Id : attachedId ? attachedId === network.value.Id : inspected.HostConfig?.NetworkMode === networkName || Object.hasOwn(inspected.NetworkSettings?.Networks ?? {}, networkName)) || !(inspected.Mounts ?? []).some((m) => m?.Type === "volume" && m.Name === volumeName && m.Destination === this.config.guestWorkspace)) return {
			kind: "conflicting",
			reason: "container network or workspace volume does not match inspected resources"
		};
		let ports;
		if (running) {
			const livePorts = this.parsePublishedPorts(inspected);
			if (livePorts === void 0 || !this.matchesPortBindings(inspected.NetworkSettings?.Ports, livePorts, false)) return {
				kind: "unknown",
				reason: "loopback viewer and CDP ports are unavailable"
			};
			ports = livePorts;
		} else {
			if (!this.matchesPortBindings(inspected.HostConfig?.PortBindings, void 0, true) && !this.matchesPortBindings(inspected.HostConfig?.PortBindings, void 0, false)) return {
				kind: "unknown",
				reason: "configured viewer and CDP ports are not loopback-published"
			};
			ports = {
				viewerPort: 0,
				cdpPort: 0
			};
		}
		return {
			kind: "captured",
			target: this.target(environmentId, inspected.Id, inspected, ports, {
				networkId: network.value.Id,
				volumeDriver: volume.value.Driver,
				...volume.value.CreatedAt !== void 0 ? { volumeCreatedAt: volume.value.CreatedAt } : {},
				...volume.value.Labels?.["dsh.wrapvm.volume-token"] !== void 0 ? { volumeToken: volume.value.Labels[VOLUME_TOKEN_LABEL] } : {}
			})
		};
	}
	/**
	* Re-verify container/network/volume ownership and identity for a captured
	* target. Read-only; every mutation in this backend runs the container
	* verification itself before touching the engine, and removal re-verifies
	* network and volume immediately before their own removals.
	*/
	async verifyTarget(target, signal) {
		return {
			container: await this.verifyContainer(target, signal),
			network: await this.verifyNetwork(target, signal),
			volume: await this.verifyVolume(target, signal)
		};
	}
	/** Container verification paired with the inspected payload (status reads reuse it). */
	async verifiedContainer(target, signal) {
		const observed = await this.inspectContainer(target.containerId, signal);
		if (observed.kind === "missing") return { kind: "missing" };
		if (observed.kind === "unknown") return {
			kind: "refused",
			verification: {
				kind: "unknown",
				reason: observed.reason
			}
		};
		const inspected = observed.value;
		if (inspected.Id !== target.containerId) return {
			kind: "refused",
			verification: {
				kind: "conflicting",
				reason: `container ${target.containerId} resolves to inspected id ${inspected.Id}`
			}
		};
		const mismatch = this.ownershipMismatch(inspected.Config.Labels, target.environmentId);
		if (mismatch !== void 0) return {
			kind: "refused",
			verification: {
				kind: "foreign",
				reason: `container ${target.containerId}: ${mismatch}`
			}
		};
		if (target.imageDigest !== void 0 && inspected.Image !== target.imageDigest) return {
			kind: "refused",
			verification: {
				kind: "conflicting",
				reason: `the container image id changed since capture (now ${inspected.Image})`
			}
		};
		return {
			kind: "owned",
			inspected
		};
	}
	async verifyContainer(target, signal) {
		const result = await this.verifiedContainer(target, signal);
		if (result.kind === "owned") return { kind: "owned" };
		return result.kind === "missing" ? { kind: "missing" } : result.verification;
	}
	async verifyNetwork(target, signal) {
		if (target.networkName !== networkNameFor(target.environmentId)) return {
			kind: "conflicting",
			reason: "network name does not match the environment"
		};
		const observed = await this.inspectNetwork(target.networkName, signal);
		if (observed.kind === "missing") return { kind: "missing" };
		if (observed.kind === "unknown") return {
			kind: "unknown",
			reason: observed.reason
		};
		if (observed.value.Name !== target.networkName) return {
			kind: "conflicting",
			reason: "inspected network name differs from the target"
		};
		if (target.networkId === void 0 || target.networkId === "") return {
			kind: "unknown",
			reason: "network id was not captured"
		};
		const mismatch = this.ownershipMismatch(observed.value.Labels, target.environmentId);
		if (mismatch !== void 0) return {
			kind: "foreign",
			reason: `network ${target.networkName}: ${mismatch}`
		};
		if (observed.value.Id !== target.networkId) return {
			kind: "conflicting",
			reason: `network ${target.networkName} was recreated since capture (id ${observed.value.Id}, captured ${target.networkId})`
		};
		return { kind: "owned" };
	}
	async verifyVolume(target, signal) {
		if (target.volumeName !== volumeNameFor(target.environmentId)) return {
			kind: "conflicting",
			reason: "volume name does not match the environment"
		};
		const observed = await this.inspectVolume(target.volumeName, signal);
		if (observed.kind === "missing") return { kind: "missing" };
		if (observed.kind === "unknown") return {
			kind: "unknown",
			reason: observed.reason
		};
		const volume = observed.value;
		if (volume.Name !== target.volumeName) return {
			kind: "conflicting",
			reason: "inspected volume name differs from the target"
		};
		const mismatch = this.ownershipMismatch(volume.Labels, target.environmentId);
		if (mismatch !== void 0) return {
			kind: "foreign",
			reason: `volume ${target.volumeName}: ${mismatch}`
		};
		if (target.volumeDriver !== void 0 && volume.Driver !== target.volumeDriver) return {
			kind: "conflicting",
			reason: `volume ${target.volumeName} reports driver ${volume.Driver}, captured ${target.volumeDriver}`
		};
		const liveToken = volume.Labels?.[VOLUME_TOKEN_LABEL];
		if (target.volumeToken !== void 0 && liveToken !== target.volumeToken) return {
			kind: "conflicting",
			reason: `volume ${target.volumeName} is a different creation incarnation (token ${liveToken ?? "absent"}, captured ${target.volumeToken})`
		};
		if (target.volumeCreatedAt !== void 0 && volume.CreatedAt === void 0) return {
			kind: "unknown",
			reason: "volume creation timestamp is unavailable"
		};
		if (target.volumeCreatedAt !== void 0 && volume.CreatedAt !== target.volumeCreatedAt) return {
			kind: "conflicting",
			reason: `volume ${target.volumeName} was created ${volume.CreatedAt}, captured ${target.volumeCreatedAt}`
		};
		return { kind: "owned" };
	}
	/**
	* Execute one mutation against the captured target. Validation refusals
	* settle the operation as `failed` with a precise code; they never reach
	* the engine. Cancellation propagates.
	*/
	async run(operation, signal) {
		if (operation.target !== void 0 && operation.target.environmentId !== operation.environmentId) return this.fail(operation, "target belongs to a different environment", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
		switch (operation.kind) {
			case "create": return await this.runCreate(operation, signal);
			case "start": return await this.runState(operation, ["start"], signal);
			case "stop": return await this.runState(operation, ["stop"], signal);
			case "pause": return await this.runPause(operation, signal);
			case "resume": return await this.runResume(operation, signal);
			case "update-limits": return await this.runUpdateLimits(operation, signal);
			case "remove": return await this.runRemove(operation, signal);
			case "bind":
			case "unbind": return {
				...operation,
				state: "completed",
				settledAt: this.now()
			};
			default: {
				const kind = operation.kind;
				return {
					...operation,
					state: "failed",
					error: `unknown operation kind ${kind}`,
					errorCode: "invalid-transition",
					settledAt: this.now()
				};
			}
		}
	}
	fail(operation, error, errorCode) {
		return {
			...operation,
			state: "failed",
			error,
			errorCode,
			settledAt: this.now()
		};
	}
	/** Settle a verification outcome that blocks a mutation. */
	refuseVerification(operation, resource, verification) {
		if (verification.kind === "foreign") return this.fail(operation, `${resource} is not ours: ${verification.reason}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign);
		if (verification.kind === "conflicting") return this.fail(operation, `${resource} contradicts the captured target: ${verification.reason}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict);
		return this.fail(operation, `${resource} ownership could not be confirmed: ${verification.kind === "unknown" ? verification.reason : "unknown"}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
	}
	async listOwnedContainerIds(id, signal) {
		const result = await this.engineRun([
			"ps",
			"-a",
			"--no-trunc",
			"--filter",
			`label=${OWNERSHIP_LABEL}=1`,
			"--filter",
			`label=${ENVIRONMENT_ID_LABEL}=${id}`,
			"--format",
			"{{.ID}}"
		], signal);
		if (result.exitCode !== 0) return {
			kind: "unknown",
			reason: `listing owned containers failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
		};
		return {
			kind: "listed",
			ids: result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
		};
	}
	target(id, containerId, inspected, ports, identity = {}) {
		const networkName = networkNameFor(id);
		return {
			environmentId: id,
			containerId,
			containerName: containerNameFor(id),
			networkName,
			volumeName: volumeNameFor(id),
			ports: ports ?? {
				viewerPort: this.config.viewerGuestPort,
				cdpPort: this.config.cdpGuestPort
			},
			imageDigest: inspected.Image,
			capturedAt: this.now(),
			...identity.networkId !== void 0 ? { networkId: identity.networkId } : {},
			...identity.volumeDriver !== void 0 ? { volumeDriver: identity.volumeDriver } : {},
			...identity.volumeCreatedAt !== void 0 ? { volumeCreatedAt: identity.volumeCreatedAt } : {},
			...identity.volumeToken !== void 0 ? { volumeToken: identity.volumeToken } : {}
		};
	}
	async runCreate(operation, signal) {
		const input = operation.payload?.kind === "create" ? operation.payload.input : void 0;
		if (input === void 0) return this.fail(operation, "create operation without a create payload", "invalid-transition");
		if (input.limits.diskBytes !== void 0) return this.fail(operation, "the Docker backend cannot enforce per-container disk quotas on this host (overlay2); use the reported usage field instead", DOCKER_BACKEND_ERROR_CODES.diskQuotaUnsupported);
		const requested = input.ports;
		if (requested !== void 0 && (requested.viewerPort === requested.cdpPort || requested.viewerPort === 0 || requested.cdpPort === 0)) return this.fail(operation, "requested viewer and CDP host ports must be distinct non-zero ports", DOCKER_BACKEND_ERROR_CODES.portConflict);
		const bindArgs = [];
		const requestedMounts = [];
		for (const mount of input.mounts) {
			if (mount.guestPath === this.config.guestWorkspace) return this.fail(operation, `the mount guest path ${mount.guestPath} would shadow the persistent workspace volume`, DOCKER_BACKEND_ERROR_CODES.mountDenied);
			const decision = evaluateHostMount(mount, this.mountPolicy);
			if (!decision.ok) return this.fail(operation, decision.reason ?? "mount refused", DOCKER_BACKEND_ERROR_CODES.mountDenied);
			const canonical = decision.canonicalPath ?? "";
			if (hasUnsafePathCharacters(canonical) || hasUnsafePathCharacters(mount.guestPath)) return this.fail(operation, "the mount paths contain ambiguous separators or control characters", DOCKER_BACKEND_ERROR_CODES.mountDenied);
			bindArgs.push(...bindMountArgv(canonical, mount.guestPath, mount.access === "read-only"));
			requestedMounts.push({
				source: canonical,
				destination: mount.guestPath,
				writable: mount.access === "read-write"
			});
		}
		const id = operation.environmentId;
		const name = containerNameFor(id);
		const networkName = networkNameFor(id);
		const volumeName = volumeNameFor(id);
		const listing = await this.listOwnedContainerIds(id, signal);
		if (listing.kind === "unknown") return this.fail(operation, `cannot check for an existing container: ${listing.reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
		if (listing.ids.length > 1) return this.fail(operation, `${listing.ids.length} containers claim environment id ${id} (${listing.ids.join(", ")}); refusing to adopt any of them`, DOCKER_BACKEND_ERROR_CODES.resourceConflict);
		if (listing.ids.length === 1) {
			const listingId = listing.ids[0];
			if (listingId === void 0) return this.fail(operation, "container listing was empty", DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
			const observed = await this.inspectContainer(listingId, signal);
			if (observed.kind !== "found") {
				const reason = observed.kind === "missing" ? "the listing claimed a container the inspect cannot find" : observed.reason;
				return this.fail(operation, `existing container cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
			}
			const inspected = observed.value;
			if (inspected.Id !== listingId) return this.fail(operation, `the listing id ${listingId} resolves to inspected id ${inspected.Id}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			const mismatch = this.ownershipMismatch(inspected.Config.Labels, id);
			if (mismatch !== void 0) return this.fail(operation, `the existing container is not ours: ${mismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign);
			if (inspected.Config.Image !== input.image) return this.fail(operation, `the existing container runs image ${inspected.Config.Image}, not the requested ${input.image}; refusing to adopt a different configuration`, DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			const imageResult = await this.engineRun([
				"image",
				"inspect",
				"--format",
				"{{json .}}",
				inspected.Image
			], signal);
			let image;
			try {
				if (imageResult.exitCode !== 0) throw new Error("image inspect failed");
				image = imageInspectSchema.parse(JSON.parse(imageResult.stdout));
			} catch {
				return this.fail(operation, "the container image configuration cannot be verified", DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
			}
			if (image.Id !== inspected.Image || inspected.Config.Entrypoint === void 0 || inspected.Config.Cmd === void 0 || inspected.Config.Env === void 0 || inspected.Config.User === void 0 || inspected.Config.User !== image.Config.User || JSON.stringify(inspected.Config.Env) !== JSON.stringify(image.Config.Env) || JSON.stringify(inspected.Config.Entrypoint) !== JSON.stringify(image.Config.Entrypoint) || JSON.stringify(inspected.Config.Cmd) !== JSON.stringify(image.Config.Cmd)) return this.fail(operation, "existing container user, environment, entrypoint or command differs from its image", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			if (inspected.State.Status !== "running" && inspected.State.Status !== "created") return this.fail(operation, "only running or never-started containers can be adopted", DOCKER_BACKEND_ERROR_CODES.invalidTransition);
			const networkNames = Object.keys(inspected.NetworkSettings?.Networks ?? {});
			if (networkNames.length !== 1 || !networkNames.includes(networkName)) return this.fail(operation, `the existing container is not attached to the environment network ${networkName}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			if (!(inspected.Mounts ?? []).some((mount) => mount?.Type === "volume" && mount.Name === volumeName && mount.Destination === this.config.guestWorkspace && mount.RW === true)) return this.fail(operation, `the existing container does not attach the environment volume ${volumeName}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			if ((inspected.Mounts ?? []).some((mount) => mount === void 0 || mount.Type !== "bind" && !(mount.Type === "volume" && mount.Name === volumeName && mount.Destination === this.config.guestWorkspace)) || (inspected.Mounts ?? []).filter((mount) => mount?.Type === "volume").length !== 1) return this.fail(operation, "existing container has unexpected mounts", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			const actualBinds = (inspected.Mounts ?? []).filter((mount) => mount?.Type === "bind");
			if (actualBinds.length !== requestedMounts.length || requestedMounts.some((expected) => !actualBinds.some((actual) => actual?.Source === expected.source && actual.Destination === expected.destination && actual.RW === expected.writable))) return this.fail(operation, "existing container bind mounts differ from the requested configuration", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			if (inspected.HostConfig?.Memory !== input.limits.memoryBytes || inspected.HostConfig.NanoCpus !== input.limits.cpuMillis * 1e6) return this.fail(operation, "existing container limits differ from the requested configuration", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			const host = inspected.HostConfig;
			const expectedCaps = [
				"CHOWN",
				"FOWNER",
				"SETUID",
				"SETGID",
				"KILL"
			];
			const caps = host.CapAdd?.map((cap) => cap.replace(/^CAP_/, ""));
			if (host.MemorySwap !== input.limits.memoryBytes || host.PidsLimit !== this.config.pidsLimit || host.Privileged !== false || host.CapDrop?.length !== 1 || host.CapDrop[0] !== "ALL" || caps?.length !== expectedCaps.length || expectedCaps.some((cap) => !caps.includes(cap)) || host.SecurityOpt?.length !== 1 || !["no-new-privileges", "no-new-privileges:true"].includes(host.SecurityOpt[0] ?? "") || host.PidMode !== "" || !["", "private"].includes(host.IpcMode ?? "unknown") || host.UsernsMode !== "" || host.UTSMode !== "" || !["", "private"].includes(host.CgroupnsMode ?? "unknown") || host.Devices === void 0 || host.Devices !== null && host.Devices.length !== 0 || host.DeviceRequests === void 0 || host.DeviceRequests !== null && host.DeviceRequests.length !== 0 || host.DeviceCgroupRules === void 0 || host.DeviceCgroupRules !== null && host.DeviceCgroupRules.length !== 0 || host.NetworkMode !== networkName) return this.fail(operation, "existing container security settings differ from the required configuration", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			if (!this.matchesPortBindings(host.PortBindings, requested, true)) return this.fail(operation, "existing container configured port bindings differ from the request", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			const volume = await this.inspectVolume(volumeName, signal);
			if (volume.kind !== "found") {
				const reason = volume.kind === "missing" ? `the claimed container mounts volume ${volumeName} but the inspect cannot find it` : volume.reason;
				return this.fail(operation, `existing volume cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
			}
			const volumeMismatch = this.ownershipMismatch(volume.value.Labels, id);
			if (volumeMismatch !== void 0) return this.fail(operation, `the existing volume is not ours: ${volumeMismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign);
			const network = await this.inspectNetwork(networkName, signal);
			if (network.kind !== "found") {
				const reason = network.kind === "missing" ? `the claimed container is attached to network ${networkName} but the inspect cannot find it` : network.reason;
				return this.fail(operation, `existing network cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
			}
			const networkMismatch = this.ownershipMismatch(network.value.Labels, id);
			if (networkMismatch !== void 0) return this.fail(operation, `the existing network is not ours: ${networkMismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign);
			const attachedNetworkId = this.networkIdOf(inspected, networkName);
			if (inspected.State.Status === "running" && attachedNetworkId !== network.value.Id || inspected.State.Status === "created" && attachedNetworkId !== void 0 && attachedNetworkId !== "" && attachedNetworkId !== network.value.Id || network.value.Internal !== !input.internetAccess) return this.fail(operation, "existing network identity or internet configuration differs from the request", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			let runtime = inspected;
			if (inspected.State.Status === "created") {
				signal.throwIfAborted();
				const start = await this.engineRun(["start", inspected.Id], signal);
				if (start.exitCode !== 0) return this.fail(operation, `start after recovery failed: ${start.stderr.trim()}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
				const started = await this.inspectContainer(inspected.Id, signal);
				if (started.kind !== "found" || started.value.Id !== inspected.Id || started.value.Image !== inspected.Image || this.ownershipMismatch(started.value.Config.Labels, id) !== void 0 || started.value.State.Status !== "running" || this.networkIdOf(started.value, networkName) !== network.value.Id) return this.fail(operation, "recovered container could not be verified after start", DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
				runtime = started.value;
			}
			if (!this.matchesPortBindings(runtime.NetworkSettings?.Ports, requested, false)) return this.fail(operation, "existing container runtime port bindings differ from the request", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			const ports = this.parsePublishedPorts(runtime);
			if (ports === void 0) return this.fail(operation, "published ports could not be resolved", DOCKER_BACKEND_ERROR_CODES.portConflict);
			return {
				...operation,
				state: "completed",
				settledAt: this.now(),
				target: this.target(id, runtime.Id, runtime, ports, {
					networkId: network.value.Id,
					volumeDriver: volume.value.Driver,
					...volume.value.CreatedAt !== void 0 ? { volumeCreatedAt: volume.value.CreatedAt } : {},
					...volume.value.Labels?.["dsh.wrapvm.volume-token"] !== void 0 ? { volumeToken: volume.value.Labels[VOLUME_TOKEN_LABEL] } : {}
				})
			};
		}
		const volumeToken = randomUUID();
		const networkArgv = [
			"network",
			"create",
			"--label",
			`${OWNERSHIP_LABEL}=1`,
			"--label",
			`${ENVIRONMENT_ID_LABEL}=${id}`,
			"--driver",
			"bridge"
		];
		if (!input.internetAccess) networkArgv.push("--internal");
		networkArgv.push(networkName);
		const volumeArgv = [
			"volume",
			"create",
			"--label",
			`${OWNERSHIP_LABEL}=1`,
			"--label",
			`${ENVIRONMENT_ID_LABEL}=${id}`,
			"--label",
			`${VOLUME_TOKEN_LABEL}=${volumeToken}`,
			volumeName
		];
		let networkId;
		const network = await this.engineRun(networkArgv, signal);
		if (network.exitCode === 0) networkId = network.stdout.trim() || void 0;
		else if (/already exists/i.test(network.stderr)) {
			const existing = await this.inspectNetwork(networkName, signal);
			if (existing.kind !== "found") {
				const reason = existing.kind === "missing" ? "the create reported the network exists but the inspect cannot find it" : existing.reason;
				return this.fail(operation, `existing network cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
			}
			const mismatch = this.ownershipMismatch(existing.value.Labels, id);
			if (mismatch !== void 0) return this.fail(operation, `network ${networkName} already exists and is not ours: ${mismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign);
			if (existing.value.Internal !== !input.internetAccess) return this.fail(operation, "existing network internet configuration differs from the request", DOCKER_BACKEND_ERROR_CODES.resourceConflict);
			networkId = existing.value.Id;
		} else return this.fail(operation, `backend setup failed (network create): ${network.stderr.trim() || `exit ${network.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		const volume = await this.engineRun(volumeArgv, signal);
		if (volume.exitCode !== 0 && !/already exists/i.test(volume.stderr)) return this.fail(operation, `backend setup failed (volume create): ${volume.stderr.trim() || `exit ${volume.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		const existingVolume = await this.inspectVolume(volumeName, signal);
		if (existingVolume.kind !== "found") {
			const reason = existingVolume.kind === "missing" ? "the volume create reported success but the inspect cannot find it" : existingVolume.reason;
			return this.fail(operation, `volume identity cannot be established: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
		}
		const volumeMismatch = this.ownershipMismatch(existingVolume.value.Labels, id);
		if (volumeMismatch !== void 0) return this.fail(operation, `volume ${volumeName} exists and is not ours: ${volumeMismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign);
		const liveToken = existingVolume.value.Labels?.[VOLUME_TOKEN_LABEL];
		const volumeIdentity = {
			driver: existingVolume.value.Driver,
			...existingVolume.value.CreatedAt !== void 0 ? { createdAt: existingVolume.value.CreatedAt } : {},
			...liveToken !== void 0 ? { token: liveToken } : {}
		};
		const publish = (hostPort, guestPort) => hostPort === void 0 ? ["-p", "127.0.0.1::" + String(guestPort)] : ["-p", `127.0.0.1:${hostPort}:${guestPort}`];
		const createArgv = [
			"create",
			"--name",
			name,
			"--label",
			`${OWNERSHIP_LABEL}=1`,
			"--label",
			`${ENVIRONMENT_ID_LABEL}=${id}`,
			"--network",
			networkName,
			"--volume",
			`${volumeName}:${this.config.guestWorkspace}`,
			...bindArgs,
			...publish(requested?.viewerPort, this.config.viewerGuestPort),
			...publish(requested?.cdpPort, this.config.cdpGuestPort),
			"--cpus",
			cores(input.limits.cpuMillis),
			"--memory",
			String(input.limits.memoryBytes),
			"--memory-swap",
			String(input.limits.memoryBytes),
			"--pids-limit",
			String(this.config.pidsLimit),
			"--security-opt",
			"no-new-privileges",
			"--cap-drop",
			"ALL",
			"--cap-add",
			"CHOWN",
			"--cap-add",
			"FOWNER",
			"--cap-add",
			"SETUID",
			"--cap-add",
			"SETGID",
			"--cap-add",
			"KILL",
			"--restart",
			"no",
			input.image
		];
		const created = await this.engineRun(createArgv, signal);
		if (created.exitCode !== 0) {
			if (/Conflict. The container name|is already in use/i.test(created.stderr)) return this.fail(operation, `container name ${name} is taken by a container this plugin does not own`, DOCKER_BACKEND_ERROR_CODES.portConflict);
			return this.fail(operation, `create failed: ${created.stderr.trim() || `exit ${created.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		}
		const createdId = created.stdout.trim();
		const createdInspection = await this.inspectContainer(createdId, signal);
		if (createdInspection.kind !== "found" || createdInspection.value.Id !== createdId || this.ownershipMismatch(createdInspection.value.Config.Labels, id) !== void 0) return this.fail(operation, "created container identity and ownership could not be verified before start", DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
		const started = await this.engineRun(["start", createdId], signal);
		if (started.exitCode !== 0) return this.fail(operation, `start after create failed: ${started.stderr.trim() || `exit ${started.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		const observed = await this.inspectContainer(created.stdout.trim(), signal);
		if (observed.kind !== "found") {
			const reason = observed.kind === "missing" ? "created container vanished before inspection" : observed.reason;
			return this.fail(operation, reason, DOCKER_BACKEND_ERROR_CODES.containerMissing);
		}
		const inspected = observed.value;
		const ports = this.parsePublishedPorts(inspected) ?? requested;
		if (ports === void 0) return this.fail(operation, "ephemeral loopback ports could not be resolved after create", DOCKER_BACKEND_ERROR_CODES.portConflict);
		return {
			...operation,
			state: "completed",
			settledAt: this.now(),
			target: this.target(id, inspected.Id, inspected, ports, {
				...networkId !== void 0 ? { networkId } : {},
				volumeDriver: volumeIdentity.driver,
				...volumeIdentity.createdAt !== void 0 ? { volumeCreatedAt: volumeIdentity.createdAt } : {},
				...volumeIdentity.token !== void 0 ? { volumeToken: volumeIdentity.token } : {}
			})
		};
	}
	/**
	* State transitions address the captured FULL container id, but only after
	* the container was re-inspected and confirmed ours: a stale or forged
	* target never stops, starts, pauses, or unpauses a foreign container.
	*/
	async runState(operation, argv, signal) {
		const target = operation.target;
		if (target === void 0) return this.fail(operation, "state operation without a captured target", "invalid-transition");
		const verified = await this.verifiedContainer(target, signal);
		if (verified.kind === "missing") return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing);
		if (verified.kind === "refused") return this.refuseVerification(operation, "the container", verified.verification);
		const status = verified.inspected.State.Status;
		if (operation.kind === "start" && status === "running") return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
		if (operation.kind === "start" && status === "paused") return this.fail(operation, "the environment is paused; use resume, which keeps the paused-session contract", DOCKER_BACKEND_ERROR_CODES.invalidTransition);
		if (operation.kind === "stop" && (status === "exited" || status === "created")) return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
		const result = await this.engineRun([...argv, target.containerId], signal);
		if (result.exitCode !== 0) return this.fail(operation, `${operation.kind} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
	}
	async runPause(operation, signal) {
		const target = operation.target;
		if (target === void 0) return this.fail(operation, "pause operation without a captured target", "invalid-transition");
		const verified = await this.verifiedContainer(target, signal);
		if (verified.kind === "missing") return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing);
		if (verified.kind === "refused") return this.refuseVerification(operation, "the container", verified.verification);
		const status = verified.inspected.State.Status;
		if (status === "paused") return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
		if (status !== "running") return this.fail(operation, `cannot pause an environment in state ${status}`, DOCKER_BACKEND_ERROR_CODES.invalidTransition);
		const result = await this.engineRun(["pause", target.containerId], signal);
		if (result.exitCode !== 0) return this.fail(operation, `pause failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
	}
	async runResume(operation, signal) {
		const target = operation.target;
		if (target === void 0) return this.fail(operation, "resume operation without a captured target", "invalid-transition");
		const verified = await this.verifiedContainer(target, signal);
		if (verified.kind === "missing") return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing);
		if (verified.kind === "refused") return this.refuseVerification(operation, "the container", verified.verification);
		const status = verified.inspected.State.Status;
		if (status === "running") return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
		if (status !== "paused") return this.fail(operation, `cannot resume an environment in state ${status}; start it instead`, DOCKER_BACKEND_ERROR_CODES.invalidTransition);
		const result = await this.engineRun(["unpause", target.containerId], signal);
		if (result.exitCode !== 0) return this.fail(operation, `resume failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
	}
	async runUpdateLimits(operation, signal) {
		const target = operation.target;
		const limits = operation.payload?.kind === "update-limits" ? operation.payload.limits : void 0;
		if (target === void 0 || limits === void 0) return this.fail(operation, "update-limits operation without target or limits payload", "invalid-transition");
		if (limits.diskBytes !== void 0) return this.fail(operation, "the Docker backend cannot enforce per-container disk quotas on this host (overlay2)", DOCKER_BACKEND_ERROR_CODES.diskQuotaUnsupported);
		const verified = await this.verifiedContainer(target, signal);
		if (verified.kind === "missing") return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing);
		if (verified.kind === "refused") return this.refuseVerification(operation, "the container", verified.verification);
		const result = await this.engineRun([
			"update",
			"--cpus",
			cores(limits.cpuMillis),
			"--memory",
			String(limits.memoryBytes),
			"--memory-swap",
			String(limits.memoryBytes),
			target.containerId
		], signal);
		if (result.exitCode !== 0) return this.fail(operation, `update failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
	}
	/**
	* Removal re-verifies every resource immediately before its own mutation.
	* A foreign, replaced, or unverifiable resource is never deleted; host
	* directories are never deleted under any choice. Volume deletion requires
	* the captured creation identity (token or inspected CreatedAt): without it
	* the volume's incarnation cannot be established, so the destructive choice
	* refuses until a fresh {@link captureTarget} verifies it.
	*/
	async runRemove(operation, signal) {
		const target = operation.target;
		const deleteVolumes = operation.payload?.kind === "remove" ? operation.payload.deleteVolumes : void 0;
		if (target === void 0 || deleteVolumes === void 0) return this.fail(operation, "remove requires a captured target and an explicit deleteVolumes choice", "invalid-transition");
		if (deleteVolumes && target.volumeToken === void 0 && target.volumeCreatedAt === void 0) return this.fail(operation, `volume deletion needs the captured creation identity of ${target.volumeName}: re-capture the target from the inspected descriptor before removing volumes`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
		const container = await this.verifyContainer(target, signal);
		if (container.kind === "foreign" || container.kind === "conflicting" || container.kind === "unknown") return this.refuseVerification(operation, "the container", container);
		if (container.kind === "owned") {
			const removed = await this.engineRun([
				"rm",
				"-f",
				target.containerId
			], signal);
			if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) return this.fail(operation, `remove failed: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		}
		const network = await this.verifyNetwork(target, signal);
		if (network.kind === "owned" && target.networkId === void 0) return this.fail(operation, "network deletion requires captured network id", DOCKER_BACKEND_ERROR_CODES.resourceUnverified);
		if (network.kind === "foreign" || network.kind === "conflicting" || network.kind === "unknown") return this.refuseVerification(operation, "the network", network);
		if (network.kind === "owned") {
			const result = await this.engineRun([
				"network",
				"rm",
				target.networkId ?? target.networkName
			], signal);
			if (result.exitCode !== 0 && !/No such network|not found/i.test(result.stderr)) return this.fail(operation, `network removal failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
		}
		if (deleteVolumes) {
			const volume = await this.verifyVolume(target, signal);
			if (volume.kind === "foreign" || volume.kind === "conflicting" || volume.kind === "unknown") return this.refuseVerification(operation, "the volume", volume);
			if (volume.kind === "owned") {
				const result = await this.engineRun([
					"volume",
					"rm",
					target.volumeName
				], signal);
				if (result.exitCode !== 0 && !/No such volume/i.test(result.stderr)) return this.fail(operation, `volume removal failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable);
			}
		}
		return {
			...operation,
			state: "completed",
			settledAt: this.now()
		};
	}
	/**
	* Probe guest services and host control-plane reachability for one target.
	* Every answer is observed or honestly unknown: a probe that could not run
	* never reports availability or isolation.
	*/
	async probe(target, signal) {
		const observedAt = this.now();
		const observed = await this.inspectContainer(target.containerId, signal);
		if (observed.kind === "unknown") {
			const unknown = {
				kind: "unknown",
				reason: observed.reason
			};
			return {
				phase: "error",
				shell: unknown,
				browser: unknown,
				desktop: unknown,
				hostControlPlane: {
					kind: "unknown",
					reason: `the container state could not be observed: ${observed.reason}`
				},
				observedAt,
				target
			};
		}
		const phase = observed.kind === "missing" ? "missing" : this.phaseOf(observed.value.State.Status);
		if (phase !== "running") {
			const unavailable = { kind: "unavailable" };
			const unknown = {
				kind: "unknown",
				reason: `the container is ${phase}, not running`
			};
			return {
				phase,
				shell: phase === "paused" || phase === "stopped" || phase === "missing" ? unavailable : unknown,
				browser: phase === "paused" || phase === "stopped" || phase === "missing" ? unavailable : unknown,
				desktop: phase === "paused" || phase === "stopped" || phase === "missing" ? unavailable : unknown,
				hostControlPlane: {
					kind: "unknown",
					reason: `the container is ${phase}; isolation cannot be observed`
				},
				observedAt,
				target
			};
		}
		return {
			phase,
			shell: await this.probeExec(target, ["true"], signal),
			browser: await this.probeExec(target, [
				"curl",
				"-fsS",
				"--connect-timeout",
				"2",
				"http://127.0.0.1:9222/json/version"
			], signal),
			desktop: await this.probeExec(target, [
				"curl",
				"-fsS",
				"--connect-timeout",
				"2",
				`http://127.0.0.1:${this.config.viewerGuestPort}/`
			], signal),
			hostControlPlane: {
				kind: "unknown",
				reason: "guest-controlled probes cannot verify host control-plane isolation; a trusted host-side check is required"
			},
			observedAt,
			target
		};
	}
	phaseOf(status) {
		switch (status) {
			case "running": return "running";
			case "paused": return "paused";
			case "restarting":
			case "removing":
			case "dead": return "error";
			case void 0: return "missing";
			default: return "stopped";
		}
	}
	/** One guest exec probe: exit 0 available, non-zero unavailable, unable-to-run unknown. */
	async probeExec(target, argv, signal) {
		try {
			const result = await this.engineRun([
				"exec",
				target.containerId,
				this.config.guestEntrypoint,
				...argv
			], signal);
			if (result.exitCode === 0) return { kind: "available" };
			if (result.exitCode === 127) return {
				kind: "unknown",
				reason: "the probe command is not present in the guest image"
			};
			return { kind: "unavailable" };
		} catch (error) {
			return {
				kind: "unknown",
				reason: `guest probe could not run: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}
	/**
	* One bounded `docker stats` batch for the given containers. Rows are only
	* accepted when their (full, `--no-trunc`) id is one of the requested ids.
	* Missing or unparsable values stay null — never zero.
	*/
	async stats(containerIds, signal) {
		const out = /* @__PURE__ */ new Map();
		if (containerIds.length === 0) return out;
		const result = await this.engineRun([
			"stats",
			"--no-stream",
			"--no-trunc",
			"--format",
			"{{json .}}",
			...containerIds
		], signal);
		if (result.exitCode !== 0) return out;
		const requested = new Set(containerIds);
		for (const line of result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) try {
			const row = z.object({
				ID: z.string(),
				MemUsage: z.string(),
				CPUPerc: z.string()
			}).parse(JSON.parse(line));
			if (!requested.has(row.ID)) continue;
			const [used, limit] = row.MemUsage.split("/");
			out.set(row.ID, {
				memoryUsedBytes: parseDockerBytes(used?.trim() ?? ""),
				memoryLimitBytes: parseDockerBytes(limit?.trim() ?? ""),
				cpuPercent: parseDockerPercent(row.CPUPerc)
			});
		} catch {}
		return out;
	}
	/** Writable-layer size of one container, or null when unreported. */
	async writableLayerSize(containerId, signal) {
		const result = await this.engineRun([
			"ps",
			"-a",
			"-s",
			"--no-trunc",
			"--filter",
			`id=${containerId}`,
			"--format",
			"{{.Size}}"
		], signal);
		if (result.exitCode !== 0) return null;
		const size = result.stdout.trim().split(" ")[0];
		return parseDockerBytes(size ?? "");
	}
};
/** Parse a Docker byte expression ("1.234GiB", "12.3MB", "0B") into bytes. */
function parseDockerBytes(text) {
	const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)?$/u.exec(text);
	if (match === null) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;
	const factor = match[2] === void 0 ? 1 : {
		B: 1,
		KiB: 1024,
		MiB: 1024 ** 2,
		GiB: 1024 ** 3,
		TiB: 1024 ** 4,
		kB: 1e3,
		MB: 1e6,
		GB: 1e9,
		TB: 0xe8d4a51000
	}[match[2]];
	if (factor === void 0) return null;
	return Math.round(value * factor);
}
/** Parse a Docker percentage cell ("12.34%") into a number, or null. */
function parseDockerPercent(text) {
	const match = /^([\d.]+)%$/u.exec(text.trim());
	if (match === null) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}
//#endregion
//#region lib/types/binding.js
/**
* Projected binding registry: one active environment per conversation,
* selection history visible to the model, and an active-user index per
* environment.
*
* Rules held here:
* - one environment per conversation at a time; rebinding replaces the active
*   environment and appends to history;
* - binding is refused while the environment has active users from OTHER
*   conversations unless the caller passes `allowShared` (explicit reuse);
* - unbinding never touches the backend; stop/pause/remove are lifecycle
*   operations with their own guards;
* - `restore` replays durable events after a restart; the fold is
*   order-governed and ignores events for unknown shapes fail-closed.
*/
var BindingRegistry = class {
	sink;
	now;
	onChange;
	bindings = /* @__PURE__ */ new Map();
	users = /* @__PURE__ */ new Map();
	chain = Promise.resolve();
	complete = false;
	inFlight = 0;
	revision = 0;
	completenessController = new AbortController();
	constructor(sink, now = () => Date.now(), onChange = () => {}) {
		this.sink = sink;
		this.now = now;
		this.onChange = onChange;
	}
	/** Mark the projection complete only after every authoritative Session was restored. */
	markComplete() {
		if (this.inFlight !== 0) throw new Error("wrapvm-isolate: binding operations must drain before marking complete");
		if (!this.complete) {
			this.completenessController = new AbortController();
			this.revision += 1;
			this.complete = true;
		}
	}
	/** Invalidate the projection when the adapter loses completeness. */
	invalidateCompleteness() {
		this.complete = false;
		this.revision += 1;
		this.completenessController.abort();
	}
	/** Wait for admitted binding writes before restoring the authoritative Sessions. */
	async drained() {
		await this.chain;
	}
	/** Clear the projection before a complete replay after completeness was invalidated. */
	resetForRestore() {
		if (this.complete || this.inFlight !== 0) throw new Error("wrapvm-isolate: invalidate and drain bindings before reset");
		this.bindings.clear();
		this.users.clear();
	}
	/** Whether the adapter has confirmed every Session is represented. */
	isComplete() {
		return this.complete;
	}
	/** Serialize a lifecycle decision with binding writes; invalidation aborts its signal immediately. */
	async withUsage(environmentId, job) {
		return await this.serialize(async () => {
			if (!this.complete) return { kind: "incomplete" };
			return {
				kind: "complete",
				value: await job({
					sessions: this.usersOf(environmentId),
					revision: this.revision,
					signal: this.completenessController.signal
				})
			};
		});
	}
	/** Current version of the complete binding projection. */
	usageRevision() {
		this.requireComplete();
		return this.revision;
	}
	requireComplete() {
		if (!this.complete) throw new Error("wrapvm-isolate: binding index is incomplete; restore every Session before use");
	}
	/** Read the binding for one conversation. */
	binding(sessionKey) {
		this.requireComplete();
		return this.projectBinding(sessionKey);
	}
	projectBinding(sessionKey) {
		const state = this.bindings.get(sessionKey);
		if (state === void 0) return void 0;
		return {
			sessionKey,
			environmentId: state.environmentId,
			generation: state.generation,
			history: [...state.history]
		};
	}
	/** Conversations currently bound to one environment (active users). */
	usersOf(environmentId) {
		this.requireComplete();
		return [...this.users.get(environmentId) ?? []];
	}
	/**
	* Bind one conversation to one environment.
	*
	* The conflict check, the durable emission, and the projection apply run
	* as ONE serialized step: two concurrent binds of different conversations
	* onto the same environment can never both pass the check against the same
	* pre-state (the second sees the first's applied users).
	* @param sessionKey - the conversation.
	* @param environmentId - the environment selected by the user.
	* @param generation - policy generation the binding commits under.
	* @param options - `allowShared` permits explicit reuse of an environment
	* already used by another conversation; the default refuses it.
	* @returns the new binding.
	* @throws when another conversation actively uses the environment.
	*/
	async bind(sessionKey, environmentId, generation, options = {}) {
		return await this.serialize(async () => {
			this.requireComplete();
			const otherUsers = this.usersOf(environmentId).filter((key) => key !== sessionKey);
			if (otherUsers.length > 0 && options.allowShared !== true) throw new Error(`wrapvm-isolate: environment ${environmentId} is already used by ${otherUsers.join(", ")}; sharing must be explicit`);
			const previous = this.bindings.get(sessionKey);
			if (previous !== void 0 && previous.environmentId === environmentId && previous.generation === generation) {
				const current = this.projectBinding(sessionKey);
				if (current === void 0) throw new Error("wrapvm-isolate: binding projection is inconsistent");
				return current;
			}
			const event = {
				type: "wrapvm/environment-bound",
				sessionKey,
				environmentId,
				generation,
				timestamp: this.now(),
				...options.allowShared === true ? { shared: true } : {}
			};
			await this.sink.emit(event);
			this.apply(event);
			this.onChange();
			const applied = this.projectBinding(sessionKey);
			if (applied === void 0) throw new Error("wrapvm-isolate: binding projection is inconsistent");
			return applied;
		});
	}
	/**
	* Unbind one conversation from its environment (explicit user action).
	* Serialized with {@link bind}: an unbind can never interleave between a
	* concurrent bind's check and its apply.
	* @param sessionKey - the conversation.
	* @returns true when a binding existed and was removed.
	*/
	async unbind(sessionKey) {
		return await this.serialize(async () => {
			this.requireComplete();
			const state = this.bindings.get(sessionKey);
			if (state === void 0) return false;
			const event = {
				type: "wrapvm/environment-unbound",
				sessionKey,
				environmentId: state.environmentId,
				timestamp: this.now()
			};
			await this.sink.emit(event);
			this.apply(event);
			this.onChange();
			return true;
		});
	}
	/**
	* Replay durable events after a restart (restore-before-work). Events are
	* applied in order; the last event per conversation wins. Duplicate replays
	* of the same event are idempotent; a bound event that would add a SECOND
	* user to an environment without the explicit `shared` marker fails closed
	* instead of silently growing the user set.
	* @param events - durable binding events in durable order.
	*/
	restore(events) {
		if (this.complete || this.inFlight !== 0) throw new Error("wrapvm-isolate: invalidate and drain bindings before restoring Sessions");
		for (const event of events) this.apply(event);
	}
	apply(event) {
		switch (event.type) {
			case "wrapvm/environment-bound": {
				const previous = this.bindings.get(event.sessionKey);
				const others = [...this.users.get(event.environmentId) ?? []].filter((key) => key !== event.sessionKey);
				if (others.length > 0 && event.shared !== true) throw new Error(`wrapvm-isolate: conflicting binding events: ${event.environmentId} is used by ${others.join(", ")}; '${event.sessionKey}' may only join with an explicit shared event`);
				if (previous !== void 0) this.detach(event.sessionKey, previous.environmentId);
				const history = [...previous?.history ?? []];
				if (history.at(-1) !== event.environmentId) history.push(event.environmentId);
				this.revision += 1;
				this.bindings.set(event.sessionKey, {
					environmentId: event.environmentId,
					generation: event.generation,
					history
				});
				this.attach(event.sessionKey, event.environmentId);
				return;
			}
			case "wrapvm/environment-unbound": {
				const previous = this.bindings.get(event.sessionKey);
				if (previous === void 0 || previous.environmentId !== event.environmentId) return;
				this.revision += 1;
				this.detach(event.sessionKey, event.environmentId);
				this.bindings.delete(event.sessionKey);
				return;
			}
			default: {
				const unknown = event.type;
				throw new Error(`wrapvm-isolate: unknown binding event type '${unknown}'`);
			}
		}
	}
	attach(sessionKey, environmentId) {
		const set = this.users.get(environmentId) ?? /* @__PURE__ */ new Set();
		set.add(sessionKey);
		this.users.set(environmentId, set);
	}
	detach(sessionKey, environmentId) {
		const set = this.users.get(environmentId);
		if (set === void 0) return;
		set.delete(sessionKey);
		if (set.size === 0) this.users.delete(environmentId);
	}
	/** Serialize one binding step (check + durable emit + apply) behind all earlier ones. */
	serialize(job) {
		this.inFlight += 1;
		const wrapped = async () => {
			try {
				return await job();
			} finally {
				this.inFlight -= 1;
			}
		};
		const result = this.chain.then(wrapped, wrapped);
		this.chain = result.then(() => void 0, () => void 0);
		return result;
	}
};
//#endregion
//#region lib/types/lifecycle.js
/**
* Environment lifecycle manager.
*
* The durable multi-environment manager the UI, Remote face, and activation
* controller consume. It composes the inventory, the backend driver, the
* binding registry, and the mount policy behind one serialized mutation
* queue with observable operations.
*
* Invariants enforced here:
* - mutations are serial per environment and operation-admitted targets are
*   captured INSIDE the serialized admission through the driver's verified
*   acquisition API (`captureTarget`): rebinding or re-listing never
*   retargets a call in flight, and no target is ever reconstructed from an
*   inventory record alone;
* - destructive work (removal) re-verifies container/network/volume
*   ownership with `verifyTarget` immediately before dispatch and refuses
*   outright when the driver cannot verify — an unverified destructive call
*   never reaches the engine;
* - duplicate requests deduplicate by idempotency key AND by the persisted
*   canonical request signature: the same semantic request returns the same
*   operation, a DIFFERENT request reusing the key is refused, never silently
*   answered with an unrelated previous success;
* - the shared lease coordinator serializes lifecycle mutation admission with
*   guest executions and requires an explicit user override while busy;
*   unknown backend outcomes block dependent mutations and budget decisions;
* - crash recovery: the settled operation AND its inventory outcome commit in
*   one durable transaction; `initialize()` only inspects the backend and
*   records interrupted intents. Explicit recovery addresses one intent;
*   initialization never starts or removes backend resources;
* - a manual pause is never auto-resumed and a stopped environment never
*   auto-starts: reconciliation only observes, it never contradicts the
*   desired phase;
* - removal previews the inspected effective configuration (captured target
*   plus the full record snapshot), expires, is consumed exactly once, and
*   is atomically revalidated inside admission: a replaced container, a
*   recreated network, or any record change invalidates the token. Host
*   directories are never deleted;
* - creation AND limit updates are checked against the aggregate host budget
*   inside the same serialization, so concurrent requests cannot both pass
*   against the same committed total; a failed driver call leaves the
*   desired state untouched (the outcome commits only with a completed
*   operation), and disk quotas are refused by the backend, not silently
*   dropped.
* @module
*/
/** Process-local lease coordinator shared by manager and guest tool adapter. */
var ExecutionLeaseRegistry = class {
	active = /* @__PURE__ */ new Map();
	chain = Promise.resolve();
	async acquireExecution(environmentId, name) {
		return await this.serialize(() => {
			const token = Symbol(name);
			const entries = this.active.get(environmentId) ?? /* @__PURE__ */ new Map();
			entries.set(token, name);
			this.active.set(environmentId, entries);
			let released = false;
			return Promise.resolve(() => {
				if (released) return;
				released = true;
				entries.delete(token);
				if (entries.size === 0 && this.active.get(environmentId) === entries) this.active.delete(environmentId);
			});
		});
	}
	async withMutation(environmentId, override, job) {
		return await this.serialize(async () => {
			const names = [...this.active.get(environmentId)?.values() ?? []];
			if (names.length > 0 && !override) return {
				kind: "busy",
				names
			};
			return {
				kind: "executed",
				value: await job()
			};
		});
	}
	serialize(job) {
		const result = this.chain.then(job, job);
		this.chain = result.then(() => void 0, () => void 0);
		return result;
	}
};
function isResourceMutation(kind) {
	return kind === "start" || kind === "stop" || kind === "pause" || kind === "resume" || kind === "update-limits" || kind === "remove";
}
function totalCommitted(records) {
	return records.reduce((sum, record) => ({
		cpuMillis: sum.cpuMillis + record.limits.cpuMillis,
		memoryBytes: sum.memoryBytes + record.limits.memoryBytes
	}), {
		cpuMillis: 0,
		memoryBytes: 0
	});
}
/** The preview requires the entire inspected target to match, except capture time. */
function sameApprovedIdentity(approved, live) {
	return canonicalJson({
		...approved,
		capturedAt: 0
	}) === canonicalJson({
		...live,
		capturedAt: 0
	});
}
/**
* The serialized multi-environment manager.
*/
var EnvironmentManager = class {
	ports;
	chain = Promise.resolve();
	initialized = false;
	previews = /* @__PURE__ */ new Map();
	now;
	newId;
	previewTtlMs;
	constructor(ports) {
		this.ports = ports;
		this.now = ports.now ?? (() => Date.now());
		this.newId = ports.newId ?? (() => asEnvironmentId(`env-${randomUUID().slice(0, 13)}`));
		this.previewTtlMs = ports.previewTtlMs ?? 12e4;
	}
	list(signal) {
		signal.throwIfAborted();
		return Promise.resolve(this.ports.inventory.list());
	}
	get(id) {
		return this.ports.inventory.get(id);
	}
	binding(sessionKey) {
		return this.ports.bindings.binding(sessionKey);
	}
	/** Return a durable operation whose backend outcome is still unknown. */
	uncertainty(id) {
		return this.ports.inventory.operationsFor(id).find((operation) => operation.state === "running" && isResourceMutation(operation.kind) || operation.state === "failed" && operation.errorCode === "outcome-unknown");
	}
	/** Read one operation by identity (state observable to the UI). */
	operation(id) {
		return this.ports.inventory.operation(id);
	}
	/** Operations for one environment, oldest first. */
	operationsFor(environmentId) {
		return this.ports.inventory.operationsFor(environmentId);
	}
	/**
	* Crash recovery: reconcile the inventory against the backend and settle
	* operations left unsettled by an interruption. Must run before any new
	* mutation. Never starts, unpauses, or deletes backend resources on its
	* own; interrupted creates require an explicit recovery request.
	* Deletions may be settled only when confirmed by read-only inspection.
	* @param signal - cancellation.
	*/
	async initialize(signal) {
		await this.serialize(async () => {
			this.initialized = false;
			await this.ports.inventory.initialize();
			await this.ports.driver.reconcile(signal);
			const completedOperations = this.ports.inventory.completedOperations();
			for (const completed of [...completedOperations.filter((op) => op.kind !== "remove"), ...completedOperations.filter((op) => op.kind === "remove")]) {
				if (completed.kind === "create" && completedOperations.some((op) => op.kind === "remove" && op.environmentId === completed.environmentId)) continue;
				await this.reconcileCompleted(completed);
			}
			for (const pending of this.ports.inventory.pendingOperations()) {
				if (pending.kind === "create" && pending.payload?.kind === "create") {
					await this.ports.inventory.putOperation({
						...pending,
						state: "failed",
						errorCode: "recovery-required",
						error: "create was interrupted; explicitly recover this intent to continue",
						settledAt: this.now()
					});
					continue;
				}
				if (pending.kind === "create") {
					await this.ports.inventory.putOperation({
						...pending,
						state: "failed",
						error: "interrupted before completion; the create intent was not persisted, so it was not re-executed; any owned container is reported by reconciliation for an explicit decision",
						errorCode: "interrupted",
						settledAt: this.now()
					});
					continue;
				}
				if (pending.kind === "remove" && pending.target !== void 0 && pending.payload?.kind === "remove" && this.ports.driver.verifyTarget !== void 0) {
					const observed = await this.ports.driver.verifyTarget(pending.target, signal);
					if (observed.container.kind === "missing" && observed.network.kind === "missing" && (!pending.payload.deleteVolumes || observed.volume.kind === "missing")) {
						const completed = {
							...pending,
							state: "completed",
							settledAt: this.now()
						};
						await this.ports.inventory.commitSettlement(completed, this.outcomeFor(completed));
						continue;
					}
				}
				const uncertain = pending.state === "running" && isResourceMutation(pending.kind);
				await this.ports.inventory.putOperation({
					...pending,
					state: "failed",
					error: uncertain ? "backend outcome is unknown after interruption; verified reconciliation is required" : "interrupted before backend dispatch",
					errorCode: uncertain ? "outcome-unknown" : "interrupted",
					settledAt: this.now()
				});
			}
			this.initialized = true;
		});
	}
	/**
	* Create a new environment. Validates mounts against the canonical policy
	* and the host budget BEFORE admitting, then runs the backend create.
	* @param input - creation options (explicit mounts, limits, ports).
	* @param options - idempotency key for duplicate-request dedup.
	* @returns the settled create operation (target captured on success).
	*/
	async create(input, options = {}) {
		const id = this.newId();
		const operation = {
			id: randomUUID(),
			environmentId: id,
			kind: "create",
			state: "requested",
			payload: {
				kind: "create",
				input
			},
			requestedAt: this.now(),
			...options.idempotencyKey !== void 0 ? { idempotencyKey: options.idempotencyKey } : {}
		};
		return await this.admit(operation, options, { preCheck: (current) => {
			if (!input.internetAccess) return {
				error: "Desktop access without internet is not supported by this Docker backend. Enable internet access to create an environment.",
				errorCode: "unsupported-network"
			};
			return this.createBudgetRefusal(input, current.id);
		} });
	}
	/** Explicitly retry exactly one durable create intent with its original identity. */
	async recoverCreate(operationId, options = {}) {
		this.requireInitialized();
		const existing = this.ports.inventory.operation(operationId);
		if (existing === void 0 || existing.kind !== "create" || existing.payload?.kind !== "create") throw new Error("wrapvm-isolate: the requested durable create intent is unavailable");
		const input = existing.payload.input;
		return await this.admit(existing, options, {
			recoverOperationId: operationId,
			preCheck: (current) => {
				if (this.ports.inventory.get(current.environmentId) !== void 0) return {
					error: "an inventory descriptor already exists for this create intent",
					errorCode: "resource-conflict"
				};
				return this.createBudgetRefusal(input, current.id);
			}
		});
	}
	createBudgetRefusal(input, excludeOperationId) {
		if (this.hasUnmeasuredCreateIntent()) return {
			error: "an interrupted create has unknown limits; aggregate budget cannot be verified",
			errorCode: "outcome-unknown"
		};
		const committed = this.budgetUsage(excludeOperationId);
		if (committed.cpuMillis + input.limits.cpuMillis > this.ports.budget.totalCpuMillis) return {
			error: "the requested CPU budget exceeds the host budget",
			errorCode: "budget-exceeded"
		};
		if (committed.memoryBytes + input.limits.memoryBytes > this.ports.budget.totalMemoryBytes) return {
			error: "the requested memory budget exceeds the host budget",
			errorCode: "budget-exceeded"
		};
	}
	hasUnmeasuredCreateIntent() {
		const operations = this.ports.inventory.allOperations();
		const removed = new Set(operations.filter((operation) => operation.kind === "remove" && operation.state === "completed").map((operation) => operation.environmentId));
		return operations.some((operation) => operation.kind === "create" && operation.payload?.kind !== "create" && !removed.has(operation.environmentId) && this.ports.inventory.get(operation.environmentId) === void 0);
	}
	/** Count unregistered create intents as reserved until resolved. */
	budgetUsage(excludeOperationId) {
		const records = this.ports.inventory.list();
		const total = totalCommitted(records);
		const counted = new Set(records.map((record) => record.id));
		let { cpuMillis, memoryBytes } = total;
		const operations = this.ports.inventory.allOperations();
		const removed = new Set(operations.filter((operation) => operation.kind === "remove" && operation.state === "completed").map((operation) => operation.environmentId));
		for (const operation of operations) {
			if (operation.id === excludeOperationId || operation.kind !== "create" || operation.payload?.kind !== "create" || counted.has(operation.environmentId) || removed.has(operation.environmentId)) continue;
			counted.add(operation.environmentId);
			cpuMillis += operation.payload.input.limits.cpuMillis;
			memoryBytes += operation.payload.input.limits.memoryBytes;
		}
		return {
			cpuMillis,
			memoryBytes
		};
	}
	/** Start a stopped environment (never resumes a paused one). */
	async start(id, options = {}) {
		return await this.stateOperation(id, "start", options);
	}
	/** Stop the container; the workspace volume and container stay for restart. */
	async stop(id, options = {}) {
		return await this.stateOperation(id, "stop", options);
	}
	/** Freeze the container, keeping its RAM. Never auto-resumed. */
	async pause(id, options = {}) {
		return await this.stateOperation(id, "pause", options);
	}
	/** Unfreeze a paused environment (explicit user or admitted agent action). */
	async resume(id, options = {}) {
		return await this.stateOperation(id, "resume", options);
	}
	/**
	* Update CPU/RAM within the backend's enforced knobs; disk quota refuses.
	* The aggregate budget check runs inside the SAME serialization as creates:
	* concurrent updates cannot both pass against the same committed total, and
	* a failed driver call leaves the persisted limits untouched (the outcome
	* commits only with a completed operation).
	*/
	async updateLimits(id, limits, options = {}) {
		const operation = {
			id: randomUUID(),
			environmentId: id,
			kind: "update-limits",
			state: "requested",
			payload: {
				kind: "update-limits",
				limits
			},
			requestedAt: this.now(),
			...options.idempotencyKey !== void 0 ? { idempotencyKey: options.idempotencyKey } : {}
		};
		return await this.admit(operation, options, {
			preCheck: () => {
				const record = this.ports.inventory.get(id);
				if (record === void 0) return {
					error: `unknown environment ${id}`,
					errorCode: "unknown-environment"
				};
				if (this.hasUnmeasuredCreateIntent()) return {
					error: "an interrupted create has unknown limits; aggregate budget cannot be verified",
					errorCode: "outcome-unknown"
				};
				const committed = this.budgetUsage();
				const othersCpu = committed.cpuMillis - record.limits.cpuMillis;
				const othersMemory = committed.memoryBytes - record.limits.memoryBytes;
				if (othersCpu + limits.cpuMillis > this.ports.budget.totalCpuMillis) return {
					error: `the updated CPU budget exceeds the host budget (${othersCpu + limits.cpuMillis} > ${this.ports.budget.totalCpuMillis} millicores)`,
					errorCode: "budget-exceeded"
				};
				if (othersMemory + limits.memoryBytes > this.ports.budget.totalMemoryBytes) return {
					error: `the updated memory budget exceeds the host budget (${othersMemory + limits.memoryBytes} > ${this.ports.budget.totalMemoryBytes} bytes)`,
					errorCode: "budget-exceeded"
				};
			},
			target: (signal) => this.acquireVerifiedTarget(id, signal)
		});
	}
	/**
	* Preview what removing an environment involves. The target is CAPTURED
	* FROM THE LIVE BACKEND (inspected ids and identity, never reconstructed
	* from the inventory record), and the full record snapshot is stored so
	* any later replacement invalidates the token. The token must be presented
	* to {@link remove}; it is single-use and expires. Host directories are
	* listed as unmounted, never deleted.
	* @param id - the environment.
	* @param deleteVolumes - whether the preview approves deletion of the volume.
	* @returns the preview with its single-use confirmation token.
	* @throws when the backend cannot present a verified owned target.
	*/
	async previewRemoval(id, deleteVolumes = false) {
		this.requireInitialized();
		const result = await this.ports.bindings.withUsage(id, async (usage) => {
			const record = this.requireRecord(id);
			if (this.uncertainty(id) !== void 0) throw new Error(`wrapvm-isolate: environment ${id} has an unknown operation outcome`);
			let captured;
			try {
				captured = await this.acquireVerifiedTarget(id, usage.signal);
			} catch (error) {
				if (usage.signal.aborted) throw new Error("wrapvm-isolate: binding index is incomplete; preview again after restoration");
				throw error;
			}
			if (usage.signal.aborted) throw new Error("wrapvm-isolate: binding index is incomplete; preview again after restoration");
			const target = captured.target;
			if (target === void 0) throw new Error(`wrapvm-isolate: cannot preview removal of ${id}: ${captured.refusal?.error ?? "no verified target"}`);
			const token = randomUUID();
			const capturedAt = this.now();
			this.previews.set(id, {
				environmentId: id,
				token,
				descriptor: record,
				target,
				capturedAt,
				deleteVolumes,
				bindingRevision: usage.revision
			});
			return {
				environmentId: id,
				containerId: target.containerId,
				volumeName: target.volumeName,
				networkName: target.networkName,
				...record.displayName !== void 0 ? { displayName: record.displayName } : {},
				hostMounts: record.mounts.map((mount) => mount.hostPath),
				boundSessions: usage.sessions,
				deleteVolumes,
				confirmToken: token,
				expiresAt: capturedAt + this.previewTtlMs
			};
		});
		if (result.kind === "incomplete") throw new Error("wrapvm-isolate: binding index is incomplete; restore every Session before preview");
		return result.value;
	}
	/**
	* Remove an environment after preview and confirmation. Every check and
	* effect runs inside the serialized admission: the token is matched,
	* expiry-checked, and consumed exactly once; the stored record snapshot is
	* compared atomically against the live record; the live target identity is
	* re-acquired and must match the approved snapshot; container, network,
	* and volume ownership are re-verified with the driver immediately before
	* dispatch. A missing resource is accepted for idempotent cleanup; a
	* foreign, replaced, or unconfirmable resource refuses the removal with no
	* engine call. Host directories are never deleted.
	* @param id - the environment.
	* @param confirmToken - token from {@link previewRemoval} (single use).
	* @param deleteVolumes - explicit choice about the persistent named volume.
	* @param options - mutation options; busy leases refuse unless `userAction`.
	* @returns the settled remove operation.
	*/
	async remove(id, confirmToken, deleteVolumes, options = {}) {
		const operation = {
			id: randomUUID(),
			environmentId: id,
			kind: "remove",
			state: "requested",
			payload: {
				kind: "remove",
				deleteVolumes
			},
			requestedAt: this.now(),
			...options.idempotencyKey !== void 0 ? { idempotencyKey: options.idempotencyKey } : {}
		};
		let approved;
		return await this.admit(operation, options, {
			preCheck: () => {
				const live = this.previews.get(id);
				if (live === void 0 || live.token !== confirmToken) return {
					error: "removal requires a current preview: call previewRemoval and pass its token",
					errorCode: "preview-required"
				};
				if (live.bindingRevision !== this.ports.bindings.usageRevision()) return {
					error: "bindings changed; preview again",
					errorCode: "preview-stale"
				};
				if (live.deleteVolumes !== deleteVolumes) return {
					error: "the volume deletion choice changed; preview again",
					errorCode: "preview-stale"
				};
				if (this.now() - live.capturedAt >= this.previewTtlMs) return {
					error: "the removal preview expired; preview the removal again",
					errorCode: "preview-expired"
				};
				const current = this.ports.inventory.get(id);
				if (current === void 0) return {
					error: `unknown environment ${id}`,
					errorCode: "unknown-environment"
				};
				if (canonicalJson(current) !== canonicalJson(live.descriptor)) return {
					error: "the environment record changed after the preview (replacement or reconfiguration); preview the removal again",
					errorCode: "preview-stale"
				};
				approved = live;
			},
			effects: async (signal) => {
				const live = this.previews.get(id);
				if (live === void 0 || live.token !== confirmToken) return {
					error: "removal requires a current preview: call previewRemoval and pass its token",
					errorCode: "preview-required"
				};
				this.previews.delete(id);
				approved = live;
				const driver = this.ports.driver;
				if (driver.verifyTarget === void 0) return {
					error: "the backend driver cannot re-verify resource ownership before deletion (verifyTarget unavailable); refusing destructive removal",
					errorCode: "verification-unavailable"
				};
				const verification = await driver.verifyTarget(live.target, signal);
				for (const [resource, result] of Object.entries(verification)) {
					const refusal = verificationRefusal(resource, result);
					if (refusal !== void 0) return refusal;
				}
			},
			target: async (signal) => {
				if (approved === void 0) return { refusal: {
					error: "removal requires a current preview",
					errorCode: "preview-required"
				} };
				const captured = await this.acquireVerifiedTarget(id, signal);
				if (captured.refusal?.errorCode === "resource-missing") return { target: approved.target };
				if (captured.refusal !== void 0) return { refusal: captured.refusal };
				if (captured.target === void 0) return { refusal: {
					error: "no verified target for removal",
					errorCode: "resource-unverified"
				} };
				if (!sameApprovedIdentity(approved.target, captured.target)) return { refusal: {
					error: "the backend resources changed after the preview (container, network, or volume was replaced); preview the removal again",
					errorCode: "preview-stale"
				} };
				return { target: approved.target };
			}
		});
	}
	/**
	* Bind a conversation to an environment (explicit selection). The binding
	* event is emitted INSIDE the serialized admission, after the environment
	* is validated and the request deduplicated — never before. Refuses while
	* another conversation actively uses the environment unless shared reuse is
	* explicit. In-flight operations keep their captured target regardless.
	*/
	async bind(sessionKey, environmentId, generation, options = {}) {
		const operation = {
			id: randomUUID(),
			environmentId,
			kind: "bind",
			state: "requested",
			payload: {
				kind: "bind",
				sessionKey,
				generation
			},
			requestedAt: this.now(),
			...options.idempotencyKey !== void 0 ? { idempotencyKey: options.idempotencyKey } : {}
		};
		return await this.admit(operation, options, {
			signature: canonicalJson({
				request: operationRequestSignature(operation),
				allowShared: options.allowShared === true
			}),
			preCheck: () => {
				if (this.ports.inventory.get(environmentId) === void 0) return {
					error: `unknown environment ${environmentId}`,
					errorCode: "unknown-environment"
				};
			},
			effects: async () => {
				try {
					await this.ports.bindings.bind(sessionKey, environmentId, generation, { allowShared: options.allowShared === true });
				} catch (error) {
					return {
						error: error instanceof Error ? error.message : String(error),
						errorCode: "binding-conflict"
					};
				}
			}
		});
	}
	/** Unbind a conversation from its environment (explicit user action). */
	async unbind(sessionKey, options = {}) {
		const previous = options.idempotencyKey === void 0 ? void 0 : this.ports.inventory.findByIdempotencyKey(options.idempotencyKey);
		const binding = this.ports.bindings.binding(sessionKey);
		if (binding === void 0 && previous?.kind === "unbind" && previous.payload?.kind === "unbind" && previous.payload.sessionKey === sessionKey && previous.state === "completed") return previous;
		if (binding === void 0) return {
			id: randomUUID(),
			environmentId: "",
			kind: "unbind",
			state: "failed",
			error: "the conversation has no environment binding",
			errorCode: "not-bound",
			requestedAt: this.now(),
			settledAt: this.now()
		};
		const operation = {
			id: randomUUID(),
			environmentId: binding.environmentId,
			kind: "unbind",
			state: "requested",
			payload: {
				kind: "unbind",
				sessionKey
			},
			requestedAt: this.now(),
			...options.idempotencyKey !== void 0 ? { idempotencyKey: options.idempotencyKey } : {}
		};
		return await this.admit(operation, options, {
			preCheck: () => {
				if (this.ports.bindings.binding(sessionKey)?.environmentId !== binding.environmentId) return {
					error: "the conversation has no environment binding",
					errorCode: "not-bound"
				};
			},
			effects: async () => {
				await this.ports.bindings.unbind(sessionKey);
			}
		});
	}
	/**
	* Import an existing container as an environment after explicit identity
	* verification. The original container, its ports, and its data are
	* preserved: import writes inventory only, it never recreates or restarts.
	* @param id - durable id to assign.
	* @param descriptor - verified inventory record (ownership 'imported').
	*/
	async importEnvironment(id, descriptor) {
		this.requireInitialized();
		if (descriptor.ownership !== "imported") throw new Error("wrapvm-isolate: imported records must carry ownership imported");
		if (this.ports.inventory.get(id) !== void 0) throw new Error(`wrapvm-isolate: environment ${id} already exists`);
		await this.ports.inventory.putDescriptor({
			...descriptor,
			id,
			ownership: "imported"
		});
	}
	requireInitialized() {
		if (!this.initialized) throw new Error("wrapvm-isolate: initialize the manager before mutations");
	}
	requireRecord(id) {
		const record = this.ports.inventory.get(id);
		if (record === void 0) throw new Error(`wrapvm-isolate: unknown environment ${id}`);
		return record;
	}
	/**
	* Acquire the verified mutation target through the driver's acquisition
	* API. There is NO fallback that reconstructs a target from the inventory
	* record: a driver that cannot verify ownership cannot mutate resources.
	* A missing resource refuses normal mutations (idempotent cleanup paths
	* decide separately); foreign/conflicting/unknown always refuse.
	*/
	async acquireVerifiedTarget(id, signal) {
		const driver = this.ports.driver;
		if (driver.captureTarget === void 0) return { refusal: {
			error: "the backend driver cannot verify resource ownership (captureTarget unavailable); refusing to mutate unverified resources",
			errorCode: "verification-unavailable"
		} };
		const acquisition = await driver.captureTarget(id, signal ?? new AbortController().signal);
		switch (acquisition.kind) {
			case "captured": {
				const record = this.ports.inventory.get(id);
				if (record === void 0 || record.containerId !== acquisition.target.containerId) return { refusal: {
					error: "the inspected container differs from the inventory identity",
					errorCode: "resource-conflict"
				} };
				return { target: acquisition.target };
			}
			case "absent": return { refusal: {
				error: `no backend resource claims environment ${id}`,
				errorCode: "resource-missing"
			} };
			case "foreign": return { refusal: {
				error: acquisition.reason,
				errorCode: "resource-foreign"
			} };
			case "conflicting": return { refusal: {
				error: acquisition.reason,
				errorCode: "resource-conflict"
			} };
			case "unknown": return { refusal: {
				error: acquisition.reason,
				errorCode: "resource-unverified"
			} };
		}
	}
	async stateOperation(id, kind, options) {
		const operation = {
			id: randomUUID(),
			environmentId: id,
			kind,
			state: "requested",
			payload: { kind },
			requestedAt: this.now(),
			...options.idempotencyKey !== void 0 ? { idempotencyKey: options.idempotencyKey } : {}
		};
		return await this.admit(operation, options, {
			preCheck: () => {
				if (this.ports.inventory.get(id) === void 0) return {
					error: `unknown environment ${id}`,
					errorCode: "unknown-environment"
				};
			},
			target: (signal) => this.acquireVerifiedTarget(id, signal)
		});
	}
	/** Synthetic failed operation for a refusal (never persisted). */
	refusalOf(operation, refusal) {
		return {
			...operation,
			state: "failed",
			error: refusal.error,
			errorCode: refusal.errorCode,
			settledAt: this.now()
		};
	}
	/**
	* Admit one operation. Inside the serialized queue, in order: cancellation,
	* idempotency dedup WITH canonical-signature comparison, pre-checks,
	* target capture, requested/running journal writes, durable effects, the
	* driver call, and finally one commit of settlement and inventory outcome.
	*/
	async admit(operation, options, checks = {}) {
		return await this.serialize(async () => {
			this.requireInitialized();
			options.signal?.throwIfAborted();
			if ((operation.kind === "bind" || operation.kind === "unbind") && !this.ports.bindings.isComplete()) return this.refusalOf(operation, {
				error: "binding index is incomplete; restore every Session",
				errorCode: "binding-incomplete"
			});
			const signature = checks.signature ?? operationRequestSignature(operation);
			let base = {
				...operation,
				requestSignature: signature
			};
			if (checks.recoverOperationId !== void 0) {
				const current = this.ports.inventory.operation(checks.recoverOperationId);
				if (current === void 0 || current.kind !== "create" || current.payload?.kind !== "create") return this.refusalOf(operation, {
					error: "the requested create intent is unavailable",
					errorCode: "recovery-unavailable"
				});
				if (current.state === "completed") return current;
				if (current.state !== "failed") return this.refusalOf(current, {
					error: "the create intent is not settled",
					errorCode: "recovery-unavailable"
				});
				base = {
					id: current.id,
					environmentId: current.environmentId,
					kind: current.kind,
					state: "requested",
					...current.idempotencyKey !== void 0 ? { idempotencyKey: current.idempotencyKey } : {},
					payload: current.payload,
					...current.target !== void 0 ? { target: current.target } : {},
					...current.requestedAt !== void 0 ? { requestedAt: current.requestedAt } : {},
					requestSignature: operationRequestSignature(current)
				};
			}
			if (checks.recoverOperationId === void 0 && operation.idempotencyKey !== void 0) {
				const existing = this.ports.inventory.findByIdempotencyKey(operation.idempotencyKey);
				if (existing !== void 0) {
					if ((existing.requestSignature ?? operationRequestSignature(existing)) !== signature) return this.refusalOf(operation, {
						error: `the idempotency key '${operation.idempotencyKey}' was already used for a different request (${existing.kind} of ${existing.environmentId}); use a fresh key`,
						errorCode: "idempotency-conflict"
					});
					if (existing.state !== "failed") return existing;
					base = {
						id: existing.id,
						environmentId: existing.environmentId,
						kind: existing.kind,
						state: "requested",
						...existing.idempotencyKey !== void 0 ? { idempotencyKey: existing.idempotencyKey } : {},
						...existing.payload !== void 0 ? { payload: existing.payload } : {},
						...existing.target !== void 0 ? { target: existing.target } : {},
						...existing.requestedAt !== void 0 ? { requestedAt: existing.requestedAt } : {},
						requestSignature: signature
					};
				}
			}
			if (operation.kind !== "create" && operation.kind !== "unbind" && this.uncertainty(base.environmentId) !== void 0) return this.refusalOf(base, {
				error: "a previous backend outcome is unknown; verified reconciliation is required",
				errorCode: "outcome-unknown"
			});
			if ((operation.kind === "create" || operation.kind === "update-limits") && this.ports.inventory.list().some((record) => this.uncertainty(record.id)?.kind === "update-limits")) return this.refusalOf(base, {
				error: "an environment has unknown limits; aggregate budget cannot be verified",
				errorCode: "outcome-unknown"
			});
			const perform = async (bindingSignal) => {
				const signal = bindingSignal === void 0 ? options.signal ?? new AbortController().signal : options.signal === void 0 ? bindingSignal : AbortSignal.any([options.signal, bindingSignal]);
				const incomplete = () => bindingSignal?.aborted === true ? {
					error: "binding index became incomplete; restore every Session",
					errorCode: "binding-incomplete"
				} : void 0;
				const early = incomplete();
				if (early !== void 0) return this.refusalOf(base, early);
				const refusal = checks.preCheck?.(base);
				if (refusal !== void 0) return this.refusalOf(base, refusal);
				let admitted = base;
				if (checks.target !== void 0) {
					let captured;
					try {
						captured = await checks.target(signal);
					} catch (error) {
						const revoked = incomplete();
						if (revoked !== void 0) return this.refusalOf(base, revoked);
						throw error;
					}
					const revoked = incomplete();
					if (revoked !== void 0) return this.refusalOf(base, revoked);
					if (captured.refusal !== void 0) return this.refusalOf(base, captured.refusal);
					if (captured.target === void 0) return this.refusalOf(base, {
						error: "verified target missing",
						errorCode: "resource-unverified"
					});
					admitted = {
						...base,
						target: captured.target
					};
				}
				await this.ports.inventory.putOperation(admitted);
				const running = {
					...admitted,
					state: "running"
				};
				await this.ports.inventory.putOperation(running);
				const afterJournal = incomplete();
				if (afterJournal !== void 0) {
					const refused = {
						...running,
						state: "failed",
						...afterJournal,
						settledAt: this.now()
					};
					await this.ports.inventory.commitSettlement(refused);
					return refused;
				}
				signal.throwIfAborted();
				if (checks.effects !== void 0) {
					let effectRefusal;
					try {
						effectRefusal = await checks.effects(signal) ?? incomplete();
					} catch (error) {
						effectRefusal = incomplete();
						if (effectRefusal === void 0) throw error;
					}
					if (effectRefusal !== void 0) {
						const refused = {
							...running,
							state: "failed",
							...effectRefusal,
							settledAt: this.now()
						};
						await this.ports.inventory.commitSettlement(refused);
						return refused;
					}
				}
				if (running.kind === "bind" || running.kind === "unbind") {
					const completed = {
						...running,
						state: "completed",
						settledAt: this.now()
					};
					await this.ports.inventory.commitSettlement(completed);
					return completed;
				}
				let settled;
				let dispatched = false;
				try {
					if (running.target !== void 0) if (this.ports.driver.verifyTarget === void 0) settled = {
						...running,
						state: "failed",
						error: "backend cannot verify the target",
						errorCode: "verification-unavailable",
						settledAt: this.now()
					};
					else {
						const result = await this.ports.driver.verifyTarget(running.target, signal);
						const refusal = Object.entries(result).map(([resource, value]) => value.kind === "missing" && running.kind !== "remove" ? {
							error: `${resource} is missing`,
							errorCode: "resource-missing"
						} : verificationRefusal(resource, value)).find((value) => value !== void 0);
						if (refusal === void 0 && incomplete() === void 0) {
							dispatched = true;
							settled = await this.ports.driver.run(running, signal);
						} else settled = {
							...running,
							state: "failed",
							...refusal ?? incomplete(),
							settledAt: this.now()
						};
					}
					else {
						dispatched = true;
						settled = await this.ports.driver.run(running, signal);
					}
				} catch (error) {
					if (options.signal?.aborted === true) throw error;
					const revoked = incomplete();
					settled = {
						...running,
						state: "failed",
						error: revoked?.error ?? (error instanceof Error ? error.message : String(error)),
						errorCode: revoked?.errorCode ?? "engine-error",
						settledAt: this.now()
					};
				}
				if (dispatched && (settled.state === "failed" || incomplete() !== void 0) && isResourceMutation(settled.kind)) settled = {
					...settled,
					state: "failed",
					errorCode: "outcome-unknown",
					error: `${settled.error ?? "backend operation failed"}; verified reconciliation is required`
				};
				if (settled.kind === "create" && settled.state === "completed" && settled.target === void 0) settled = {
					...running,
					state: "failed",
					error: "create completed without an inspected target",
					errorCode: "resource-unverified",
					settledAt: this.now()
				};
				await this.ports.inventory.commitSettlement(settled, this.outcomeFor(settled));
				return settled;
			};
			if (checks.target === void 0) return await perform();
			const ledger = this.ports.executions;
			if (ledger === void 0) return this.refusalOf(base, {
				error: "execution lease coordinator is unavailable",
				errorCode: "lease-unavailable"
			});
			const result = await ledger.withMutation(base.environmentId, options.userAction === true, async () => {
				if (![
					"stop",
					"pause",
					"remove",
					"update-limits"
				].includes(base.kind)) return await perform();
				const usage = await this.ports.bindings.withUsage(base.environmentId, async (current) => {
					if (base.kind === "remove" && current.sessions.length > 0) return this.refusalOf(base, {
						error: `environment is selected by ${current.sessions.join(", ")}; unselect it before removal`,
						errorCode: "binding-in-use"
					});
					return await perform(current.signal);
				});
				return usage.kind === "complete" ? usage.value : this.refusalOf(base, {
					error: "binding index is incomplete; restore every Session before this operation",
					errorCode: "binding-incomplete"
				});
			});
			return result.kind === "executed" ? result.value : this.refusalOf(base, {
				error: `the environment has active executions (${result.names.join(", ")}); explicit user override is required`,
				errorCode: "busy"
			});
		});
	}
	/**
	* Pure descriptor transition a completed operation's outcome applies. The
	* manager folds it into the SAME durable transaction that writes the
	* settled record, so the journal and the inventory never disagree.
	*/
	outcomeFor(operation) {
		if (operation.state !== "completed") return {};
		const id = operation.environmentId;
		switch (operation.kind) {
			case "create": {
				const input = operation.payload?.kind === "create" ? operation.payload.input : void 0;
				const target = operation.target;
				if (input === void 0 || target === void 0) return {};
				return { apply: (environments) => ({
					...environments,
					[id]: {
						id,
						backend: "docker",
						containerId: target.containerId,
						ownership: "plugin",
						image: input.image,
						digest: target.imageDigest ?? "unobserved",
						createdAt: operation.requestedAt ?? this.now(),
						mounts: input.mounts,
						limits: input.limits,
						internetAccess: input.internetAccess,
						displayName: input.displayName,
						volumeName: target.volumeName,
						networkName: target.networkName,
						ports: target.ports,
						desiredPhase: "running"
					}
				}) };
			}
			case "start":
			case "resume":
			case "stop":
			case "pause": {
				const desiredPhase = operation.kind === "stop" ? "stopped" : operation.kind === "pause" ? "paused" : "running";
				return { apply: (environments) => {
					const record = environments[id];
					if (record === void 0) return environments;
					return {
						...environments,
						[id]: {
							...record,
							desiredPhase
						}
					};
				} };
			}
			case "update-limits": {
				const limits = operation.payload?.kind === "update-limits" ? operation.payload.limits : void 0;
				if (limits === void 0) return {};
				return { apply: (environments) => {
					const record = environments[id];
					if (record === void 0) return environments;
					return {
						...environments,
						[id]: {
							...record,
							limits
						}
					};
				} };
			}
			case "remove": return { apply: (environments) => {
				const kept = {};
				for (const [key, record] of Object.entries(environments)) if (key !== id) kept[key] = record;
				return kept;
			} };
			default: return {};
		}
	}
	/**
	* Recover a completed legacy operation whose descriptor transition was lost.
	* Create intents are verified or re-executed through the backend first.
	*/
	async reconcileCompleted(operation) {
		const { inventory } = this.ports;
		const record = inventory.get(operation.environmentId);
		switch (operation.kind) {
			case "create":
				if (record === void 0 && operation.payload?.kind === "create") await inventory.putOperation({
					...operation,
					state: "failed",
					errorCode: "recovery-required",
					error: "create outcome was not committed; explicitly recover this intent",
					settledAt: this.now()
				});
				return;
			case "remove":
				if (record !== void 0) await inventory.commitSettlement(operation, this.outcomeFor(operation));
				return;
			default: return;
		}
	}
	/** Serialize one job behind every earlier admitted mutation. */
	serialize(job) {
		const result = this.chain.then(job, job);
		this.chain = result.then(() => void 0, () => void 0);
		return result;
	}
};
/** Map one per-resource verification to an admission refusal (missing is tolerated). */
function verificationRefusal(resource, result) {
	switch (result.kind) {
		case "owned":
		case "missing": return;
		case "foreign": return {
			error: `the ${resource} is not owned by this plugin: ${result.reason}`,
			errorCode: "resource-foreign"
		};
		case "conflicting": return {
			error: `the ${resource} no longer matches the approved target: ${result.reason}`,
			errorCode: "resource-conflict"
		};
		case "unknown": return {
			error: `the ${resource} ownership could not be confirmed: ${result.reason}`,
			errorCode: "resource-unverified"
		};
	}
}
//#endregion
//#region lib/types/telemetry.js
/**
* Shared resource sampler.
*
* One sampler serves every view (settings panel, environments page, right
* sidebar): subscribers share a single cadence, no component polls on its
* own, and the sampler stops entirely while nobody is subscribed.
*
* Honesty rules: a failed measurement produces null fields with a fresh
* `takenAt`, never zeros; a sample older than the staleness bound is handed
* to new subscribers flagged `stale`; and unknown stays unknown.
*
* The measurement source is injected ({@link StatsSource}); production wires
* it to `DockerEnvironmentBackend.stats` plus writable-layer sizes, tests
* script it. Cancellation and disposal stop the timer and drop subscriptions.
* @module
*/
const defaultDelay = async (ms, signal) => {
	const { setTimeout: timer } = await import("node:timers/promises");
	await timer(ms, void 0, { signal });
};
/**
* The single shared {@link TelemetrySampler} implementation.
*/
var ResourceSampler = class {
	source;
	options;
	subscriptions = /* @__PURE__ */ new Map();
	samples = /* @__PURE__ */ new Map();
	nextToken = 1;
	running = false;
	lastPoll = Promise.resolve();
	pollCount = 0;
	controller;
	disposed = false;
	now;
	delay;
	constructor(source, options) {
		this.source = source;
		this.options = options;
		if (!Number.isFinite(options.cadenceMs) || options.cadenceMs < 1) throw new Error("wrapvm-isolate: sampler cadenceMs must be positive");
		if (!Number.isFinite(options.stalenessMs) || options.stalenessMs < options.cadenceMs) throw new Error("wrapvm-isolate: sampler stalenessMs must be at least the cadence");
		this.now = options.now ?? (() => Date.now());
		this.delay = options.delay ?? defaultDelay;
	}
	/** Number of live subscriptions (views currently interested). */
	get subscriberCount() {
		return this.subscriptions.size;
	}
	/** Number of measurement batches taken so far (tests, diagnostics). */
	get polls() {
		return this.pollCount;
	}
	/**
	* Subscribe to samples for one environment. The cadence starts on the
	* first subscriber and stops when the last one leaves. A fresh cached
	* sample is delivered immediately when one exists.
	*/
	subscribe(environmentId, listener) {
		if (this.disposed) throw new Error("wrapvm-isolate: sampler is disposed");
		const token = this.nextToken++;
		this.subscriptions.set(token, {
			environmentId,
			listener
		});
		const cached = this.samples.get(environmentId);
		if (cached !== void 0) listener(this.now() - cached.takenAt > this.options.stalenessMs ? {
			...cached,
			stale: true
		} : cached);
		this.ensureRunning();
		return () => {
			this.subscriptions.delete(token);
			if (this.subscriptions.size === 0) this.stop();
		};
	}
	/** Latest cached sample, flagged stale when it exceeds the staleness bound. */
	latest(environmentId) {
		const cached = this.samples.get(environmentId);
		if (cached === void 0) return void 0;
		return this.now() - cached.takenAt > this.options.stalenessMs ? {
			...cached,
			stale: true
		} : cached;
	}
	/** Stop polling and drop every subscription (idempotent). */
	dispose() {
		this.disposed = true;
		this.stop();
		this.subscriptions.clear();
		this.samples.clear();
	}
	/** Wait until the currently running batch settles (tests, shutdown). */
	async drained() {
		await this.lastPoll;
	}
	ensureRunning() {
		if (this.running || this.disposed || this.subscriptions.size === 0) return;
		this.running = true;
		this.controller = new AbortController();
		const signal = this.controller.signal;
		const loop = async () => {
			while (!signal.aborted && this.subscriptions.size > 0) {
				this.lastPoll = this.poll(signal);
				await this.lastPoll;
				if (signal.aborted || this.subscriptions.size === 0) break;
				try {
					await this.delay(this.options.cadenceMs, signal);
				} catch {
					break;
				}
			}
			this.running = false;
		};
		loop();
	}
	stop() {
		this.controller?.abort();
		this.controller = void 0;
	}
	/** One bounded batch: a single source call for all subscribed environments. */
	async poll(signal) {
		this.pollCount += 1;
		const ids = [...new Set([...this.subscriptions.values()].map((sub) => sub.environmentId))];
		const takenAt = this.now();
		let measurements = /* @__PURE__ */ new Map();
		let failure;
		try {
			measurements = await this.source.measure(ids, signal);
		} catch (error) {
			if (signal.aborted) return;
			failure = error instanceof Error ? error.message : String(error);
		}
		for (const id of ids) {
			const measurement = measurements.get(id);
			const sample = {
				takenAt,
				memoryUsedBytes: measurement?.memoryUsedBytes ?? null,
				memoryLimitBytes: measurement?.memoryLimitBytes ?? null,
				cpuPercent: measurement?.cpuPercent ?? null,
				writableLayerBytes: measurement?.writableLayerBytes ?? null,
				volumeUsedBytes: measurement?.volumeUsedBytes ?? null,
				...failure !== void 0 ? { stale: true } : {}
			};
			this.samples.set(id, sample);
			for (const sub of this.subscriptions.values()) if (sub.environmentId === id) sub.listener(sample);
		}
	}
};
/**
* Adapter turning a Docker stats face into a {@link StatsSource}: one batched
* `docker stats` call plus one writable-layer size lookup per container, all
* bounded by the caller's signal. Volume usage is not observable through
* `docker stats`, so it stays null (reported as unknown, never zero).
*/
function createDockerStatsSource(stats, writableLayerSize, resolveContainerId) {
	return { async measure(environmentIds, signal) {
		const byContainer = /* @__PURE__ */ new Map();
		for (const id of environmentIds) {
			const containerId = resolveContainerId(id);
			if (containerId !== void 0) byContainer.set(containerId, id);
		}
		const out = /* @__PURE__ */ new Map();
		if (byContainer.size === 0) return out;
		const statsRows = await stats([...byContainer.keys()], signal);
		for (const [containerId, environmentId] of byContainer) {
			const row = statsRows.get(containerId);
			let writableLayerBytes = null;
			try {
				writableLayerBytes = await writableLayerSize(containerId, signal);
			} catch {
				if (signal.aborted) throw signal.reason ?? /* @__PURE__ */ new Error("aborted");
			}
			out.set(environmentId, {
				memoryUsedBytes: row?.memoryUsedBytes ?? null,
				memoryLimitBytes: row?.memoryLimitBytes ?? null,
				cpuPercent: row?.cpuPercent ?? null,
				writableLayerBytes,
				volumeUsedBytes: null
			});
		}
		return out;
	} };
}
//#endregion
//#region lib/types/index.js
/**
* @deepseek-ai/dsh-wrapvm-isolate — isolated wrapvm desktop VM for DeepSeek Harness.
*
* Host half: container lifecycle (start/stop/status/exec/innerUrl) and agent
* tools (vm_shell, vm_browser, vm_desktop, vm_status) driven through the docker
* CLI via `ctx.subprocess.spawn`, plus the Remote face the settings panel calls.
*
* The VM image is `ghcr.io/tobi/wrapvm:desktop` (wrap's desktop image: Xvfb +
* XFCE, one persistent Chrome with CDP forwarded to all guest interfaces at
* 9223, voxl viewer on 6080, agent-browser and agent-desktop preinstalled).
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Workspace mount path inside the VM, matching wrapvm's Smolfile layout. */
const VM_WORKSPACE = "/home/user/workspace";
/** Image helper that selects its configured desktop user and home. */
const GUEST_ENTRYPOINT = "/opt/wrap/bin/wrap-entrypoint";
/** Default command timeout for shell and CLI tools, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 12e4;
/** Status output schema for `vm_status`. */
const STATUS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		containerName: {
			type: "string",
			required: true
		},
		image: {
			type: "string",
			required: true
		},
		state: {
			type: "string",
			required: true
		},
		running: {
			type: "boolean",
			required: true
		},
		viewerPort: {
			type: "number",
			required: true
		},
		cdpPort: {
			type: "number",
			required: true
		},
		next: { type: "string" },
		workspaceDir: { oneOf: [{ type: "string" }, { type: "null" }] }
	}
};
/** ExecResult output schema shared by vm_shell and vm_desktop. */
const EXEC_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		output: {
			type: "string",
			required: true
		},
		stderr: {
			type: "string",
			required: true
		},
		exitCode: {
			type: "number",
			required: true
		}
	}
};
function resolveTimeout(timeoutMs) {
	const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error("wrapvm-isolate: invalid timeoutMs");
	return value;
}
/** Send one CDP command, rejecting protocol errors, disconnects, cancellation, and timeouts. */
async function cdpRequest(url, method, params, timeoutMs, signal) {
	signal?.throwIfAborted();
	return await new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		let settled = false;
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.close();
			if (error) reject(error);
			else resolve(result ?? {});
		};
		const timer = setTimeout(() => finish(/* @__PURE__ */ new Error(`wrapvm-isolate: ${method} timed out; inspect the browser before retrying`)), timeoutMs);
		const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("wrapvm-isolate: browser request cancelled"));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		socket.addEventListener("open", () => {
			if (!settled) socket.send(JSON.stringify({
				id: 1,
				method,
				params
			}));
		});
		socket.addEventListener("error", () => finish(/* @__PURE__ */ new Error("wrapvm-isolate: Chrome connection failed")));
		socket.addEventListener("close", () => finish(/* @__PURE__ */ new Error("wrapvm-isolate: Chrome disconnected before replying")));
		socket.addEventListener("message", (event) => {
			try {
				if (typeof event.data !== "string") throw new Error("wrapvm-isolate: invalid CDP response");
				const message = z.object({
					id: z.number().optional(),
					error: z.unknown().optional(),
					result: z.record(z.string(), z.unknown()).optional()
				}).parse(JSON.parse(event.data));
				if (message.id !== 1) return;
				if (message.error) throw new Error(`wrapvm-isolate: CDP command failed: ${JSON.stringify(message.error)}`);
				if (!message.result || typeof message.result !== "object") throw new Error("wrapvm-isolate: missing CDP result");
				finish(void 0, message.result);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
/** One bounded subprocess run through the configured container backend. */
let WrapvmIsolateService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _v02Snapshot_decorators;
	let _v02Create_decorators;
	let _v02Start_decorators;
	let _v02Stop_decorators;
	let _v02Pause_decorators;
	let _v02Resume_decorators;
	let _v02UpdateLimits_decorators;
	let _v02PreviewRemoval_decorators;
	let _v02ConfirmRemoval_decorators;
	let _v02Bind_decorators;
	let _v02Unbind_decorators;
	let _v02WatchSession_decorators;
	let _v02ViewerUrl_decorators;
	let _v02WatchResources_decorators;
	return class WrapvmIsolateService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_v02Snapshot_decorators = [Remote];
			_v02Create_decorators = [Remote];
			_v02Start_decorators = [Remote];
			_v02Stop_decorators = [Remote];
			_v02Pause_decorators = [Remote];
			_v02Resume_decorators = [Remote];
			_v02UpdateLimits_decorators = [Remote];
			_v02PreviewRemoval_decorators = [Remote];
			_v02ConfirmRemoval_decorators = [Remote];
			_v02Bind_decorators = [Remote];
			_v02Unbind_decorators = [Remote];
			_v02WatchSession_decorators = [Remote({ mode: "stream" })];
			_v02ViewerUrl_decorators = [Remote];
			_v02WatchResources_decorators = [Remote({ mode: "stream" })];
			__esDecorate(this, null, _v02Snapshot_decorators, {
				kind: "method",
				name: "v02Snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Snapshot" in obj,
					get: (obj) => obj.v02Snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Create_decorators, {
				kind: "method",
				name: "v02Create",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Create" in obj,
					get: (obj) => obj.v02Create
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Start_decorators, {
				kind: "method",
				name: "v02Start",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Start" in obj,
					get: (obj) => obj.v02Start
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Stop_decorators, {
				kind: "method",
				name: "v02Stop",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Stop" in obj,
					get: (obj) => obj.v02Stop
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Pause_decorators, {
				kind: "method",
				name: "v02Pause",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Pause" in obj,
					get: (obj) => obj.v02Pause
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Resume_decorators, {
				kind: "method",
				name: "v02Resume",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Resume" in obj,
					get: (obj) => obj.v02Resume
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02UpdateLimits_decorators, {
				kind: "method",
				name: "v02UpdateLimits",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02UpdateLimits" in obj,
					get: (obj) => obj.v02UpdateLimits
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02PreviewRemoval_decorators, {
				kind: "method",
				name: "v02PreviewRemoval",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02PreviewRemoval" in obj,
					get: (obj) => obj.v02PreviewRemoval
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02ConfirmRemoval_decorators, {
				kind: "method",
				name: "v02ConfirmRemoval",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02ConfirmRemoval" in obj,
					get: (obj) => obj.v02ConfirmRemoval
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Bind_decorators, {
				kind: "method",
				name: "v02Bind",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Bind" in obj,
					get: (obj) => obj.v02Bind
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02Unbind_decorators, {
				kind: "method",
				name: "v02Unbind",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02Unbind" in obj,
					get: (obj) => obj.v02Unbind
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02WatchSession_decorators, {
				kind: "method",
				name: "v02WatchSession",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02WatchSession" in obj,
					get: (obj) => obj.v02WatchSession
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02ViewerUrl_decorators, {
				kind: "method",
				name: "v02ViewerUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02ViewerUrl" in obj,
					get: (obj) => obj.v02ViewerUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _v02WatchResources_decorators, {
				kind: "method",
				name: "v02WatchResources",
				static: false,
				private: false,
				access: {
					has: (obj) => "v02WatchResources" in obj,
					get: (obj) => obj.v02WatchResources
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		config = __runInitializers(this, _instanceExtraInitializers);
		static inject = ["subprocess", "tools"];
		static Config = z$1.object({
			backend: z$1.string().default("docker"),
			agentImage: z$1.string().default("wrapvm-dsh:desktop"),
			agentCpuMillis: z$1.number().default(2e3),
			agentMemoryBytes: z$1.number().default(2147483648),
			agentInternetAccess: z$1.boolean().default(true),
			metricsCadenceMs: z$1.number().default(5e3),
			metricsStalenessMs: z$1.number().default(15e3)
		});
		hostLifetime = new AbortController();
		hostEpoch = randomUUID();
		manager;
		backend;
		bindings;
		preparationStore;
		activePreparations;
		sessionOperations = new SessionOperations();
		leases = new ExecutionLeaseRegistry();
		managerReady;
		revision = 0;
		listeners = /* @__PURE__ */ new Set();
		inventory;
		sampler;
		resourceLifetime;
		constructor(ctx, config) {
			super(ctx, "wrapvmIsolate");
			this.config = config;
			this.registerTools(ctx);
			ctx.effect(() => () => this.hostLifetime.abort(), "wrapvm.hostLifetime");
			ctx.inject(["storageDomain"], async (inner) => {
				let disposed = false;
				const lifetime = new AbortController();
				let close;
				let closeBindings;
				let closePreparations;
				inner.effect(() => async () => {
					disposed = true;
					lifetime.abort();
					if (this.resourceLifetime === lifetime) {
						this.sampler?.dispose();
						this.sampler = void 0;
						this.inventory = void 0;
						this.manager = void 0;
						this.managerReady = void 0;
						this.backend = void 0;
						this.bindings = void 0;
						this.preparationStore = void 0;
						this.activePreparations = void 0;
						this.resourceLifetime = void 0;
					}
					if (closePreparations !== void 0) await closePreparations();
					if (closeBindings !== void 0) await closeBindings();
					if (close !== void 0) await close();
				}, "wrapvm.inventory");
				const domain = await inner.storageDomain.open(defineDomain(wrapvmInventoryDomainSpec));
				close = () => domain.close();
				if (disposed) {
					await close();
					return;
				}
				try {
					const inventory = await new Inventory(new DomainInventoryStore(domain.table("snapshots"))).initialize();
					if (disposed) {
						await close();
						return;
					}
					const bindingDomain = await inner.storageDomain.open(defineDomain({
						name: "wrapvm_bindings",
						version: 1,
						layout: "per-record",
						tables: { events: { valueSchema: z.array(z.discriminatedUnion("type", [z.object({
							type: z.literal("wrapvm/environment-bound"),
							sessionKey: z.string(),
							environmentId: z.string(),
							generation: z.number(),
							timestamp: z.number(),
							shared: z.boolean().optional()
						}), z.object({
							type: z.literal("wrapvm/environment-unbound"),
							sessionKey: z.string(),
							environmentId: z.string(),
							timestamp: z.number()
						})])) } }
					}));
					closeBindings = () => bindingDomain.close();
					const preparationDomain = await inner.storageDomain.open(defineDomain({
						name: "wrapvm_preparations",
						version: 1,
						layout: "per-record",
						tables: {
							records: { valueSchema: preparationSchema },
							active: { valueSchema: preparationSchema }
						}
					}));
					closePreparations = () => preparationDomain.close();
					if (disposed) {
						await closePreparations();
						await closeBindings();
						return;
					}
					let storageUncertain = false;
					const guarded = (name) => ({
						get: (key) => {
							if (storageUncertain) throw new Error("wrapvm: preparation storage write outcome is uncertain; reload before retrying");
							return preparationDomain.table(name).get(key);
						},
						put: async (key, value) => {
							if (storageUncertain) throw new Error("wrapvm: preparation storage is uncertain");
							try {
								await preparationDomain.table(name).put(key, value);
							} catch (error) {
								storageUncertain = true;
								throw error;
							}
						}
					});
					this.preparationStore = guarded("records");
					this.activePreparations = guarded("active");
					const table = bindingDomain.table("events");
					const events = (table.get("current") ?? []).map((event) => event.type === "wrapvm/environment-bound" ? {
						type: event.type,
						sessionKey: event.sessionKey,
						environmentId: asEnvironmentId(event.environmentId),
						generation: event.generation,
						timestamp: event.timestamp,
						...event.shared === void 0 ? {} : { shared: event.shared }
					} : {
						...event,
						environmentId: asEnvironmentId(event.environmentId)
					});
					const bindings = new BindingRegistry({ emit: async (event) => {
						events.push(event);
						try {
							await table.put("current", events);
						} catch (error) {
							events.pop();
							throw error;
						}
					} }, () => Date.now(), () => {
						this.revision++;
						for (const listener of this.listeners) listener();
					});
					bindings.restore(events);
					bindings.markComplete();
					const mountPolicy = makeFsMountPolicyContext({ approvedRoots: [] });
					const backend = new DockerEnvironmentBackend(async (argv, signal) => await this.run(argv, { signal }), {
						...defaultDockerBackendConfig,
						binary: this.config.backend
					}, mountPolicy, inventory);
					const sampler = new ResourceSampler(createDockerStatsSource((ids, signal) => backend.stats(ids, signal), (id, signal) => backend.writableLayerSize(id, signal), (id) => inventory.get(id)?.containerId), {
						cadenceMs: this.config.metricsCadenceMs,
						stalenessMs: this.config.metricsStalenessMs
					});
					const manager = new EnvironmentManager({
						inventory,
						driver: backend,
						bindings,
						mountPolicy,
						budget: {
							totalCpuMillis: cpus().length * 1e3,
							totalMemoryBytes: totalmem()
						},
						executions: this.leases
					});
					this.inventory = inventory;
					this.backend = backend;
					this.bindings = bindings;
					this.manager = manager;
					this.sampler = sampler;
					this.resourceLifetime = lifetime;
				} catch (error) {
					await close();
					throw error;
				}
			});
		}
		async run(argv, options = {}) {
			const timeoutMs = resolveTimeout(options.timeoutMs);
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
			signal.throwIfAborted();
			const proc = this.ctx.subprocess.spawn({
				argv: [...argv],
				cwd: options.cwd ?? process.cwd(),
				graceMs: 1e3,
				signal,
				stdio: {
					stdin: options.stdin === void 0 ? "ignore" : { data: options.stdin },
					stdout: { maxBytes: options.maxBytes ?? 4 << 20 },
					stderr: { maxBytes: 4 << 20 }
				}
			});
			const outcome = await proc.done;
			await proc.waitForExit();
			signal.throwIfAborted();
			return {
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				stdout: proc.collected.stdout?.readFrom(0).text ?? "",
				stderr: proc.collected.stderr?.readFrom(0).text ?? ""
			};
		}
		owner() {
			if (this.ctx.invocation?.peer.principal.kind !== "owner") throw new Error("wrapvm-isolate: authenticated owner required");
		}
		async managed() {
			const { manager, backend, bindings } = this;
			if (!manager || !backend || !bindings) throw new Error("wrapvm-isolate: environment inventory is unavailable");
			if (!this.managerReady) this.managerReady = manager.initialize(this.hostLifetime.signal).catch((error) => {
				this.managerReady = void 0;
				throw error;
			});
			await this.managerReady;
			return {
				manager,
				backend,
				bindings
			};
		}
		operation(op) {
			return {
				id: op.id,
				environmentId: op.environmentId,
				kind: op.kind,
				state: op.state,
				error: op.error ?? null,
				errorCode: op.errorCode ?? null,
				requestedAt: op.requestedAt ?? null,
				settledAt: op.settledAt ?? null
			};
		}
		policy(sessionKey) {
			const binding = this.bindings?.binding(sessionKey);
			return {
				sessionKey,
				mode: "normal",
				generation: binding?.generation ?? 0,
				stage: "idle",
				environmentId: binding?.environmentId ?? null,
				reason: null
			};
		}
		async v02Snapshot(sessionKey) {
			this.owner();
			const { manager, backend, bindings } = await this.managed();
			return {
				environments: await Promise.all((await manager.list(this.hostLifetime.signal)).map(async (record) => {
					const acquired = await backend.captureTarget(record.id, this.hostLifetime.signal);
					const health = acquired.kind === "captured" ? await backend.probe(acquired.target, this.hostLifetime.signal) : null;
					const availability = (v) => v.kind === "unknown" ? v : {
						kind: v.kind,
						reason: null
					};
					const observed = health === null ? null : {
						phase: health.phase,
						shell: availability(health.shell),
						browser: availability(health.browser),
						desktop: availability(health.desktop),
						hostControlPlane: availability(health.hostControlPlane),
						observedAt: health.observedAt ?? null
					};
					const sample = this.sampler?.latest(record.id);
					return {
						id: record.id,
						displayName: record.displayName ?? record.id,
						backend: record.backend,
						ownership: record.ownership,
						image: record.image,
						digest: record.digest,
						createdAt: record.createdAt,
						mounts: [...record.mounts],
						limits: {
							cpuMillis: record.limits.cpuMillis,
							memoryBytes: record.limits.memoryBytes,
							diskBytes: record.limits.diskBytes ?? null
						},
						internetAccess: record.internetAccess,
						desiredPhase: record.desiredPhase ?? null,
						observed,
						resources: sample === void 0 ? null : {
							...sample,
							stale: sample.stale ?? false
						},
						bindings: bindings.usersOf(record.id).flatMap((key) => {
							const b = bindings.binding(key);
							return b ? [b] : [];
						}),
						bindingsComplete: true,
						operations: manager.operationsFor(record.id).map((op) => this.operation(op)),
						uncertainty: manager.uncertainty(record.id)?.error ?? null
					};
				})),
				policy: sessionKey === null ? null : this.policy(sessionKey),
				binding: sessionKey === null ? null : bindings.binding(sessionKey) ?? null,
				bindingComplete: true,
				workspace: sessionKey === null ? null : this.workspaceView(sessionKey)
			};
		}
		async v02Create(input, key) {
			this.owner();
			const { manager, backend } = await this.managed();
			backend.approveMounts(input.mounts);
			const limits = this.limits(input.limits);
			return this.operation(await manager.create({
				...input,
				limits
			}, { idempotencyKey: key }));
		}
		limits(value) {
			return {
				cpuMillis: value.cpuMillis,
				memoryBytes: value.memoryBytes,
				...value.diskBytes === null ? {} : { diskBytes: value.diskBytes }
			};
		}
		async v02Start(id, key) {
			this.owner();
			return this.operation(await (await this.managed()).manager.start(asEnvironmentId(id), { idempotencyKey: key }));
		}
		async v02Stop(id, key) {
			this.owner();
			return this.operation(await (await this.managed()).manager.stop(asEnvironmentId(id), { idempotencyKey: key }));
		}
		async v02Pause(id, key) {
			this.owner();
			return this.operation(await (await this.managed()).manager.pause(asEnvironmentId(id), { idempotencyKey: key }));
		}
		async v02Resume(id, key) {
			this.owner();
			return this.operation(await (await this.managed()).manager.resume(asEnvironmentId(id), { idempotencyKey: key }));
		}
		async v02UpdateLimits(id, limits, key) {
			this.owner();
			return this.operation(await (await this.managed()).manager.updateLimits(asEnvironmentId(id), this.limits(limits), { idempotencyKey: key }));
		}
		async v02PreviewRemoval(id, deleteVolumes) {
			this.owner();
			const preview = await (await this.managed()).manager.previewRemoval(asEnvironmentId(id), deleteVolumes);
			return {
				...preview,
				displayName: preview.displayName ?? null,
				hostMounts: [...preview.hostMounts]
			};
		}
		async v02ConfirmRemoval(id, token, deleteVolumes, key) {
			this.owner();
			return this.operation(await (await this.managed()).manager.remove(asEnvironmentId(id), token, deleteVolumes, { idempotencyKey: key }));
		}
		async v02Bind(session, id, _key) {
			this.owner();
			return await this.sessionOperations.run(session, async () => {
				const { manager, bindings } = await this.managed();
				const env = asEnvironmentId(id);
				if (!manager.get(env)) throw new Error("wrapvm-isolate: unknown environment");
				await bindings.bind(session, env, (bindings.binding(session)?.generation ?? 0) + 1, { allowShared: true });
				return this.operation({
					id: randomUUID(),
					environmentId: env,
					kind: "bind",
					state: "completed",
					settledAt: Date.now()
				});
			});
		}
		async v02Unbind(session, _key) {
			this.owner();
			return await this.sessionOperations.run(session, async () => {
				const { bindings } = await this.managed();
				const binding = bindings.binding(session);
				if (!binding) throw new Error("wrapvm-isolate: no environment selected");
				await bindings.unbind(session);
				return this.operation({
					id: randomUUID(),
					environmentId: binding.environmentId,
					kind: "unbind",
					state: "completed",
					settledAt: Date.now()
				});
			});
		}
		async *v02WatchSession(sessionKey, signal) {
			this.owner();
			await this.managed();
			const ended = AbortSignal.any([signal, this.hostLifetime.signal]);
			let wake = Promise.withResolvers();
			const notify = () => wake.resolve();
			this.listeners.add(notify);
			ended.addEventListener("abort", notify, { once: true });
			try {
				while (!ended.aborted) {
					yield {
						epoch: this.hostEpoch,
						revision: this.revision,
						policy: this.policy(sessionKey),
						binding: this.bindings?.binding(sessionKey) ?? null,
						bindingComplete: true,
						workspace: this.workspaceView(sessionKey)
					};
					await wake.promise;
					wake = Promise.withResolvers();
				}
			} finally {
				this.listeners.delete(notify);
				ended.removeEventListener("abort", notify);
			}
		}
		async v02ViewerUrl(sessionKey, epoch, revision) {
			this.owner();
			if (epoch !== this.hostEpoch || revision !== this.revision) throw new Error("wrapvm-isolate: session selection changed");
			await this.managed();
			if (!this.bindings?.binding(sessionKey)) return null;
			return await this.withTarget(sessionKey, "viewer", async (target) => {
				const origin = `http://127.0.0.1:${target.ports.viewerPort}`;
				const result = await this.run([
					this.config.backend,
					"exec",
					target.containerId,
					GUEST_ENTRYPOINT,
					"sh",
					"-lc",
					"exec \"$@\"",
					"wrapvm-viewer",
					"wrap-desktop",
					"url",
					origin
				], { timeoutMs: 1e4 });
				if (result.exitCode !== 0) throw new Error("wrapvm-isolate: could not read viewer link");
				const url = new URL(result.stdout.trim());
				if (url.origin !== origin || url.username || url.password || !url.searchParams.get("token")) throw new Error("wrapvm-isolate: invalid viewer link");
				if (epoch !== this.hostEpoch || revision !== this.revision) throw new Error("wrapvm-isolate: session selection changed");
				return {
					url: url.href,
					expiresAt: null,
					epoch,
					revision
				};
			});
		}
		async withTarget(session, name, run, requireEndpoints = true) {
			return await this.sessionOperations.run(session, async () => {
				const { manager, backend, bindings } = await this.managed();
				const selected = bindings.binding(session);
				if (!selected) throw new Error("wrapvm-isolate: no environment selected; call vm_prepare to create or select one automatically");
				const release = await this.leases.acquireExecution(selected.environmentId, name);
				try {
					if (bindings.binding(session)?.generation !== selected.generation) throw new Error("wrapvm-isolate: environment selection changed");
					if (manager.uncertainty(selected.environmentId)) throw new Error("wrapvm-isolate: environment has an unknown operation outcome");
					const acquired = await backend.captureTarget(selected.environmentId, this.hostLifetime.signal);
					if (acquired.kind !== "captured") throw new Error(`wrapvm-isolate: environment target ${acquired.kind}`);
					if (requireEndpoints && (acquired.target.ports.viewerPort === 0 || acquired.target.ports.cdpPort === 0)) throw new Error("wrapvm-isolate: environment is not running");
					if (manager.get(selected.environmentId)?.containerId !== acquired.target.containerId) throw new Error("wrapvm-isolate: container differs from inventory");
					if ((await backend.verifyTarget(acquired.target, this.hostLifetime.signal)).container.kind !== "owned") throw new Error("wrapvm-isolate: container ownership could not be verified");
					return await run(acquired.target);
				} finally {
					release();
				}
			});
		}
		/** Watch shared resource samples for managed environments until cancellation. */
		async *v02WatchResources(environmentIds, signal) {
			if (this.ctx.invocation?.peer.principal.kind !== "owner") throw new Error("wrapvm-isolate: authenticated owner required");
			const inventory = this.inventory;
			const sampler = this.sampler;
			const resourceLifetime = this.resourceLifetime;
			if (inventory === void 0 || sampler === void 0 || resourceLifetime === void 0) throw new Error("wrapvm-isolate: environment inventory is unavailable");
			const ids = [...new Set(environmentIds.map(asEnvironmentId))];
			for (const id of ids) if (inventory.get(id) === void 0) throw new Error(`wrapvm-isolate: unknown environment ${id}`);
			const ended = AbortSignal.any([
				signal,
				this.hostLifetime.signal,
				resourceLifetime.signal
			]);
			const pending = /* @__PURE__ */ new Map();
			let wake = Promise.withResolvers();
			const notify = () => wake.resolve();
			ended.addEventListener("abort", notify, { once: true });
			const disposers = [];
			try {
				for (const id of ids) disposers.push(sampler.subscribe(id, (sample) => {
					pending.set(id, {
						environmentId: id,
						resources: {
							...sample,
							stale: sample.stale ?? false
						}
					});
					notify();
				}));
				while (!ended.aborted) {
					if (pending.size === 0) await wake.promise;
					if (ended.aborted) break;
					const updates = [...pending.values()];
					pending.clear();
					wake = Promise.withResolvers();
					for (const update of updates) yield update;
				}
			} finally {
				ended.removeEventListener("abort", notify);
				for (const dispose of disposers) dispose();
			}
		}
		/** Run one command as the image's configured user in its login environment. */
		async exec(target, args, signal) {
			const timeoutMs = resolveTimeout(args.timeoutMs);
			const workdir = args.workdir ?? VM_WORKSPACE;
			if (!workdir.startsWith("/")) throw new Error("wrapvm-isolate: workdir must be an absolute guest path");
			const result = await this.run([
				this.config.backend,
				"exec",
				"-w",
				workdir,
				target.containerId,
				GUEST_ENTRYPOINT,
				"timeout",
				"--kill-after=1s",
				`${timeoutMs / 1e3}s`,
				"sh",
				"-lc",
				args.command
			], {
				timeoutMs: Math.min(2147483647, timeoutMs + 2e3),
				signal
			});
			return {
				output: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode ?? 1
			};
		}
		/** Run `agent-desktop` as the image's user with its desktop session environment. */
		async desktop(target, args, signal) {
			const timeoutMs = resolveTimeout(args.timeoutMs);
			const result = await this.run([
				this.config.backend,
				"exec",
				target.containerId,
				GUEST_ENTRYPOINT,
				"timeout",
				"--kill-after=1s",
				`${timeoutMs / 1e3}s`,
				"sh",
				"-lc",
				"exec \"$@\"",
				"wrapvm-desktop",
				"agent-desktop",
				...args.argv
			], {
				timeoutMs: Math.min(2147483647, timeoutMs + 2e3),
				signal
			});
			return {
				output: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode ?? 1
			};
		}
		/** List CDP DevTools targets of the running VM. */
		async cdpTargets(target, signal) {
			const result = await this.run([
				this.config.backend,
				"exec",
				target.containerId,
				"curl",
				"-fsS",
				`http://127.0.0.1:9222/json/list`
			], {
				timeoutMs: 1e4,
				signal
			});
			if (result.exitCode !== 0) throw new Error(`wrapvm-isolate: CDP list failed\n${result.stderr}`);
			return z.array(z.object({
				id: z.string(),
				title: z.string(),
				url: z.string()
			})).parse(JSON.parse(result.stdout));
		}
		/** Open one CDP target on a fresh page. */
		async cdpOpen(target, url, signal) {
			const result = await this.run([
				this.config.backend,
				"exec",
				target.containerId,
				"curl",
				"-fsS",
				"-X",
				"PUT",
				`http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`
			], {
				timeoutMs: 1e4,
				signal
			});
			if (result.exitCode !== 0) throw new Error(`wrapvm-isolate: CDP open failed\n${result.stderr}`);
			return z.object({ id: z.string() }).parse(JSON.parse(result.stdout));
		}
		/** Close one CDP target. */
		async cdpClose(target, targetId, signal) {
			const result = await this.run([
				this.config.backend,
				"exec",
				target.containerId,
				"curl",
				"-fsS",
				"-X",
				"PUT",
				`http://127.0.0.1:9222/json/close/${encodeURIComponent(targetId)}`
			], {
				timeoutMs: 1e4,
				signal
			});
			if (result.exitCode !== 0) throw new Error(`wrapvm-isolate: CDP close failed\n${result.stderr}`);
			return { id: targetId };
		}
		/** Evaluate one JS expression in one CDP target over WebSocket. */
		async cdpEval(target, targetId, expression, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
			resolveTimeout(timeoutMs);
			const result = await cdpRequest(`ws://127.0.0.1:${target.ports.cdpPort}/devtools/page/${encodeURIComponent(targetId)}`, "Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: true
			}, timeoutMs, signal);
			if (result.exceptionDetails) throw new Error(`wrapvm-isolate: JavaScript failed: ${JSON.stringify(result.exceptionDetails)}`);
			const value = result.result;
			return value && typeof value === "object" && "value" in value ? value.value : void 0;
		}
		async cdpNavigate(target, targetId, url, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
			resolveTimeout(timeoutMs);
			const result = await cdpRequest(`ws://127.0.0.1:${target.ports.cdpPort}/devtools/page/${encodeURIComponent(targetId)}`, "Page.navigate", { url }, timeoutMs, signal);
			if (result.errorText) throw new Error(`wrapvm-isolate: navigation failed: ${String(result.errorText)}`);
		}
		sessionKey(execution) {
			const session = execution.agent?.session.id;
			if (!session) throw new Error("wrapvm-isolate: tool call has no conversation");
			return session;
		}
		workspaceView(session) {
			const record = this.currentPreparation(session);
			return record ? {
				phase: record.phase,
				mode: record.mode,
				guestPath: record.guestPath,
				sourceRoot: record.sourceRoot
			} : null;
		}
		currentPreparation(session) {
			const record = this.activePreparations?.get(session);
			return record?.environmentId === this.bindings?.binding(session)?.environmentId ? record : void 0;
		}
		async workspaceRuntime() {
			const managed = await this.managed();
			const store = this.preparationStore, active = this.activePreparations;
			if (!store || !active) throw new Error("wrapvm-isolate: preparation storage is unavailable");
			return {
				...managed,
				store,
				leases: this.leases,
				lifetime: AbortSignal.any([this.hostLifetime.signal, this.resourceLifetime?.signal ?? this.hostLifetime.signal]),
				binary: this.config.backend,
				defaults: {
					image: this.config.agentImage ?? "wrapvm-dsh:desktop",
					cpuMillis: this.config.agentCpuMillis ?? 2e3,
					memoryBytes: this.config.agentMemoryBytes ?? 2147483648,
					internetAccess: this.config.agentInternetAccess ?? true
				},
				current: (session) => this.currentPreparation(session),
				select: async (record) => {
					await active.put(record.session, record);
					this.revision++;
					for (const listener of this.listeners) listener();
				},
				run: (argv, options) => this.run(argv, options)
			};
		}
		registerTools(ctx) {
			const tools = ctx.tools;
			if (tools === void 0) throw new Error("wrapvm-isolate: ctx.tools is not mounted");
			const objectOutput = {
				schema: {
					type: "object",
					additionalProperties: true
				},
				render: (_args, result) => [{
					type: "text",
					text: JSON.stringify(result, null, 2)
				}]
			};
			tools.register(defineTool({
				name: "vm_prepare",
				description: "Prepare a VM for this conversation automatically: create/reuse/start/resume, copy the current project into a persistent guest workspace and select the environment. No manual GUI steps. Uses configured image/resources; desktop defaults to internet enabled. Never deletes or resets existing environments. Retry preserves guest edits.",
				parameters: {
					description: {
						type: "string",
						required: true,
						description: "Why this task needs the VM and project copy."
					},
					environmentId: {
						type: "string",
						description: "Optional managed environment explicitly requested by the user."
					},
					workspaceMode: {
						type: "string",
						enum: [
							"copy",
							"empty",
							"bind-readonly",
							"bind-readwrite"
						],
						description: "Default copy; mounts require native approval for the exact project and access mode."
					}
				},
				output: objectOutput,
				execute: async (args, execution) => await this.sessionOperations.run(this.sessionKey(execution), async () => await prepareForAgent(ctx, await this.workspaceRuntime(), execution, args)),
				presentCall: (args) => ({
					card: "generic",
					title: "Prepare VM",
					rawInput: {
						task: args.description,
						workspaceMode: args.workspaceMode ?? "copy",
						newEnvironmentInternet: this.config.agentInternetAccess ?? true
					},
					kind: "execute"
				})
			}));
			tools.register(defineTool({
				name: "vm_environments",
				description: "List managed environments without creating or selecting one. Use vm_prepare(environmentId) to select one explicitly. Does not expose other conversation identifiers.",
				parameters: {},
				output: objectOutput,
				execute: async (_args, execution) => {
					const session = this.sessionKey(execution), { manager, backend, bindings } = await this.managed();
					return { environments: await Promise.all((await manager.list(execution.signal)).map(async (record) => {
						const target = await backend.captureTarget(record.id, execution.signal);
						const health = target.kind === "captured" ? await backend.probe(target.target, execution.signal) : null;
						return {
							id: record.id,
							displayName: record.displayName ?? record.id,
							image: record.image,
							state: health?.phase ?? target.kind,
							selected: bindings.binding(session)?.environmentId === record.id,
							workspace: this.currentPreparation(session)?.environmentId === record.id ? workspaceInfo(this.currentPreparation(session)) : null,
							shared: bindings.usersOf(record.id).some((key) => key !== session),
							uncertainty: manager.uncertainty(record.id)?.error ?? null
						};
					})) };
				},
				presentCall: () => ({
					card: "generic",
					title: "VM environments",
					kind: "read"
				})
			}));
			tools.register(defineTool({
				name: "vm_workspace",
				description: "Inspect a prepared workspace, import named project files without overwriting differing guest files, or export named guest files to a NEW .wrapvm-exports review directory in the session project. Exports report host conflicts and never overwrite originals. No arbitrary host paths.",
				parameters: {
					action: {
						type: "string",
						enum: [
							"status",
							"import",
							"export"
						],
						required: true
					},
					paths: {
						type: "array",
						items: { type: "string" },
						description: "1–100 relative project file paths for import/export."
					}
				},
				output: objectOutput,
				execute: async (args, execution) => await this.sessionOperations.run(this.sessionKey(execution), async () => await workspaceForAgent(ctx, await this.workspaceRuntime(), execution, args)),
				presentCall: (args) => ({
					card: "generic",
					title: `VM workspace · ${args.action}`,
					kind: args.action === "status" ? "read" : "edit"
				})
			}));
			tools.register(defineTool({
				name: "load_vm_skill",
				description: "Load guidance distributed with the Wrapvm bundle by its exact skill name.",
				parameters: { skill: {
					type: "string",
					enum: vmSkillNames,
					required: true,
					description: "Bundled VM skill name."
				} },
				output: {
					schema: { type: "string" },
					render: (_args, value) => [{
						type: "text",
						text: value
					}]
				},
				execute: async (args) => readVmSkill(args.skill),
				presentCall: (args) => ({
					card: "generic",
					title: `Load ${args.skill}`,
					kind: "read"
				})
			}));
			tools.register(defineTool({
				name: "vm_status",
				description: "Status snapshot of the isolated wrapvm desktop VM: container state, ports, image and workspace mount. The VM must be running before vm_shell, vm_browser or vm_desktop calls.",
				parameters: {},
				output: {
					schema: STATUS_SCHEMA,
					render: (_args, value) => [{
						type: "text",
						text: JSON.stringify(value, void 0, 2)
					}]
				},
				execute: async (_args, execution) => {
					const session = this.sessionKey(execution);
					const { manager, backend, bindings } = await this.managed();
					const selected = bindings.binding(session);
					if (!selected) return {
						containerName: "",
						image: "",
						state: "unassigned",
						running: false,
						viewerPort: 0,
						cdpPort: 0,
						workspaceDir: null,
						next: "Call vm_prepare; no manual GUI setup is required."
					};
					const record = manager.get(selected.environmentId);
					const acquired = await backend.captureTarget(selected.environmentId, execution.signal);
					if (acquired.kind !== "captured") return {
						containerName: "",
						image: record?.image ?? "",
						state: acquired.kind,
						running: false,
						viewerPort: 0,
						cdpPort: 0,
						workspaceDir: null,
						next: "Inspect the missing or unverifiable environment; do not silently replace or delete it."
					};
					const target = acquired.target;
					const health = await backend.probe(target, execution.signal);
					const uncertainty = manager.uncertainty(selected.environmentId);
					return {
						containerName: target.containerName,
						image: record?.image ?? "",
						state: uncertainty ? "outcome-unknown" : health.phase,
						running: !uncertainty && health.phase === "running",
						viewerPort: target.ports.viewerPort,
						cdpPort: target.ports.cdpPort,
						workspaceDir: this.currentPreparation(session)?.guestPath ?? VM_WORKSPACE,
						next: uncertainty ? "Inspect the uncertain operation; do not reset the environment." : "Call vm_prepare to prepare the project or resume this environment, then use the guest tools."
					};
				},
				presentCall: () => ({
					card: "generic",
					title: "VM status",
					kind: "read"
				})
			}));
			tools.register(defineTool({
				name: "vm_shell",
				description: "Run a shell command inside the isolated wrapvm desktop VM as its configured desktop user. Each call runs in a fresh login shell inside the container; pass `workdir` as an absolute path inside the VM (default: prepared project path, otherwise /home/user/workspace). Each output stream retains at most 4 MiB of its tail. Provide `description` before `command` in the arguments. Before any delete or move, verify the resolved path is the intended one.",
				parameters: {
					command: {
						type: "string",
						required: true,
						description: "Shell command to run inside the VM."
					},
					description: {
						type: "string",
						required: true,
						description: "Short description shown in the UI."
					},
					workdir: {
						type: "string",
						description: "Absolute working directory inside the VM; defaults to the prepared project path, otherwise /home/user/workspace."
					},
					timeoutMs: {
						type: "number",
						description: "Command timeout in milliseconds; defaults to 120000."
					}
				},
				output: {
					schema: EXEC_SCHEMA,
					render: (_args, value) => [{
						type: "text",
						text: [
							value.output,
							value.stderr,
							`[exit code: ${value.exitCode}]`
						].filter(Boolean).join("\n")
					}]
				},
				execute: async (args, execution) => {
					const session = this.sessionKey(execution);
					return await this.withTarget(session, "vm_shell", (target) => this.exec(target, {
						...args,
						workdir: args.workdir ?? this.currentPreparation(session)?.guestPath ?? VM_WORKSPACE
					}, execution.signal));
				},
				presentCall: (args) => ({
					card: "terminal",
					title: args.command,
					description: args.description,
					...args.workdir !== void 0 ? { cwd: args.workdir } : {}
				}),
				presentResult: (args, result) => {
					const block = result.content.length === 1 ? result.content[0] : void 0;
					if (block === void 0 || block.type !== "text") return void 0;
					return {
						card: "terminal",
						title: args.command,
						description: args.description,
						...args.workdir !== void 0 ? { cwd: args.workdir } : {}
					};
				}
			}));
			tools.register(defineTool({
				name: "vm_browser",
				description: "Drive the Chrome inside the isolated wrapvm desktop VM over CDP. Actions: open a page, list tabs, navigate, evaluate JavaScript, read page content, close a tab. `targetId` comes from vm_browser tabs. The VM must be running first.",
				parameters: {
					action: {
						type: "string",
						enum: [
							"open",
							"tabs",
							"navigate",
							"eval",
							"content",
							"close"
						],
						required: true,
						description: "Browser action."
					},
					url: {
						type: "string",
						description: "Target URL for open or navigate."
					},
					targetId: {
						type: "string",
						description: "CDP target id; required for navigate, eval, content and close."
					},
					expression: {
						type: "string",
						description: "JS expression for eval; content reads document.documentElement.outerHTML."
					},
					timeoutMs: {
						type: "number",
						description: "Operation timeout in milliseconds; defaults to 120000."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							action: {
								type: "string",
								required: true
							},
							target: { type: "string" },
							value: { type: "string" },
							targets: {
								type: "array",
								items: {
									type: "object",
									additionalProperties: true
								}
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.value !== void 0 ? String(value.value) : value.targets !== void 0 ? JSON.stringify(value.targets, void 0, 2) : value.target !== void 0 ? value.target : value.action
					}]
				},
				execute: async (args, execution) => {
					const signal = execution.signal;
					signal.throwIfAborted();
					return await this.withTarget(this.sessionKey(execution), "vm_browser", async (target) => {
						switch (args.action) {
							case "open":
								if (args.url === void 0) throw new Error("vm_browser: action open requires url");
								return {
									action: "open",
									target: (await this.cdpOpen(target, args.url, signal)).id
								};
							case "tabs": return {
								action: "tabs",
								targets: (await this.cdpTargets(target, signal)).map((target) => ({
									id: String(target.id),
									title: String(target.title),
									url: String(target.url)
								}))
							};
							case "navigate":
								if (args.targetId === void 0 || args.url === void 0) throw new Error("vm_browser: action navigate requires targetId and url");
								await this.cdpNavigate(target, args.targetId, args.url, args.timeoutMs, signal);
								return {
									action: "navigate",
									value: "ok"
								};
							case "eval": {
								if (args.targetId === void 0 || args.expression === void 0) throw new Error("vm_browser: action eval requires targetId and expression");
								const value = await this.cdpEval(target, args.targetId, args.expression, args.timeoutMs, signal);
								return {
									action: "eval",
									value: value === void 0 ? "" : typeof value === "string" ? value : JSON.stringify(value)
								};
							}
							case "content": {
								if (args.targetId === void 0) throw new Error("vm_browser: action content requires targetId");
								const value = await this.cdpEval(target, args.targetId, "document.documentElement.outerHTML", args.timeoutMs, signal);
								return {
									action: "content",
									value: value === void 0 ? "" : typeof value === "string" ? value : JSON.stringify(value)
								};
							}
							case "close":
								if (args.targetId === void 0) throw new Error("vm_browser: action close requires targetId");
								await this.cdpClose(target, args.targetId, signal);
								return { action: "close" };
							default: throw new Error(`vm_browser: unknown action ${args.action}`);
						}
					});
				},
				presentCall: (args) => ({
					card: "generic",
					title: `vm_browser ${args.action}`,
					kind: "execute",
					rawInput: args.url ?? args.expression ?? args.targetId ?? "",
					content: [{
						type: "text",
						text: args.url ?? args.expression ?? args.targetId ?? ""
					}]
				})
			}));
			tools.register(defineTool({
				name: "vm_desktop",
				description: "Run one `agent-desktop` argv inside the isolated wrapvm desktop VM (passthrough `docker exec <container> agent-desktop ...argv`). The VM must be running first.",
				parameters: {
					argv: {
						type: "array",
						items: { type: "string" },
						required: true,
						description: "Argument vector passed to agent-desktop inside the VM."
					},
					timeoutMs: {
						type: "number",
						description: "Operation timeout in milliseconds; defaults to 120000."
					}
				},
				output: {
					schema: EXEC_SCHEMA,
					render: (_args, value) => [{
						type: "text",
						text: [
							value.output,
							value.stderr,
							`[exit code: ${value.exitCode}]`
						].filter(Boolean).join("\n")
					}]
				},
				execute: async (args, execution) => await this.withTarget(this.sessionKey(execution), "vm_desktop", (target) => this.desktop(target, args, execution.signal)),
				presentCall: (args) => ({
					card: "generic",
					title: `agent-desktop ${args.argv.join(" ")}`,
					kind: "execute",
					rawInput: args.argv.join(" "),
					content: [{
						type: "text",
						text: args.argv.join(" ")
					}]
				})
			}));
		}
	};
})();
//#endregion
export { WrapvmIsolateService, WrapvmIsolateService as default };
