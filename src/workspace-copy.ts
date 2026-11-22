/** Bounded, explicit project snapshots. No symlinks, credentials or host deletion. */
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, mkdir, mkdtemp } from 'node:fs/promises'
import { join, relative, isAbsolute, sep, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { makeFsMountPolicyContext, evaluateHostMount } from './mount-policy.ts'

export interface WorkspaceFile { path: string; hash: string; size: number; executable: boolean }
export interface WorkspacePayload extends WorkspaceFile { data: string }
export interface WorkspaceSnapshot { files: WorkspacePayload[]; excluded: string[]; excludedCount: number; bytes: number }
class ExcludedContentError extends Error {}
export const COPY_LIMITS = { files: 5000, bytes: 64 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 }
const excludedNames = new Set(['.git', '.dev', '.dsh', '.ssh', '.aws', '.gnupg', '.docker', '.kube', '.npmrc', '.pypirc', '.netrc', '.yarnrc.yml', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', 'dist', 'build', 'coverage', '.wrapvm-exports', '.wrapvm-snapshot.json'])
export function excludedPath(path: string): boolean {
  return path.split('/').some(part => excludedNames.has(part) || /^\.env(?:\.|$)/i.test(part) || /(?:\.(?:pem|key|p12|pfx|keystore)|^id_(?:rsa|ed25519|ecdsa)|^credentials(?:\.|$)|^secrets?(?:\.|$))/i.test(part))
}
export function filePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || Array.from(value).some(char => char.charCodeAt(0) < 32) || value.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('vm_workspace: expected a relative file path inside the project')
  if (excludedPath(value)) throw new Error(`vm_workspace: excluded path ${value}`)
  return value
}
export const hashBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export async function projectRoot(path: string): Promise<string> {
  const root = await realpath(path)
  if (!(await lstat(root)).isDirectory()) throw new Error('vm_prepare: workspace is not a directory')
  const context = makeFsMountPolicyContext({ approvedRoots: [root] })
  const decision = evaluateHostMount({ hostPath: root, guestPath: '/mnt/project', access: 'read-only' }, context)
  if (!decision.ok) throw new Error(`vm_prepare: unsafe workspace: ${decision.reason}`)
  return root
}

/** Revalidate all ancestors and use O_NOFOLLOW for the final file. */
export async function readProjectFile(root: string, name: string): Promise<WorkspacePayload> {
  filePath(name)
  if (await realpath(root) !== root) throw new Error('vm_workspace: project root changed')
  let parent = root
  for (const part of name.split('/').slice(0, -1)) {
    parent = join(parent, part)
    if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error('vm_workspace: symlink or non-directory ancestor')
  }
  const path = join(root, name)
  const resolved = relative(root, await realpath(path))
  if (resolved.startsWith('..' + sep) || isAbsolute(resolved)) throw new Error('vm_workspace: file escapes project')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > COPY_LIMITS.fileBytes) throw new Error(`vm_workspace: unsupported or oversized file ${name}`)
    // Read at most the cap plus one byte even if a concurrent writer grows the file.
    const buffer = Buffer.alloc(COPY_LIMITS.fileBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await handle.stat()
    if (size > COPY_LIMITS.fileBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) throw new Error(`vm_workspace: file changed during snapshot: ${name}`)
    const bytes = buffer.subarray(0, size)
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(bytes.toString('utf8'))) throw new ExcludedContentError(`vm_workspace: private key content excluded: ${name}`)
    return { path: name, hash: hashBytes(bytes), size, executable: (before.mode & 0o111) !== 0, data: bytes.toString('base64') }
  } finally { await handle.close() }
}

export async function snapshotProject(root: string | null, signal: AbortSignal, paths?: readonly string[]): Promise<WorkspaceSnapshot> {
  const result: WorkspaceSnapshot = { files: [], excluded: [], excludedCount: 0, bytes: 0 }
  if (root === null) return result
  const exclude = (name: string): void => { result.excludedCount++; if (result.excluded.length < 100) result.excluded.push(name) }
  let visited = 0
  const visit = async (name: string): Promise<void> => {
    signal.throwIfAborted()
    if (++visited > 20000) throw new Error('vm_workspace: project entry limit exceeded')
    if (excludedPath(name)) { exclude(name); return }
    const path = join(root, name)
    const info = await lstat(path)
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) || (!info.isDirectory() && !info.isFile())) { exclude(name); return }
    if (info.isDirectory()) {
      if (paths) throw new Error('vm_workspace: targeted transfers require individual file paths, not directories')
      if (name.split('/').length > 40) throw new Error('vm_workspace: project nesting limit exceeded')
      if (await realpath(path) !== path) throw new Error('vm_workspace: directory changed during snapshot')
      for (const child of (await readdir(path)).sort()) await visit(name ? `${name}/${child}` : child)
    } else {
      let file: WorkspacePayload
      try { file = await readProjectFile(root, name) } catch (error) { if (error instanceof ExcludedContentError) { exclude(name); return } throw error }
      result.bytes += file.size
      result.files.push(file)
      if (result.files.length > COPY_LIMITS.files || result.bytes > COPY_LIMITS.bytes) throw new Error('vm_workspace: project exceeds 5000 files or 64 MiB; narrow the session workspace')
    }
  }
  if (paths) { for (const path of new Set(paths)) { filePath(path); await visit(path) } }
  else for (const name of (await readdir(root)).sort()) await visit(name)
  return result
}

/** Export to a NEW review directory. Never overwrite the host project's original files. */
export async function exportReview(root: string, files: WorkspacePayload[], baseline: readonly WorkspaceFile[], signal: AbortSignal): Promise<{ directory: string; conflicts: string[] }> {
  if (await projectRoot(root) !== root) throw new Error('vm_workspace: project identity changed')
  const parsed = files.map(f => {
    filePath(f.path)
    const bytes = Buffer.from(f.data, 'base64')
    if (bytes.length > COPY_LIMITS.fileBytes || hashBytes(bytes) !== f.hash || bytes.length !== f.size) throw new Error('vm_workspace: invalid guest file payload')
    return { ...f, bytes }
  })
  if (parsed.length > COPY_LIMITS.files || parsed.reduce((n, f) => n + f.size, 0) > COPY_LIMITS.bytes) throw new Error('vm_workspace: export exceeds limits')
  const conflicts: string[] = []
  for (const file of parsed) {
    signal.throwIfAborted()
    const base = baseline.find(f => f.path === file.path)
    try { if ((await readProjectFile(root, file.path)).hash !== base?.hash) conflicts.push(file.path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || base) conflicts.push(file.path) }
  }
  const parent = join(root, '.wrapvm-exports')
  await mkdir(parent, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error('vm_workspace: unsafe export directory')
  const directory = await mkdtemp(join(parent, 'review-'))
  for (const file of parsed) {
    signal.throwIfAborted()
    const path = join(directory, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error('vm_workspace: export directory changed')
    const handle = await open(path, 'wx', file.executable ? 0o700 : 0o600)
    try { await handle.writeFile(file.bytes) } finally { await handle.close() }
  }
  return { directory, conflicts }
}
