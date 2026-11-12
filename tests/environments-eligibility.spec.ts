/**
 * Protected-mode eligibility tests for the Phase-3 revision: every required
 * guest service must be VERIFIED available, control-plane isolation must be
 * observed (unknown refuses), and mount checks delegate to the canonical
 * policy when one is supplied. The Phase-1 pinned behaviors stay green in
 * security-contract.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { protectedModeRefusal, type EnvironmentHealth } from '../src/environments.ts'
import { descriptorFor, env1, fakeMountContext } from './fixtures/env-fixtures.ts'

const health = (overrides: Partial<EnvironmentHealth> = {}): EnvironmentHealth => ({
  phase: 'running',
  shell: { kind: 'available' },
  browser: { kind: 'available' },
  desktop: { kind: 'available' },
  hostControlPlane: { kind: 'unavailable' },
  ...overrides,
})

describe('protected-mode eligibility (Phase-3 strengthening)', () => {
  it('admits a fully verified environment', () => {
    expect(protectedModeRefusal(descriptorFor(env1), health())).toBeUndefined()
  })

  it('refuses when the shell could not be verified', () => {
    expect(protectedModeRefusal(descriptorFor(env1), health({ shell: { kind: 'unknown', reason: 'probe could not run' } }))).toMatch(/shell.*could not be verified/)
  })

  it('refuses when the shell is unavailable', () => {
    expect(protectedModeRefusal(descriptorFor(env1), health({ shell: { kind: 'unavailable' } }))).toMatch(/shell service is not available/)
  })

  it('refuses when the browser is unavailable', () => {
    expect(protectedModeRefusal(descriptorFor(env1), health({ browser: { kind: 'unavailable' } }))).toMatch(/browser/)
  })

  it('refuses when the desktop is unknown', () => {
    expect(protectedModeRefusal(descriptorFor(env1), health({ desktop: { kind: 'unknown', reason: 'viewer probe timed out' } }))).toMatch(/desktop.*could not be verified/)
  })

  it('refuses unknown control-plane isolation with its reason', () => {
    const refusal = protectedModeRefusal(descriptorFor(env1), health({ hostControlPlane: { kind: 'unknown', reason: 'curl missing in guest' } }))
    expect(refusal).toMatch(/control-plane/)
    expect(refusal).toMatch(/curl missing in guest/)
  })

  it('delegates mount checks to the canonical policy when supplied', () => {
    const descriptor = descriptorFor(env1, { mounts: [{ hostPath: '/home/user/shared', guestPath: '/mnt/x', access: 'read-only' }] })
    const context = fakeMountContext({
      approvedRoots: ['/home/user/shared'],
      existing: ['/', '/home', '/home/user', '/home/user/shared', '/etc'],
      symlinks: { '/home/user/shared': '/etc' },
    })
    // The static screen passes this path; the canonical policy catches the symlink escape.
    expect(protectedModeRefusal(descriptor, health())).toBeUndefined()
    expect(protectedModeRefusal(descriptor, health(), context)).toMatch(/not allowed/)
  })

  it('honors explicit approval through the canonical policy', () => {
    const descriptor = descriptorFor(env1, { mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-write' }] })
    const context = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })
    expect(protectedModeRefusal(descriptor, health(), context)).toBeUndefined()
  })

  it('still refuses a non-running environment before any service check', () => {
    expect(protectedModeRefusal(descriptorFor(env1), health({ phase: 'paused', shell: { kind: 'unknown', reason: 'x' } }))).toMatch(/paused/)
  })
})