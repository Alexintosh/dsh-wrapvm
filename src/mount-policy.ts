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

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { EnvironmentMount } from './environments.ts'

/** Roots that may never be mounted, nor mounted as part of anything broader. */
const BLOCKED_EXACT_ROOTS = ['/', '/Users', '/home', '/private', '/System/Volumes'] as const

/** Subtrees that may never be entered by a protected-mode mount. */
const BLOCKED_SUBTREES = [
  '/etc', '/private/etc', '/var', '/private/var', '/usr', '/bin', '/sbin', '/lib', '/opt',
  '/Applications', '/Library', '/System', '/root', '/proc', '/sys', '/dev', '/home/root',
] as const

/** Home-relative control directories that may never be entered (joined to the home). */
const HOME_CONTROL_DIRS = [
  '.dsh', '.ssh', '.aws', '.gnupg', '.docker', '.config', '.colima', '.lima', '.kube',
  '.Trash', 'Library', 'Applications', '.npm', '.zshrc', '.bashrc', '.profile',
] as const

/** Context the policy evaluates against; injected so tests need no real filesystem. */
export interface MountPolicyContext {
  /** Canonical resolution of an existing path (symlinks fully resolved). */
  readonly realpath: (path: string) => string
  /** Whether a path exists (used to find the nearest existing ancestor). */
  readonly exists: (path: string) => boolean
  /** The host user's home directory (absolute, canonical). */
  readonly homedir: string
  /**
   * Roots the user explicitly approved sharing, as host paths. A mount is
   * allowed only when its canonical path sits inside one of these. An empty
   * list means nothing was approved and every host mount is refused.
   */
  readonly approvedRoots: readonly string[]
  /** Additional blocked subtrees from configuration (e.g. the installed app path). */
  readonly extraBlockedSubtrees?: readonly string[]
}

/** Outcome of evaluating one mount against the policy. */
export interface MountDecision {
  readonly ok: boolean
  /** Canonical host path when allowed. */
  readonly canonicalPath?: string
  /** Precise refusal reason when denied. */
  readonly reason?: string
}

function splitPath(path: string): readonly string[] {
  return path.split(sep).filter(part => part.length > 0)
}

/** True when `child` is `parent` or below it, on path-segment boundaries. */
function isSameOrUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent === sep ? parent : parent + sep)
}

/** Expand a leading `~` and normalize `.`/`..` without touching the filesystem. */
function expandAndNormalize(path: string, home: string): string {
  let text = path
  if (text === '~') text = home
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(home, text.slice(2))
  if (!isAbsolute(text)) throw new Error(`mount path '${path}' must be absolute or start with ~/`)
  const out: string[] = []
  for (const part of splitPath(resolve(text))) {
    if (part === '..') out.pop()
    else out.push(part)
  }
  return sep + out.join(sep)
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
export function canonicalizeHostPath(path: string, context: MountPolicyContext): string {
  const normalized = expandAndNormalize(path, context.homedir)
  let current = normalized
  const suffix: string[] = []
  for (;;) {
    if (current === sep) break
    if (context.exists(current)) {
      const real = context.realpath(current)
      return suffix.length === 0 ? real : resolve(real, ...suffix)
    }
    suffix.unshift(splitPath(current).at(-1)!)
    current = parse(current).dir
  }
  // Every ancestor missing (or root itself absent): fail closed.
  throw new Error(`mount path '${path}' has no existing ancestor to canonicalize`)
}

function blockedSubtrees(context: MountPolicyContext): readonly string[] {
  const home = context.homedir
  const homeControls = HOME_CONTROL_DIRS.map(dir => join(home, dir))
  const extras = (context.extraBlockedSubtrees ?? []).map(extra => resolve(extra))
  return [...BLOCKED_SUBTREES, ...homeControls, ...extras]
}

/**
 * Decide whether one host mount may be shared with a protected-mode guest.
 * @param mount - the requested mount with its visible access mode.
 * @param context - policy context (approval roots, canonicalization, home).
 * @returns the decision with a precise reason when denied.
 */
export function evaluateHostMount(mount: EnvironmentMount, context: MountPolicyContext): MountDecision {
  const deny = (reason: string): MountDecision => ({ ok: false, reason })
  let canonical: string
  try {
    canonical = canonicalizeHostPath(mount.hostPath, context)
  } catch (error) {
    return deny(`the mount ${mount.hostPath} cannot be validated: ${error instanceof Error ? error.message : String(error)}`)
  }
  if ((BLOCKED_EXACT_ROOTS as readonly string[]).includes(canonical)) {
    return deny(`the mount ${mount.hostPath} is not allowed: ${canonical} exposes every account and control file on the host`)
  }
  for (const root of blockedSubtrees(context)) {
    if (isSameOrUnder(canonical, root)) {
      return deny(`the mount ${mount.hostPath} is not allowed: ${canonical} contains the control path ${root}`)
    }
    if (isSameOrUnder(root, canonical)) {
      return deny(`the mount ${mount.hostPath} is not allowed: ${canonical} is inside the blocked path ${root}`)
    }
  }
  if (canonical === context.homedir) {
    return deny(`the mount ${mount.hostPath} is not allowed: the home directory itself may never be shared`)
  }
  const approved = context.approvedRoots.some(root => {
    let canonicalRoot: string
    try {
      canonicalRoot = canonicalizeHostPath(root, context)
    } catch {
      return false
    }
    return isSameOrUnder(canonicalRoot, canonical)
  })
  if (!approved) {
    return deny(`the mount ${mount.hostPath} is not allowed: no explicit approval covers ${canonical}`)
  }
  const guest = expandAndNormalizeGuest(mount.guestPath)
  if (guest === sep) return deny(`the mount ${mount.hostPath} is not allowed: the guest path may not be /`)
  return { ok: true, canonicalPath: canonical }
}

function expandAndNormalizeGuest(path: string): string {
  if (!path.startsWith('/')) throw new Error(`guest path '${path}' must be absolute`)
  const out: string[] = []
  for (const part of splitPath(path)) {
    if (part === '..') out.pop()
    else out.push(part)
  }
  return sep + out.join(sep)
}

/**
 * Aggregate refusals for a mount set under the canonical policy.
 * @param mounts - requested mounts.
 * @param context - policy context.
 * @returns one precise reason per denied mount (empty when every mount passes).
 */
export function mountPolicyRefusals(mounts: readonly EnvironmentMount[], context: MountPolicyContext): string[] {
  const reasons: string[] = []
  for (const mount of mounts) {
    const decision = evaluateHostMount(mount, context)
    if (!decision.ok) reasons.push(decision.reason!)
  }
  return reasons
}

/** Static control-path screen used when no filesystem context is available. */
const STATIC_BLOCKED_ROOTS = ['/', '/Users', '/etc', '/private/etc', '/var', '/usr', '/bin', '/sbin', '/lib', '/opt', '/Applications', '/Library', '/System', '/root', '/home', '~'] as const

/** Home-relative control directory names the static screen also refuses. */
const STATIC_CONTROL_SEGMENTS = ['.dsh', '.ssh', '.aws', '.gnupg', '.docker', '.config', '.colima', '.lima', '.kube'] as const

/**
 * Fail-closed static fallback for {@link protectedModeRefusal} callers without
 * a {@link MountPolicyContext}. It catches the obvious control paths but is
 * NOT the real enforcement: only the canonical policy resolves symlinks and
 * honors explicit approval.
 * @param mount - the mount to screen.
 * @returns a refusal reason, or undefined when the static screen passes it.
 */
export function staticMountRefusal(mount: EnvironmentMount): string | undefined {
  const path = mount.hostPath
  const hit = STATIC_BLOCKED_ROOTS.find(root => path === root || path.startsWith(`${root}${sep}`) || (root === '~' && (path === '~' || path.startsWith('~/') || path.startsWith('~\\'))))
  if (hit !== undefined && !(hit === '/home' && path.startsWith('/home/') && splitPath(path).length > 2)) {
    return `the mount ${path} is not allowed`
  }
  if ((STATIC_CONTROL_SEGMENTS as readonly string[]).some(segment => splitPath(path).includes(segment))) {
    return `the mount ${path} is not allowed`
  }
  return undefined
}

/**
 * Build a policy context backed by the real filesystem.
 * @param options - approved roots, extra blocked subtrees, home override.
 * @returns a context usable by {@link evaluateHostMount}.
 */
export function makeFsMountPolicyContext(options: {
  approvedRoots: readonly string[]
  extraBlockedSubtrees?: readonly string[]
  homedir?: string
}): MountPolicyContext {
  const home = options.homedir ?? homedir()
  return {
    realpath: path => realpathSync(path),
    exists: path => {
      try {
        statSync(path)
        return true
      } catch {
        return false
      }
    },
    homedir: home,
    approvedRoots: options.approvedRoots,
    ...(options.extraBlockedSubtrees !== undefined ? { extraBlockedSubtrees: options.extraBlockedSubtrees } : {}),
  }
}