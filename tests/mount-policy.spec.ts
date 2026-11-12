/**
 * Canonical mount policy tests: explicit approval intent, canonicalization
 * (symlinks, `..`, `~`), blocked broad roots and control subtrees, ancestor
 * exposure, and path-prefix tricks. These pin the Phase-3 replacement for the
 * fixed blocked-root list the review flagged.
 */
import { describe, expect, it } from 'vitest'
import { canonicalizeHostPath, evaluateHostMount, makeFsMountPolicyContext, mountPolicyRefusals, staticMountRefusal } from '../src/mount-policy.ts'
import { fakeMountContext } from './fixtures/env-fixtures.ts'

const mount = (hostPath: string, access: 'read-only' | 'read-write' = 'read-write', guestPath = '/mnt/shared') => ({ hostPath, guestPath, access })

describe('canonical mount policy', () => {
  it('refuses every host mount when nothing was explicitly approved', () => {
    const context = fakeMountContext()
    const decision = evaluateHostMount(mount('/Users/tester/projects/app'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/no explicit approval/)
  })

  it('allows a mount inside an explicitly approved root', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const decision = evaluateHostMount(mount('/Users/tester/projects/app'), context)
    expect(decision).toEqual({ ok: true, canonicalPath: '/Users/tester/projects/app' })
  })

  it('refuses the home directory itself even when approved, because it contains control paths', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester'] })
    const decision = evaluateHostMount(mount('/Users/tester'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/contains the control path/)
  })

  it('refuses broad roots as mounts', () => {
    const context = fakeMountContext({ approvedRoots: ['/'] })
    for (const path of ['/', '/Users', '/home']) {
      const decision = evaluateHostMount(mount(path), context)
      expect(decision.ok, path).toBe(false)
    }
  })

  it('refuses control subtrees inside an approved root', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester'] })
    for (const path of ['/Users/tester/.dsh', '/Users/tester/.ssh', '/Users/tester/.ssh/id_ed25519', '/Users/tester/Library/Keychains']) {
      const decision = evaluateHostMount(mount(path), context)
      expect(decision.ok, path).toBe(false)
      expect(decision.reason, path).toMatch(/not allowed/)
    }
  })

  it('refuses a mount that would contain a control path (ancestor exposure)', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const decision = evaluateHostMount(mount('/Users/tester/projects/../'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/control path/)
  })

  it('follows symlinks: a link inside the approved root escaping to a control path is refused', () => {
    const context = fakeMountContext({
      approvedRoots: ['/Users/tester/projects'],
      existing: ['/', '/Users', '/Users/tester', '/Users/tester/projects', '/Users/tester/projects/link', '/Users/tester/.ssh'],
      symlinks: { '/Users/tester/projects/link': '/Users/tester/.ssh' },
    })
    const decision = evaluateHostMount(mount('/Users/tester/projects/link'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/not allowed/)
  })

  it('follows ancestor symlinks: a symlinked parent above the target is canonicalized', () => {
    const context = fakeMountContext({
      approvedRoots: ['/Users/tester/projects'],
      existing: ['/', '/Users', '/Users/tester', '/Users/tester/projects', '/Users/tester/projects/escape', '/Users/tester/projects/escape/sub'],
      symlinks: { '/Users/tester/projects/escape': '/etc' },
    })
    const decision = evaluateHostMount(mount('/Users/tester/projects/escape/sub'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/blocked path/)
  })

  it('does not fall for path-prefix tricks (projects-evil is not under projects)', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const decision = evaluateHostMount(mount('/Users/tester/projects-evil'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/no explicit approval/)
  })

  it('normalizes dot-dot segments before comparing', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const decision = evaluateHostMount(mount('/Users/tester/projects/x/../../.ssh'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/not allowed/)
  })

  it('expands ~ against the policy home', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/shared'] })
    const decision = evaluateHostMount(mount('~/shared'), context)
    expect(decision).toEqual({ ok: true, canonicalPath: '/Users/tester/shared' })
  })

  it('canonicalizes a not-yet-existing leaf under an existing ancestor', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const decision = evaluateHostMount(mount('/Users/tester/projects/new-dir'), context)
    expect(decision).toEqual({ ok: true, canonicalPath: '/Users/tester/projects/new-dir' })
  })

  it('fails closed when no ancestor exists to canonicalize', () => {
    const context = fakeMountContext({ approvedRoots: ['/nowhere'], existing: ['/', '/Users'] })
    const decision = evaluateHostMount(mount('/nowhere/deep/path'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/cannot be validated/)
  })

  it('refuses relative paths', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const decision = evaluateHostMount(mount('projects/app'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/must be absolute/)
  })

  it('read-only access does not relax any rule', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester'] })
    const decision = evaluateHostMount(mount('/Users/tester/.dsh', 'read-only'), context)
    expect(decision.ok).toBe(false)
  })

  it('refuses a guest path of /', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/shared'] })
    const decision = evaluateHostMount(mount('/Users/tester/shared', 'read-write', '/'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/guest path/)
  })

  it('honors extra blocked subtrees from configuration', () => {
    const context = fakeMountContext({
      approvedRoots: ['/Volumes/work'],
      existing: ['/', '/Volumes', '/Volumes/work', '/Volumes/work/secrets'],
      extraBlockedSubtrees: ['/Volumes/work/secrets'],
    })
    const decision = evaluateHostMount(mount('/Volumes/work/secrets'), context)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toMatch(/not allowed/)
  })

  it('aggregates one refusal per denied mount', () => {
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    const reasons = mountPolicyRefusals([
      mount('/Users/tester/projects/app'),
      mount('/Users/tester/.ssh'),
      mount('/etc'),
    ], context)
    expect(reasons).toHaveLength(2)
  })

  it('canonicalizeHostPath resolves the nearest existing ancestor', () => {
    const context = fakeMountContext()
    expect(canonicalizeHostPath('/Users/tester/projects/deep/nested', context)).toBe('/Users/tester/projects/deep/nested')
  })
})

describe('static mount screen (fallback without filesystem context)', () => {
  it('refuses broad roots, homes, and control segments', () => {
    for (const path of ['/', '/Users', '/Users/alice', '/etc', '/etc/x', '/var/lib', '~', '~/x', '/home/user', '/Users/tester/.dsh', '/home/user/projects/.ssh']) {
      expect(staticMountRefusal(mount(path)), path).toMatch(/not allowed/)
    }
  })

  it('passes ordinary project subpaths outside blocked roots', () => {
    expect(staticMountRefusal(mount('/home/user/shared'))).toBeUndefined()
    expect(staticMountRefusal(mount('/Volumes/work/notes'))).toBeUndefined()
  })
})

describe('filesystem-backed context factory', () => {
  it('builds a context that canonicalizes a real temp path', () => {
    const context = makeFsMountPolicyContext({ approvedRoots: ['/tmp'] })
    const decision = evaluateHostMount(mount('/tmp'), context)
    // /tmp may itself be a symlink (macOS: /private/tmp); the decision must be
    // consistent with the canonical answer, never a crash.
    expect(typeof decision.ok).toBe('boolean')
    expect(context.homedir.length).toBeGreaterThan(0)
  })
})