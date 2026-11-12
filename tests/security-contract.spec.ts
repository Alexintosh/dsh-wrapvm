/**
 * Phase-1 security contract tests for Wrapvm Isolate 0.2: exact trusted tool
 * identity, in-flight accounting, final-dispatch admission decisions, durable
 * fail-closed projection, one-shot grants, and deterministic activation.
 * These exercise the contract modules directly; the runtime gaps they pin are
 * proven against the real pipeline in `security-runtime-gaps.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolExecution, SafetyMode } from '@deepseek-ai/dsh-tools'
import { blocksHostWork, admitsTrustedOnly, environmentUsable } from '../src/policy.ts'
import { admitTrustedCall, bundledSkillConstraints, pinTrustedCapabilities, VM_CAPABILITIES, type TrustedCapabilityRegistration } from '../src/capabilities.ts'
import { createProtectedAdmission, InFlightLedger } from '../src/admission.ts'
import { GrantLedger, type GrantAttempt } from '../src/grants.ts'
import { VmActivationController, type ActivationPorts } from '../src/activation.ts'
import { degradeToUnavailable, inheritProjection, projectWrapvmPolicy, type WrapvmSessionEvent } from '../src/projection.ts'
import { protectedModeRefusal, type EnvironmentDescriptor, type EnvironmentHealth } from '../src/environments.ts'

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

describe('protection mode vocabulary', () => {
  it('refuses host work in every non-normal mode and never treats a container as proof', () => {
    expect(blocksHostWork('normal')).toBe(false)
    expect(blocksHostWork('activating')).toBe(true)
    expect(blocksHostWork('protected')).toBe(true)
    expect(blocksHostWork('protected-unavailable')).toBe(true)
    expect(admitsTrustedOnly('activating')).toBe(true)
    expect(admitsTrustedOnly('protected')).toBe(true)
    expect(admitsTrustedOnly('protected-unavailable')).toBe(false)
    expect(admitsTrustedOnly('normal')).toBe(false)
    expect(environmentUsable('protected')).toBe(true)
    expect(environmentUsable('protected-unavailable')).toBe(false)
  })
})

describe('trusted capability identity', () => {
  const pinnedVmShell = definition('vm_shell')
  const pinned = pinTrustedCapabilities([
    { capability: 'vm_shell', definition: pinnedVmShell, ownerPlugin: '@deepseek-ai/dsh-wrapvm-isolate' },
  ])

  it('admits the exact pinned registration only', () => {
    expect(admitTrustedCall('vm_shell', pinnedVmShell, pinned)).toBeUndefined()
  })

  it('denies a replaced or shadowed registration behind the trusted name', () => {
    expect(admitTrustedCall('vm_shell', definition('vm_shell'), pinned)).toMatch(/does not match the pinned/)
  })

  it('denies a forged vm_* name that was never pinned', () => {
    expect(admitTrustedCall('vm_process', definition('vm_process'), pinned)).toMatch(/not a trusted VM capability/)
  })

  it('denies host tools and unresolvable names', () => {
    expect(admitTrustedCall('host_shell', definition('host_shell'), pinned)).toMatch(/not a trusted VM capability/)
    expect(admitTrustedCall('vm_shell', undefined, pinned)).toMatch(/not available in protected mode/)
  })

  it('never trusts the host PTC transport run_code', () => {
    expect(admitTrustedCall('run_code', definition('run_code'), pinned)).toMatch(/run_code/)
  })

  it('refuses to pin one capability twice', () => {
    expect(() => pinTrustedCapabilities([
      { capability: 'vm_shell', definition: pinnedVmShell, ownerPlugin: 'a' },
      { capability: 'vm_shell', definition: definition('vm_shell'), ownerPlugin: 'b' },
    ])).toThrow(/pinned twice/)
  })

  it('covers the guest capability surface the plan admits', () => {
    expect(VM_CAPABILITIES).toContain('vm_process')
    expect(VM_CAPABILITIES).toContain('vm_enter')
  })

  it('does not alias the caller registration objects after pinning', () => {
    const registration: TrustedCapabilityRegistration = { capability: 'vm_shell', definition: pinnedVmShell, ownerPlugin: 'p' }
    const pinned = pinTrustedCapabilities([registration])
    // The caller mutates the object it handed to pinTrustedCapabilities AFTER
    // pinning: the retained registration must be a defensive copy, so swapping
    // the definition here can never admit the replacement.
    ;(registration as { definition: ToolDefinition }).definition = definition('vm_shell')
    expect(admitTrustedCall('vm_shell', registration.definition, pinned)).toMatch(/does not match the pinned/)
    expect(admitTrustedCall('vm_shell', pinnedVmShell, pinned)).toBeUndefined()
  })

  it('freezes the retained registrations against later mutation', () => {
    const pinned = pinTrustedCapabilities([{ capability: 'vm_shell', definition: pinnedVmShell, ownerPlugin: 'p' }])
    const retained = pinned.get('vm_shell')
    expect(retained).toBeDefined()
    expect(Object.isFrozen(retained)).toBe(true)
    expect(() => {
      ;(retained as { definition: ToolDefinition }).definition = definition('vm_shell')
    }).toThrow()
    expect(admitTrustedCall('vm_shell', pinnedVmShell, pinned)).toBeUndefined()
  })

  it('returns an immutable lookup facade, never the mutable backing Map', () => {
    const pinned = pinTrustedCapabilities([{ capability: 'vm_shell', definition: pinnedVmShell, ownerPlugin: 'p' }])
    expect(pinned).not.toBeInstanceOf(Map)
    // Mutating the returned lookup must not be possible: no `set`, no aliasing
    // of a live Map through iteration.
    const asMap = pinned as unknown as Map<string, TrustedCapabilityRegistration>
    expect(asMap.set).toBeUndefined()
    expect(() => asMap.set('load_vm_skill', { capability: 'load_vm_skill', definition: definition('load_vm_skill'), ownerPlugin: 'evil' })).toThrow()
    expect(pinned.has('load_vm_skill')).toBe(false)
    expect(admitTrustedCall('load_vm_skill', definition('load_vm_skill'), pinned, { skill: 'anything' })).toMatch(/not a trusted VM capability/)
    // The forEach callback receives the facade, not a mutable backing Map.
    pinned.forEach((_value, _key, view) => {
      expect(() => (view as unknown as Map<string, unknown>).delete('vm_shell')).toThrow()
    })
    // Iteration still works over the immutable facade.
    expect([...pinned.keys()]).toEqual(['vm_shell'])
    expect([...pinned]).toEqual([['vm_shell', pinned.get('vm_shell')]])
    expect(pinned.size).toBe(1)
  })
})

describe('trusted host capabilities with constrained parameters', () => {
  const askUser = definition('ask_user_question')
  const loadSkill = definition('load_vm_skill')
  const pinned = pinTrustedCapabilities([
    { capability: 'ask_user_question', definition: askUser, ownerPlugin: '@deepseek-ai/dsh-tools', constraints: () => undefined },
    { capability: 'load_vm_skill', definition: loadSkill, ownerPlugin: '@deepseek-ai/dsh-wrapvm-isolate', constraints: bundledSkillConstraints(['use-vm', 'vm-workspace']) },
  ])

  it('admits the pinned DSH question transport identity only', () => {
    expect(admitTrustedCall('ask_user_question', askUser, pinned, { question: 'proceed?' })).toBeUndefined()
    expect(admitTrustedCall('ask_user_question', definition('ask_user_question'), pinned, { question: 'x' })).toMatch(/does not match the pinned/)
  })

  it('constrains bundled skill loads to known skill ids', () => {
    expect(admitTrustedCall('load_vm_skill', loadSkill, pinned, { skill: 'use-vm' })).toBeUndefined()
    expect(admitTrustedCall('load_vm_skill', loadSkill, pinned, { skill: 'host-secret-skill' })).toMatch(/distributed with the Wrapvm bundle/)
    expect(admitTrustedCall('load_vm_skill', loadSkill, pinned, { skill: 'use-vm', path: '/etc/passwd' })).toMatch(/only the skill parameter/)
    expect(admitTrustedCall('load_vm_skill', loadSkill, pinned, 'use-vm')).toMatch(/object with a single skill parameter/)
    // Fail-closed: constraints exist but the dispatch presented no arguments.
    expect(admitTrustedCall('load_vm_skill', loadSkill, pinned)).toMatch(/arguments were unavailable/)
  })

  it('refuses to pin host capabilities without constraints or unknown capability ids', () => {
    expect(() => pinTrustedCapabilities([{ capability: 'load_vm_skill', definition: loadSkill, ownerPlugin: 'a' }])).toThrow(/parameter constraints/)
    expect(() => pinTrustedCapabilities([{ capability: 'not_a_capability', definition: loadSkill, ownerPlugin: 'a' } as never])).toThrow(/not a trusted capability id/)
    expect(() => pinTrustedCapabilities([{ capability: 'vm_shell', definition: loadSkill, ownerPlugin: '' }])).toThrow(/non-empty ownerPlugin/)
  })
})

describe('in-flight ledger', () => {
  it('counts admitted executions and reaches quiescence when they settle', async () => {
    const ledger = new InFlightLedger()
    const exec = { key: Symbol('a'), name: 'host_shell' }
    const other = { key: Symbol('b'), name: 'host_fs' }
    ledger.admit(exec)
    ledger.admit(other)
    expect(ledger.inFlight()).toBe(2)
    expect(ledger.pendingNames()).toEqual(['host_shell', 'host_fs'])
    const quiescent = ledger.awaitQuiescence(new AbortController().signal, 5_000)
    ledger.settle(exec)
    expect(ledger.inFlight()).toBe(1)
    ledger.settle(other)
    await quiescent
    expect(ledger.inFlight()).toBe(0)
  })

  it('resolves immediately at quiescence and ignores unknown settlements', async () => {
    const ledger = new InFlightLedger()
    ledger.settle({ key: Symbol('never-admitted'), name: 'ghost' })
    await ledger.awaitQuiescence(new AbortController().signal, 5_000)
  })

  it('rejects when work does not settle within the budget, naming the pending calls', async () => {
    const ledger = new InFlightLedger()
    ledger.admit({ key: Symbol('a'), name: 'host_shell' })
    await expect(ledger.awaitQuiescence(new AbortController().signal, 10)).rejects.toThrow(/host_shell/)
    expect(ledger.inFlight()).toBe(1)
  })

  it('rejects a cancelled wait with the abort reason', async () => {
    const ledger = new InFlightLedger()
    ledger.admit({ key: Symbol('a'), name: 'host_shell' })
    const controller = new AbortController()
    const wait = ledger.awaitQuiescence(controller.signal, 5_000)
    controller.abort(new Error('user cancelled'))
    await expect(wait).rejects.toThrow('user cancelled')
  })

  it('rejects a cancelled wait with a non-Error abort reason as a cancellation', async () => {
    const ledger = new InFlightLedger()
    ledger.admit({ key: Symbol('a'), name: 'host_shell' })
    const controller = new AbortController()
    const wait = ledger.awaitQuiescence(controller.signal, 5_000)
    controller.abort('stop')
    await expect(wait).rejects.toThrow(/cancelled/)
  })
})

describe('final-dispatch admission decisions', () => {
  const vmShell = definition('vm_shell')
  const hostShell = definition('host_shell')
  const pinned = pinTrustedCapabilities([{ capability: 'vm_shell', definition: vmShell, ownerPlugin: '@deepseek-ai/dsh-wrapvm-isolate' }])

  function harness(mode: SafetyMode) {
    const ledger = new InFlightLedger()
    let current: SafetyMode = mode
    const admission = createProtectedAdmission(
      { mode: () => current, generation: () => 1 },
      pinned,
      ledger,
    )
    return { admission, setMode: (next: SafetyMode) => { current = next }, ledger }
  }

  const exec = (name: string): Readonly<ToolExecution> => ({ name } as ToolExecution)

  it('permits everything in normal mode', () => {
    const { admission } = harness('normal')
    expect(admission.check(exec('host_shell'), hostShell)).toEqual({ kind: 'allow' })
  })

  it('admits only pinned identities while activating or protected', () => {
    for (const mode of ['activating', 'protected'] as const) {
      const { admission } = harness(mode)
      expect(admission.check(exec('vm_shell'), vmShell)).toEqual({ kind: 'allow' })
      expect(admission.check(exec('host_shell'), hostShell)).toMatchObject({ kind: 'deny', reason: /not a trusted VM capability/ })
      expect(admission.check(exec('run_code'), definition('run_code'))).toMatchObject({ kind: 'deny', reason: /run_code/ })
    }
  })

  it('denies every tool when the environment is unavailable, without falling back', () => {
    const { admission } = harness('protected-unavailable')
    expect(admission.check(exec('vm_shell'), vmShell)).toMatchObject({ kind: 'deny', reason: /does not fall back/ })
    expect(admission.check(exec('host_shell'), hostShell)).toMatchObject({ kind: 'deny', reason: /does not fall back/ })
  })

  it('pairs admitted and settled executions through the ledger', () => {
    const { admission, ledger } = harness('protected')
    const token = Symbol('exec')
    admission.admitted({ token, name: 'vm_shell' } as ToolExecution)
    expect(ledger.inFlight()).toBe(1)
    admission.settled({ token, name: 'vm_shell' } as ToolExecution)
    expect(ledger.inFlight()).toBe(0)
  })

  it('evaluates pinned parameter constraints at final dispatch', () => {
    const loadSkill = definition('load_vm_skill')
    const admission = createProtectedAdmission(
      { mode: () => 'protected', generation: () => 1 },
      pinTrustedCapabilities([{ capability: 'load_vm_skill', definition: loadSkill, ownerPlugin: 'p', constraints: bundledSkillConstraints(['use-vm']) }]),
      new InFlightLedger(),
    )
    expect(admission.check({ name: 'load_vm_skill', arguments: { skill: 'use-vm' } } as ToolExecution, loadSkill)).toEqual({ kind: 'allow' })
    expect(admission.check({ name: 'load_vm_skill', arguments: { skill: 'host-secret-skill' } } as ToolExecution, loadSkill))
      .toMatchObject({ kind: 'deny', reason: /distributed with the Wrapvm bundle/ })
    expect(admission.check({ name: 'load_vm_skill', arguments: {} } as ToolExecution, loadSkill))
      .toMatchObject({ kind: 'deny', reason: /arguments were unavailable/ })
  })

  it('decides identity from the dispatched definition, never a provider-side re-lookup', () => {
    const vmShell = definition('vm_shell')
    const admission = createProtectedAdmission(
      { mode: () => 'protected', generation: () => 1 },
      pinTrustedCapabilities([{ capability: 'vm_shell', definition: vmShell, ownerPlugin: 'p' }]),
    )
    // The dispatch hands the exact definition; identity is decided from it alone.
    expect(admission.check({ name: 'vm_shell', arguments: {} } as ToolExecution, vmShell)).toEqual({ kind: 'allow' })
    // A dispatch that presents no definition denies fail-closed: the provider
    // has NO fixture lookup and never re-resolves identity itself.
    expect(admission.check({ name: 'vm_shell', arguments: {} } as ToolExecution, undefined))
      .toMatchObject({ kind: 'deny', reason: /not available in protected mode/ })
    // A shadowed registration behind the trusted name is denied.
    expect(admission.check({ name: 'vm_shell', arguments: {} } as ToolExecution, definition('vm_shell')))
      .toMatchObject({ kind: 'deny', reason: /does not match the pinned/ })
    // The factory signature is (state, pinned, ledger?) — the fixture-only
    // lookup parameter is gone from the production API.
    expect(createProtectedAdmission.length).toBe(3)
  })
})

describe('one-shot host grants', () => {
  const importTool = definition('host_import')
  const base = {
    operation: 'import-file' as const,
    toolName: 'host_import',
    toolDefinition: importTool,
    parameters: { path: '/Users/u/in.csv' },
    sessionKey: 'session-1',
    agentId: 'agent-1',
    generation: 3,
    expiresAt: 1_000,
  }
  const attempt = (overrides: Partial<GrantAttempt> = {}): GrantAttempt => ({
    grantId: 'grant-1',
    operation: 'import-file',
    toolName: 'host_import',
    toolDefinition: importTool,
    parameters: { path: '/Users/u/in.csv' },
    sessionKey: 'session-1',
    agentId: 'agent-1',
    generation: 3,
    now: 500,
    ...overrides,
  })

  it('consumes at most once across racing attempts', async () => {
    const ledger = new GrantLedger()
    ledger.issue(base)
    const [first, second] = await Promise.all([
      Promise.resolve(ledger.consume(attempt())),
      Promise.resolve(ledger.consume(attempt())),
    ])
    const consumed = [first, second].filter(outcome => outcome.kind === 'consumed')
    expect(consumed).toHaveLength(1)
    expect(ledger.isOutstanding('grant-1')).toBe(false)
  })

  it('refuses changed parameters, requiring a new approval', () => {
    const ledger = new GrantLedger()
    ledger.issue(base)
    expect(ledger.consume(attempt({ parameters: { path: '/Users/u/other.csv' } }))).toMatchObject({ kind: 'refused', reason: /parameters/ })
    expect(ledger.consume(attempt({ parameters: { path: '/Users/u/in.csv', extra: true } }))).toMatchObject({ kind: 'refused', reason: /parameters/ })
    expect(ledger.consume(attempt())).toMatchObject({ kind: 'consumed' })
  })

  it('binds the grant to operation, tool, conversation, agent, and generation', () => {
    const ledger = new GrantLedger()
    ledger.issue(base)
    expect(ledger.consume(attempt({ operation: 'export-file' }))).toMatchObject({ kind: 'refused', reason: /operation/ })
    expect(ledger.consume(attempt({ toolName: 'host_shell' }))).toMatchObject({ kind: 'refused', reason: /tool/ })
    expect(ledger.consume(attempt({ sessionKey: 'session-2' }))).toMatchObject({ kind: 'refused', reason: /conversation/ })
    expect(ledger.consume(attempt({ agentId: 'agent-2' }))).toMatchObject({ kind: 'refused', reason: /agent/ })
    expect(ledger.consume(attempt({ generation: 4 }))).toMatchObject({ kind: 'refused', reason: /generation/ })
    expect(ledger.isOutstanding('grant-1')).toBe(true)
  })

  it('refuses expired, revoked, and unknown grants', () => {
    const ledger = new GrantLedger()
    ledger.issue(base)
    expect(ledger.consume(attempt({ now: 2_000 }))).toMatchObject({ kind: 'refused', reason: /expired/ })
    const other = ledger.issue({ ...base, expiresAt: 10_000 })
    ledger.revoke(other.id)
    expect(ledger.consume(attempt({ grantId: other.id }))).toMatchObject({ kind: 'refused', reason: /revoked/ })
    expect(ledger.consume(attempt({ grantId: 'grant-99' }))).toMatchObject({ kind: 'refused', reason: /unknown grant/ })
  })

  it('never recovers unconsumed approvals after a restart', () => {
    const ledger = new GrantLedger()
    const grant = ledger.issue(base)
    ledger.dropUnconsumed()
    expect(ledger.consume(attempt())).toMatchObject({ kind: 'refused', reason: /revoked/ })
    expect(ledger.isOutstanding(grant.id)).toBe(false)
  })

  it('snapshots approved parameters defensively against later mutation', () => {
    const ledger = new GrantLedger()
    const approved: { path: string } = { path: '/approved' }
    const grant = ledger.issue({ ...base, parameters: approved })
    // The caller mutates the object it passed to issue() after approval: the
    // approved snapshot must not alias it.
    approved.path = '/changed'
    expect(grant.parameters.path).toBe('/approved')
    expect(ledger.consume(attempt({ parameters: { path: '/changed' } }))).toMatchObject({ kind: 'refused', reason: /parameters/ })
    expect(ledger.consume(attempt({ parameters: { path: '/approved' } }))).toMatchObject({ kind: 'consumed' })
  })

  it('freezes the issued grant so consumers cannot rewrite the approval', () => {
    const ledger = new GrantLedger()
    const grant = ledger.issue(base)
    expect(Object.isFrozen(grant)).toBe(true)
    expect(Object.isFrozen(grant.parameters)).toBe(true)
    expect(() => {
      ;(grant.parameters as { path: string }).path = '/changed'
    }).toThrow()
  })

  it('requires the exact trusted tool definition identity, not just the name', () => {
    const ledger = new GrantLedger()
    ledger.issue(base)
    // Same name, different registration object (shadowed/replaced): refused.
    expect(ledger.consume(attempt({ toolDefinition: definition('host_import') }))).toMatchObject({ kind: 'refused', reason: /tool/ })
    // Name resolves to nothing at final dispatch: refused fail-closed.
    expect(ledger.consume(attempt({ toolDefinition: undefined }))).toMatchObject({ kind: 'refused', reason: /tool/ })
    expect(ledger.consume(attempt())).toMatchObject({ kind: 'consumed' })
  })

  it('rejects non-flat parameters and non-grantable operations at the boundary', () => {
    const ledger = new GrantLedger()
    expect(() => ledger.issue({ ...base, parameters: { nested: { path: '/x' } } as never })).toThrow(/flat JSON scalar/)
    expect(() => ledger.issue({ ...base, operation: 'host-shell' as never })).toThrow(/never grantable/)
    expect(() => ledger.issue({ ...base, generation: 1.5 })).toThrow(/safe-integer/)
    ledger.issue(base)
    expect(ledger.consume(attempt({ parameters: { path: ['/Users/u/in.csv'] } as never }))).toMatchObject({ kind: 'refused', reason: /flat snapshot/ })
    expect(ledger.isOutstanding('grant-1')).toBe(true)
  })
})

describe('durable projection', () => {
  const events = (...items: WrapvmSessionEvent[]): WrapvmSessionEvent[] => items

  it('projects normal for a never-protected conversation', () => {
    expect(projectWrapvmPolicy('s1', events())).toEqual({
      record: { sessionKey: 's1', mode: 'normal', generation: 0, stage: 'idle' },
    })
  })

  it('keeps admission closed for an activation intent without a commit', () => {
    const projected = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
    ))
    expect(projected.record.mode).toBe('activating')
    expect(blocksHostWork(projected.record.mode)).toBe(true)
  })

  it('commits protection with the bound environment', () => {
    const projected = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
    ))
    expect(projected.record).toEqual({ sessionKey: 's1', mode: 'protected', generation: 1, stage: 'idle', environmentId: 'env-1' })
  })

  it('keeps protection closed across environment loss and recovery', () => {
    const lost = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/environment-lost', generation: 1 },
    ))
    expect(lost.record.mode).toBe('protected-unavailable')
    const restored = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/environment-lost', generation: 1 },
      { type: 'wrapvm/environment-restored', generation: 1 },
    ))
    expect(restored.record.mode).toBe('protected')
  })

  it('resets environment loss for a new activation cycle after a release (full replay)', () => {
    // activation1 -> commit1 -> lost1 -> release1 -> activation3 -> commit3:
    // the loss of env-1 belongs to the released cycle and must NOT keep the
    // freshly committed environment 3 protected-unavailable.
    const replayed = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/environment-lost', generation: 1 },
      { type: 'wrapvm/policy-released', generation: 1 },
      { type: 'wrapvm/activation-requested', generation: 3, source: 'button', requestedAt: 1 },
      { type: 'wrapvm/policy-committed', generation: 3, environmentId: 'env-3' },
    ))
    expect(replayed).toEqual({
      record: { sessionKey: 's1', mode: 'protected', generation: 3, stage: 'idle', environmentId: 'env-3' },
    })
    // A new cycle that has not committed yet carries no stale environment or
    // loss from the previous cycle.
    const midCycle = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/environment-lost', generation: 1 },
      { type: 'wrapvm/policy-released', generation: 1 },
      { type: 'wrapvm/activation-requested', generation: 3, source: 'button', requestedAt: 1 },
    ))
    expect(midCycle.record.mode).toBe('activating')
    expect(midCycle.record.environmentId).toBeUndefined()
  })

  it('restores normal only through a user release at the current generation', () => {
    const released = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/grant-consumed', generation: 1, grantId: 'grant-1' },
      { type: 'wrapvm/policy-released', generation: 1 },
    ))
    expect(released.record.mode).toBe('normal')
    expect(released.record.generation).toBe(2)
  })

  it('fails closed on a commit without a matching activation', () => {
    const projected = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/policy-committed', generation: 7, environmentId: 'env-1' },
    ))
    expect(projected.record.mode).toBe('protected-unavailable')
    expect(projected.invalid).toMatch(/no matching activation/)
  })

  it('fails closed on a stale release and on generation gaps', () => {
    const stale = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/policy-released', generation: 1 },
      { type: 'wrapvm/policy-released', generation: 1 },
    ))
    expect(stale.record.mode).toBe('protected-unavailable')
    expect(stale.invalid).toMatch(/policy-released/)
    const gap = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 2, source: 'command', requestedAt: 0 },
    ))
    expect(gap.record.mode).toBe('protected-unavailable')
  })

  it('fails closed on an event type the projection does not know', () => {
    const hostile = JSON.parse('{"type":"wrapvm/evil","generation":1}') as WrapvmSessionEvent
    const projected = projectWrapvmPolicy('s1', events(hostile))
    expect(projected.record.mode).toBe('protected-unavailable')
    expect(projected.invalid).toMatch(/unknown protection event/)
  })

  it('fails closed on a second policy-committed at the same generation', () => {
    // A second commit at generation 1 must NOT silently rebind A -> B without
    // any activation: the log is corrupt, so the fold fails closed.
    const projected = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-A' },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-B' },
    ))
    expect(projected.record.mode).toBe('protected-unavailable')
    expect(projected.invalid).toMatch(/duplicate policy-committed/)
    expect(projected.record.environmentId).toBeUndefined()
  })

  it('fails closed on malformed generations and payloads', () => {
    for (const generation of [1.5, 2 ** 53, '1', 0, -1]) {
      const projected = projectWrapvmPolicy('s1', events(
        { type: 'wrapvm/activation-requested', generation, source: 'command', requestedAt: 0 } as unknown as WrapvmSessionEvent,
      ))
      expect(projected.record.mode, String(generation)).toBe('protected-unavailable')
      expect(projected.invalid, String(generation)).toMatch(/safe integer/)
    }
    const badCommit = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1 } as unknown as WrapvmSessionEvent,
    ))
    expect(badCommit.invalid).toMatch(/environmentId/)
    const badSource = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'model-text', requestedAt: 0 } as unknown as WrapvmSessionEvent,
    ))
    expect(badSource.invalid).toMatch(/source/)
    const badGrant = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/grant-consumed', generation: 1 } as unknown as WrapvmSessionEvent,
    ))
    expect(badGrant.invalid).toMatch(/grantId/)
  })

  it('fails closed on environment events without a commit but accepts an armed-generation release', () => {
    const lost = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/environment-lost', generation: 1 },
    ))
    expect(lost.invalid).toMatch(/without a commit/)
    // Regression (Sol review P1): an authenticated release at the ARMED
    // generation is legitimate even without a commit (exit after a failed
    // precommit barrier); only stale or unknown generations are corrupt.
    const released = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-released', generation: 1 },
    ))
    expect(released).toEqual({ record: { sessionKey: 's1', mode: 'normal', generation: 2, stage: 'idle' } })
    const unknown = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-released', generation: 2 },
    ))
    expect(unknown.record.mode).toBe('protected-unavailable')
    expect(unknown.invalid).toMatch(/policy-released/)
  })

  it('never restores normal once the log is corrupt, regardless of later events', () => {
    const projected = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
      { type: 'wrapvm/evil', generation: 1 } as unknown as WrapvmSessionEvent,
      { type: 'wrapvm/policy-released', generation: 2 },
    ))
    expect(projected.record.mode).toBe('protected-unavailable')
    expect(projected.invalid).toMatch(/unknown protection event/)
  })

  it('degrades a projected record when a restore-time probe fails', () => {
    const degraded = degradeToUnavailable({ sessionKey: 's1', mode: 'protected', generation: 1, stage: 'idle', environmentId: 'env-1' })
    expect(degraded.mode).toBe('protected-unavailable')
    expect(degraded.stage).toBe('blocked')
    const alreadyBlocked = degradeToUnavailable({ sessionKey: 's1', mode: 'activating', generation: 1, stage: 'awaiting-quiescence' })
    expect(alreadyBlocked.stage).toBe('awaiting-quiescence')
  })

  it('inherits the restriction into forks without transferring environment ownership', () => {
    const parent = projectWrapvmPolicy('s1', events(
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 0 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
    ))
    const child = inheritProjection(parent, 's2')
    expect(child.record).toEqual({ sessionKey: 's2', mode: 'protected-unavailable', generation: 1, stage: 'blocked' })
    expect(inheritProjection({ record: { sessionKey: 's1', mode: 'normal', generation: 0, stage: 'idle' } }, 's3').record.mode).toBe('normal')
    const invalidParent = projectWrapvmPolicy('s1', events({ type: 'wrapvm/policy-committed', generation: 7, environmentId: 'env-1' }))
    expect(inheritProjection(invalidParent, 's4').invalid).toMatch(/no matching activation/)
  })
})

describe('deterministic activation', () => {
  type FailingPort = 'arm' | 'persistIntent' | 'awaitQuiescence' | 'bindEnvironment' | 'verifyEnvironment' | 'commit'
  interface PortFailure { kind: 'reject' | 'throw'; value: unknown }

  interface Harness {
    controller: VmActivationController
    ledger: InFlightLedger
    armed: { sessionKey: string; generation: number; mode: string; stage: string }[]
    committed: [string, number, string][]
    intents: { sessionKey: string; generation: number; source: string }[]
    bindCalls: number
    succeedBind: (environmentId: string) => void
    failBind: (error: Error) => void
    succeedVerify: () => void
    failVerify: (error: Error) => void
    succeedCommit: () => void
    failCommitLate: (error: Error) => void
  }

  function harness(options: {
    quiescenceTimeoutMs?: number
    failArm?: Error
    failIntent?: Error
    failCommit?: Error
    throwVerify?: Error
    /** Hold the commit port pending until succeedCommit/failCommitLate. */
    gateCommit?: boolean
    /** Quiescence port that never settles and ignores its signal. */
    hangQuiescence?: boolean
    failPort?: { port: FailingPort; failure: PortFailure }
  } = {}): Harness {
    const ledger = new InFlightLedger()
    const armed: Harness['armed'] = []
    const committed: [string, number, string][] = []
    const intents: Harness['intents'] = []
    let bindCalls = 0
    let settleBind!: (result: string | PromiseLike<string>) => void
    let settleVerify!: (result: void | PromiseLike<void>) => void
    let rejectBind!: (error: Error) => void
    let rejectVerify!: (error: Error) => void
    let settleCommit!: () => void
    let rejectCommit!: (error: Error) => void
    const bindGate = new Promise<string>((resolve, reject) => {
      settleBind = resolve
      rejectBind = reject
    })
    const verifyGate = new Promise<void>((resolve, reject) => {
      settleVerify = resolve
      rejectVerify = reject
    })
    const commitGate = new Promise<void>((resolve, reject) => {
      settleCommit = () => resolve()
      rejectCommit = reject
    })
    const portFailure = (port: FailingPort): PortFailure | undefined =>
      options.failPort?.port === port ? options.failPort.failure : undefined
    /** Synchronous throw or promise rejection, per the failure kind. */
    const raise = (failure: PortFailure): Promise<never> => {
      if (failure.kind === 'throw') throw failure.value
      return Promise.reject(failure.value)
    }
    const ports: ActivationPorts = {
      arm: record => {
        armed.push({ sessionKey: record.sessionKey, generation: record.generation, mode: record.mode, stage: record.stage })
        const failure = portFailure('arm')
        if (failure !== undefined) return raise(failure)
        return options.failArm === undefined ? Promise.resolve() : Promise.reject(options.failArm)
      },
      persistIntent: intent => {
        intents.push({ sessionKey: intent.sessionKey, generation: intent.generation, source: intent.source })
        const failure = portFailure('persistIntent')
        if (failure !== undefined) return raise(failure)
        return options.failIntent === undefined ? Promise.resolve() : Promise.reject(options.failIntent)
      },
      commit: (sessionKey, generation, environmentId) => {
        committed.push([sessionKey, generation, environmentId])
        const failure = portFailure('commit')
        if (failure !== undefined) return raise(failure)
        if (options.gateCommit === true) return commitGate
        return options.failCommit === undefined ? Promise.resolve() : Promise.reject(options.failCommit)
      },
      bindEnvironment: () => {
        bindCalls++
        const failure = portFailure('bindEnvironment')
        if (failure !== undefined) return raise(failure)
        return bindGate
      },
      verifyEnvironment: () => {
        const failure = portFailure('verifyEnvironment')
        if (failure !== undefined) return raise(failure)
        if (options.throwVerify !== undefined) throw options.throwVerify
        return verifyGate
      },
      awaitQuiescence: (_sessionKey, signal, timeoutMs) => {
        const failure = portFailure('awaitQuiescence')
        if (failure !== undefined) return raise(failure)
        if (options.hangQuiescence === true) return new Promise<void>(() => {})
        return ledger.awaitQuiescence(signal, timeoutMs)
      },
      quiescenceTimeoutMs: options.quiescenceTimeoutMs ?? 5_000,
      now: () => 0,
    }
    return {
      controller: new VmActivationController(ports),
      ledger,
      armed,
      committed,
      intents,
      get bindCalls() {
        return bindCalls
      },
      succeedBind: id => settleBind(id),
      failBind: error => rejectBind(error),
      succeedVerify: () => settleVerify(),
      failVerify: error => rejectVerify(error),
      succeedCommit: () => settleCommit(),
      failCommitLate: error => rejectCommit(error),
    }
  }

  /** Drain microtasks and timers so pending port stages are reached. */
  const flush = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('closes host admission and persists intent before returning the handle', () => {
    const h = harness()
    const handle = h.controller.request('s1', 'command')
    expect(h.armed).toEqual([{ sessionKey: 's1', generation: 1, mode: 'activating', stage: 'closing-admission' }])
    expect(h.intents).toEqual([{ sessionKey: 's1', generation: 1, source: 'command' }])
    expect(h.controller.mode('s1')).toBe('activating')
    expect(handle.generation).toBe(1)
    h.succeedBind('env-1')
    h.succeedVerify()
  })

  it('never lets vm_enter wait for its own transition', async () => {
    const h = harness()
    let transitionSettled = false
    const done = h.controller.request('s1', 'command').done.then(outcome => {
      transitionSettled = true
      return outcome
    })
    // The vm_enter tool body: request and return immediately, never await done.
    const toolBodyRan = (async () => h.controller.request('s1', 'model-tool'))()
    const handle = await toolBodyRan
    expect(transitionSettled).toBe(false)
    h.succeedBind('env-1')
    h.succeedVerify()
    expect((await done).mode).toBe('protected')
    expect(handle.done).toBeInstanceOf(Promise)
    expect(h.committed).toEqual([['s1', 1, 'env-1']])
  })

  it('refuses a model-tool activation with no deterministic transition running', async () => {
    const h = harness()
    const outcome = await h.controller.request('s1', 'model-tool').done
    expect(outcome.stage).toBe('blocked')
    expect(outcome.reason).toMatch(/\/use-vm/)
    expect(h.armed).toEqual([])
  })

  it('blocks activation when host work cannot be proven concluded', async () => {
    const h = harness({ quiescenceTimeoutMs: 10 })
    h.ledger.admit({ key: Symbol('inflight'), name: 'host_shell' })
    const outcome = await h.controller.request('s1', 'command').done
    expect(outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /host_shell/ })
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
  })

  it('blocks and stays closed when environment binding fails', async () => {
    const h = harness()
    const outcome = h.controller.request('s1', 'command').done
    h.failBind(new Error('no eligible environment'))
    expect(await outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /no eligible environment/ })
    expect(h.committed).toEqual([])
  })

  it('blocks and stays closed when guest verification fails', async () => {
    const h = harness()
    const outcome = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    h.failVerify(new Error('CDP unreachable'))
    expect(await outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /CDP unreachable/ })
    expect(h.committed).toEqual([])
  })

  it('recovers a blocked transition once the pending work settles', async () => {
    const h = harness({ quiescenceTimeoutMs: 10 })
    const pending = { key: Symbol('inflight'), name: 'host_shell' }
    h.ledger.admit(pending)
    const blocked = await h.controller.request('s1', 'command').done
    expect(blocked.stage).toBe('blocked')
    h.ledger.settle(pending)
    const recovered = h.controller.recover('s1', 'button')
    h.succeedBind('env-1')
    h.succeedVerify()
    expect((await recovered.done).mode).toBe('protected')
    expect(h.controller.mode('s1')).toBe('protected')
  })

  it('refuses a model-tool recovery of a blocked transition', async () => {
    const h = harness({ quiescenceTimeoutMs: 10 })
    const pending = { key: Symbol('inflight'), name: 'host_shell' }
    h.ledger.admit(pending)
    await h.controller.request('s1', 'command').done
    const refused = await h.controller.recover('s1', 'model-tool').done
    expect(refused).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /recovery requires/ })
    h.ledger.settle(pending)
  })

  it('returns normal for a recovery request on an unprotected conversation', async () => {
    const h = harness()
    expect((await h.controller.recover('s1', 'button').done).mode).toBe('normal')
  })

  it('restores durable projections before model work, keeping closures denied', () => {
    const h = harness()
    h.controller.restore({ sessionKey: 's1', mode: 'protected-unavailable', generation: 3, stage: 'blocked' })
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
    expect(h.controller.generation('s1')).toBe(3)
    expect(h.controller.request('s1', 'command').generation).toBe(4)
  })

  it('keeps the bound environment across a retried transition', async () => {
    const h = harness()
    const first = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    h.succeedVerify()
    expect((await first).mode).toBe('protected')
    const again = h.controller.recover('s1', 'button')
    expect((await again.done).mode).toBe('protected')
    expect(h.controller.request('s1', 'button').generation).toBe(1)
  })

  it('keeps the session blocked when the durable commit barrier fails', async () => {
    const h = harness({ failCommit: new Error('storage flush failed') })
    const outcome = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    h.succeedVerify()
    expect(await outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /durable commit failed/ })
    // A failed commit barrier never yields `protected`: the binding is not durable.
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
  })

  it('blocks without binding when the arm barrier rejects', async () => {
    const h = harness({ failArm: new Error('latch persistence unavailable') })
    const outcome = await h.controller.request('s1', 'command').done
    expect(outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /not durable/ })
    expect(h.bindCalls).toBe(0)
    expect(h.committed).toEqual([])
  })

  it('blocks when the intent persistence barrier rejects', async () => {
    const h = harness({ failIntent: new Error('append failed') })
    const outcome = await h.controller.request('s1', 'command').done
    expect(outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /activation intent is not durable/ })
    expect(h.bindCalls).toBe(0)
  })

  it('joins the running transition on recover instead of binding twice', async () => {
    const h = harness()
    const first = h.controller.request('s1', 'command')
    const again = h.controller.recover('s1', 'button')
    expect(again).toBe(first)
    h.succeedBind('env-1')
    h.succeedVerify()
    expect((await first.done).mode).toBe('protected')
    expect(h.bindCalls).toBe(1)
    expect(h.committed).toEqual([['s1', 1, 'env-1']])
  })

  it('fences a stale transition when a newer generation is restored', async () => {
    const h = harness()
    const stale = h.controller.request('s1', 'command')
    // A durable restore lands while generation 1 is suspended mid-transition.
    h.controller.restore({ sessionKey: 's1', mode: 'protected-unavailable', generation: 9, stage: 'blocked' })
    h.succeedBind('env-1')
    h.succeedVerify()
    const outcome = await stale.done
    expect(outcome.stage).toBe('blocked')
    expect(outcome.reason).toMatch(/superseded/)
    // The stale continuation must not re-protect the session at generation 1.
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
    expect(h.controller.generation('s1')).toBe(9)
    expect(h.committed).toEqual([])
  })

  // Regression (Sol review P1): a protected-unavailable restore at the SAME
  // generation is an authoritative supersession, not a reconciliation. The
  // active attempt must be invalidated even when the generation is unchanged.
  it('invalidates the running attempt when the same generation is restored protected-unavailable', async () => {
    const h = harness()
    const stale = h.controller.request('s1', 'command')
    h.controller.restore({ sessionKey: 's1', mode: 'protected-unavailable', generation: 1, stage: 'blocked' })
    h.succeedBind('env-1')
    h.succeedVerify()
    const outcome = await stale.done
    expect(outcome).toMatchObject({ stage: 'blocked', reason: /superseded/ })
    // The stale continuation may neither commit nor mark the session protected.
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
    expect(h.controller.generation('s1')).toBe(1)
    expect(h.committed).toEqual([])
  })

  it('keeps the running transition across a same-generation activating reconciliation', async () => {
    const h = harness()
    const first = h.controller.request('s1', 'command')
    // Replaying the SAME authoritative state (still armed at generation 1) is
    // reconciliation, not supersession: the transition continues.
    h.controller.restore({ sessionKey: 's1', mode: 'activating', generation: 1, stage: 'awaiting-quiescence' })
    h.succeedBind('env-1')
    h.succeedVerify()
    expect((await first.done).mode).toBe('protected')
    expect(h.committed).toEqual([['s1', 1, 'env-1']])
  })

  // Regression (Sol review P1): cleanup and fencing must compare the exact
  // attempt identity, not just the generation, so a cancelled attempt settling
  // late cannot clear the slot of a same-generation replacement.
  it('does not let a cancelled attempt clear a same-generation replacement slot', async () => {
    const h = harness()
    const old = h.controller.request('s1', 'command')
    await flush() // the old attempt is now suspended on the bind port
    expect(h.bindCalls).toBe(1)
    h.controller.restore({ sessionKey: 's1', mode: 'protected-unavailable', generation: 1, stage: 'blocked' })
    // Recovery starts a NEW attempt at the SAME generation 1.
    const next = h.controller.recover('s1', 'button')
    await flush() // the replacement attempt reaches its own bind
    expect(h.bindCalls).toBe(2)
    h.succeedBind('env-2')
    h.succeedVerify()
    expect((await old.done).reason).toMatch(/superseded/)
    expect((await next.done).mode).toBe('protected')
    expect(h.controller.mode('s1')).toBe('protected')
    expect(h.committed).toEqual([['s1', 1, 'env-2']])
    expect(h.bindCalls).toBe(2)
  })

  // Regression (Sol review P1): EVERY port rejection is a failure — including
  // falsy rejection values. undefined/null must never be conflated with
  // success by sentinel comparisons.
  const failingPorts: readonly FailingPort[] = ['arm', 'persistIntent', 'awaitQuiescence', 'bindEnvironment', 'verifyEnvironment', 'commit']
  for (const port of failingPorts) {
    for (const value of [undefined, null]) {
      const label = value === undefined ? 'undefined' : 'null'
      it(`treats a ${port} rejection with ${label} as failure, never success`, async () => {
        const h = harness({ failPort: { port, failure: { kind: 'reject', value } } })
        const outcome = h.controller.request('s1', 'command').done
        h.succeedBind('env-1')
        h.succeedVerify()
        expect(await outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
        expect(h.controller.mode('s1')).toBe('protected-unavailable')
        if (port !== 'commit') expect(h.committed).toEqual([])
      })
      it(`treats a synchronous ${port} throw of ${label} as failure, never success`, async () => {
        const h = harness({ failPort: { port, failure: { kind: 'throw', value } } })
        const outcome = h.controller.request('s1', 'command').done
        h.succeedBind('env-1')
        h.succeedVerify()
        expect(await outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
        expect(h.controller.mode('s1')).toBe('protected-unavailable')
        if (port !== 'commit') expect(h.committed).toEqual([])
      })
    }
  }

  // Regression (Sol review P1): cancellation must settle the local handle
  // promptly even when the backend port hangs, while late completions stay
  // fenced and their rejections stay consumed.
  it('settles done promptly on dispose while bind is pending, fencing its late resolve', async () => {
    const h = harness()
    const done = h.controller.request('s1', 'command').done
    await flush() // the bind port is now invoked and pending
    expect(h.bindCalls).toBe(1)
    h.controller.dispose()
    expect(await done).toMatchObject({ stage: 'blocked', reason: /superseded/ })
    // The backend bind completes only AFTER the local handle settled: the late
    // success may not commit or re-protect the session.
    h.succeedBind('env-1')
    h.succeedVerify()
    await flush()
    expect(h.committed).toEqual([])
    expect(h.controller.mode('s1')).toBe('activating')
  })

  it('consumes a late bind rejection after dispose without unhandled rejections', async () => {
    const h = harness()
    const done = h.controller.request('s1', 'command').done
    await flush()
    h.controller.dispose()
    await done
    h.failBind(new Error('late bind failure'))
    await flush()
    expect(h.controller.mode('s1')).toBe('activating')
    expect(h.committed).toEqual([])
  })

  it('settles done promptly on release while verify is pending and ignores its late failure', async () => {
    const h = harness()
    const done = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    await flush() // the verify port is now invoked and pending
    expect(h.controller.release('s1', 1)).toBe(true)
    expect(await done).toMatchObject({ mode: 'normal' })
    h.failVerify(new Error('late verify failure'))
    await flush()
    expect(h.controller.mode('s1')).toBe('normal')
    expect(h.committed).toEqual([])
  })

  it('settles done promptly on release during a pending durable commit and fences the late completion', async () => {
    const h = harness({ gateCommit: true })
    const done = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    h.succeedVerify()
    await flush() // the commit port is now invoked and pending
    expect(h.controller.release('s1', 1)).toBe(true)
    expect(await done).toMatchObject({ mode: 'normal' })
    // The durable commit effect completes AFTER the release. The controller
    // must not mark the session protected; rejecting the late durable effect
    // itself is the core-side attempt fence (see ActivationPorts.commit).
    h.succeedCommit()
    await flush()
    expect(h.controller.mode('s1')).toBe('normal')
    expect(h.controller.generation('s1')).toBe(2)
  })

  it('consumes a late commit rejection after dispose without unhandled rejections', async () => {
    const h = harness({ gateCommit: true })
    const done = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    h.succeedVerify()
    await flush()
    h.controller.dispose()
    await done
    h.failCommitLate(new Error('late flush failure'))
    await flush()
    expect(h.controller.mode('s1')).toBe('activating')
  })

  it('settles done promptly on dispose when the quiescence port hangs ignoring its signal', async () => {
    const h = harness({ hangQuiescence: true })
    const done = h.controller.request('s1', 'command').done
    h.controller.dispose()
    expect(await done).toMatchObject({ stage: 'blocked', reason: /superseded/ })
  })

  it('cancels a running transition on release and refuses its stale completion', async () => {
    const h = harness()
    const stale = h.controller.request('s1', 'command')
    expect(h.controller.release('s1', 1)).toBe(true)
    expect(h.controller.mode('s1')).toBe('normal')
    h.succeedBind('env-1')
    h.succeedVerify()
    expect((await stale.done).mode).toBe('normal')
    expect(h.committed).toEqual([])
    // A stale release is refused; a fresh activation starts at the bumped generation.
    expect(h.controller.release('s1', 1)).toBe(false)
    expect(h.controller.generation('s1')).toBe(2)
  })

  it('resolves every running handle on dispose without rejecting', async () => {
    const h = harness()
    const running = h.controller.request('s1', 'command')
    h.controller.dispose()
    const outcome = await running.done
    expect(outcome.stage).toBe('blocked')
    expect(outcome.reason).toMatch(/superseded/)
  })

  it('never rejects done when a port throws synchronously', async () => {
    const h = harness({ throwVerify: new Error('verify exploded') })
    const outcome = h.controller.request('s1', 'command').done
    h.succeedBind('env-1')
    expect(await outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /verify exploded/ })
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
  })

  it('ignores a stale restore that would downgrade protection', () => {
    const h = harness()
    h.controller.restore({ sessionKey: 's1', mode: 'protected', generation: 5, stage: 'idle', environmentId: 'env-9' })
    h.controller.restore({ sessionKey: 's1', mode: 'normal', generation: 4, stage: 'idle' })
    expect(h.controller.mode('s1')).toBe('protected')
    expect(h.controller.generation('s1')).toBe(5)
  })

  it('refuses recovery without a durable activation intent', async () => {
    const h = harness()
    h.controller.restore({ sessionKey: 's1', mode: 'protected-unavailable', generation: 0, stage: 'blocked' })
    const outcome = await h.controller.recover('s1', 'button').done
    expect(outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /no durable activation intent/ })
  })
})

describe('environment eligibility', () => {
  const descriptor = (mounts: EnvironmentDescriptor['mounts']): EnvironmentDescriptor => ({
    id: 'env-1' as EnvironmentDescriptor['id'],
    backend: 'docker',
    containerId: 'abc123',
    ownership: 'plugin',
    image: 'ghcr.io/tobi/wrapvm:desktop',
    digest: 'sha256:0',
    createdAt: 0,
    mounts,
    limits: { cpuMillis: 2_000, memoryBytes: 4 << 30 },
    internetAccess: true,
  })
  const health = (overrides: Partial<EnvironmentHealth> = {}): EnvironmentHealth => ({
    phase: 'running',
    shell: { kind: 'available' },
    browser: { kind: 'available' },
    desktop: { kind: 'available' },
    hostControlPlane: { kind: 'unavailable' },
    ...overrides,
  })

  it('refuses environments that are not running', () => {
    expect(protectedModeRefusal(descriptor([]), health({ phase: 'paused' }))).toMatch(/paused/)
  })

  it('refuses guests that can reach a host control plane, including unknown reachability', () => {
    expect(protectedModeRefusal(descriptor([]), health({ hostControlPlane: { kind: 'available' } }))).toMatch(/control-plane/)
    expect(protectedModeRefusal(descriptor([]), health({ hostControlPlane: { kind: 'unknown', reason: 'not probed' } }))).toMatch(/control-plane/)
  })

  it('refuses host mounts that expose control paths', () => {
    for (const hostPath of ['/', '/Users/alice', '/etc', '/etc/x', '/var/lib', '~']) {
      expect(protectedModeRefusal(descriptor([{ hostPath, guestPath: '/mnt/x', access: 'read-only' }]), health()), hostPath).toMatch(/not allowed/)
    }
  })

  it('admits a running, control-plane-isolated environment with a chosen mount', () => {
    expect(protectedModeRefusal(descriptor([{ hostPath: '/home/user/shared', guestPath: '/mnt/shared', access: 'read-write' }]), health())).toBeUndefined()
  })
})