/**
 * Lifecycle manager tests against a scripted driver: serialized mutations,
 * idempotency dedup, busy leases, captured targets, crash recovery,
 * bind conflicts, and the removal preview flow. No Docker involved.
 */
import { describe, expect, it } from 'vitest'
import { EnvironmentManager, ExecutionLeaseRegistry, type ExecutionLedger } from '../src/lifecycle.ts'
import type { EnvironmentBackendDriver, EnvironmentDescriptor, EnvironmentId, EnvironmentOperation, EnvironmentTarget, TargetAcquisition, TargetVerification } from '../src/environments.ts'
import { Inventory, MemoryInventoryStore } from '../src/inventory.ts'
import { BindingRegistry, MemoryBindingEventSink } from '../src/binding.ts'
import { descriptorFor, env1, env2, fakeMountContext } from './fixtures/env-fixtures.ts'

/** Driver double: records operations, optionally gated by a deferred. */
function fakeDriver(behavior: (operation: EnvironmentOperation) => Promise<EnvironmentOperation> | EnvironmentOperation = op => ({ ...op, state: 'completed', settledAt: 2000 })) {
  const runs: EnvironmentOperation[] = []
  let report: { unregistered: readonly EnvironmentDescriptor[] } | undefined
  const driver: EnvironmentBackendDriver & { reconciliationReport?: { unregistered: readonly EnvironmentDescriptor[] } } = {
    get reconciliationReport() {
      return report
    },
    async reconcile() {
      return []
    },
    async run(operation) {
      runs.push(operation)
      return await behavior(operation)
    },
    async probe(target: EnvironmentTarget) {
      return { phase: 'running', shell: { kind: 'available' }, browser: { kind: 'available' }, desktop: { kind: 'available' }, hostControlPlane: { kind: 'unavailable' }, target }
    },
    // The manager refuses targeted mutations without verified acquisition:
    // this double answers as the real backend would for an owned container.
    async captureTarget(environmentId: EnvironmentId): Promise<TargetAcquisition> {
      return {
        kind: 'captured',
        target: {
          environmentId,
          containerId: 'container-1',
          containerName: `dsh-wrapvm-${environmentId}`,
          networkName: `dsh-wrapvm-${environmentId}`,
          volumeName: `dsh-wrapvm-${environmentId}-data`,
          ports: { viewerPort: 55000, cdpPort: 55001 },
          imageDigest: 'sha256:aaaabbbbccccdddd',
          capturedAt: 1500,
        },
      }
    },
    async verifyTarget(): Promise<TargetVerification> {
      return { container: { kind: 'owned' }, network: { kind: 'owned' }, volume: { kind: 'owned' } }
    },
  }
  return { driver, runs, setReport: (value: { unregistered: readonly EnvironmentDescriptor[] }) => { report = value } }
}

async function makeManager(options: {
  driver?: ReturnType<typeof fakeDriver>
  executions?: ExecutionLedger
  records?: EnvironmentDescriptor[]
  budget?: { totalCpuMillis: number; totalMemoryBytes: number }
} = {}) {
  const store = new MemoryInventoryStore()
  const inventory = new Inventory(store)
  await inventory.initialize()
  const bindings = new BindingRegistry(new MemoryBindingEventSink())
  bindings.markComplete()
  const driver = options.driver ?? fakeDriver()
  const manager = new EnvironmentManager({
    inventory,
    driver: driver.driver,
    bindings,
    mountPolicy: fakeMountContext({ approvedRoots: ['/Users/tester/projects'] }),
    budget: options.budget ?? { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
    executions: options.executions ?? new ExecutionLeaseRegistry(),
    now: () => 1500,
  })
  return { manager, inventory, store, bindings, driver }
}

const createInput = {
  displayName: 'Primary',
  image: 'ghcr.io/tobi/wrapvm:desktop',
  limits: { cpuMillis: 2_000, memoryBytes: 4 * 2 ** 30 },
  internetAccess: true,
  mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' as const }],
  ports: { viewerPort: 55000, cdpPort: 55001 },
}

const signal = () => new AbortController().signal

describe('create flow', () => {
  it('rejects offline desktop before allocating or reserving resources', async () => {
    const { manager, inventory, driver } = await makeManager()
    await manager.initialize(signal())
    const result = await manager.create({ ...createInput, internetAccess: false })
    expect(result.state).toBe('failed')
    expect(result.errorCode).toBe('unsupported-network')
    expect(driver.runs).toHaveLength(0)
    expect(inventory.allOperations()).toHaveLength(0)
  })

  it('persists the descriptor and the completed operation', async () => {
    const { manager, inventory, driver } = await makeManager({
      driver: fakeDriver(op => ({
        ...op,
        state: 'completed',
        settledAt: 2000,
        target: { environmentId: op.environmentId, containerId: 'container-new', containerName: 'dsh-wrapvm-env-abc', networkName: 'dsh-wrapvm-env-abc', volumeName: 'dsh-wrapvm-env-abc-data', ports: { viewerPort: 55000, cdpPort: 55001 }, imageDigest: 'sha256:deadbeef', capturedAt: 1500 },
      })),
    })
    await manager.initialize(signal())
    const settled = await manager.create(createInput, { idempotencyKey: 'create-1' })
    expect(settled.state).toBe('completed')
    const records = inventory.list()
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.ownership).toBe('plugin')
    expect(record.containerId).toBe('container-new')
    expect(record.digest).toBe('sha256:deadbeef')
    expect(record.desiredPhase).toBe('running')
    expect(record.displayName).toBe('Primary')
    expect(manager.operation(settled.id)?.state).toBe('completed')
    expect(driver.runs.map(op => op.state)).toContain('running')
  })

  it('deduplicates concurrent creates sharing an idempotency key', async () => {
    const { manager, driver } = await makeManager({ driver: fakeDriver(op => ({ ...op, state: 'completed', target: { environmentId: op.environmentId, containerId: 'container-1', containerName: `dsh-wrapvm-${op.environmentId}`, networkName: `dsh-wrapvm-${op.environmentId}`, volumeName: `dsh-wrapvm-${op.environmentId}-data`, ports: { viewerPort: 55000, cdpPort: 55001 }, capturedAt: 1500 } })) })
    await manager.initialize(signal())
    const [first, second] = await Promise.all([
      manager.create(createInput, { idempotencyKey: 'same-key' }),
      manager.create(createInput, { idempotencyKey: 'same-key' }),
    ])
    expect(driver.runs.filter(op => op.kind === 'create')).toHaveLength(1)
    expect(first.id).toBe(second.id)
  })

  it('refuses creation beyond the host budget with an explicit error', async () => {
    const { manager, driver } = await makeManager({ budget: { totalCpuMillis: 1_000, totalMemoryBytes: 2 ** 30 } })
    await manager.initialize(signal())
    const settled = await manager.create(createInput)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('budget-exceeded')
    expect(settled.error).toMatch(/CPU budget/)
    expect(driver.runs).toHaveLength(0)
  })
})

describe('serialization and captured targets', () => {
  it('runs mutations one at a time', async () => {
    let releaseFirst: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const { manager, inventory, driver } = await makeManager({
      driver: fakeDriver(async op => {
        if (op.kind === 'stop') await gate
        return { ...op, state: 'completed', settledAt: 2000 }
      }),
    })
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    const slow = manager.stop(env1)
    const fast = manager.pause(env1)
    // Let the stop reach the gated driver call before asserting.
    await new Promise(resolve => setTimeout(resolve, 10))
    // While the stop is gated, the pause must not have reached the driver.
    expect(driver.runs.filter(op => op.state === 'running').length).toBe(1)
    releaseFirst!()
    await Promise.all([slow, fast])
    expect(driver.runs.filter(op => op.kind === 'stop')).toHaveLength(1)
    expect(driver.runs.filter(op => op.kind === 'pause')).toHaveLength(1)
  })

  it('keeps the captured target when the binding changes mid-flight', async () => {
    let releaseStop: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseStop = resolve })
    const { manager, inventory, bindings, driver } = await makeManager({
      driver: fakeDriver(async op => {
        if (op.kind === 'stop') await gate
        return { ...op, state: 'completed', settledAt: 2000 }
      }),
    })
    await inventory.putDescriptor(descriptorFor(env1))
    await inventory.putDescriptor(descriptorFor(env2, { containerId: 'container-2' }))
    await manager.initialize(signal())
    await bindings.bind('session-a', env1, 1)
    const stopping = manager.stop(env1, { userAction: true })
    // Rebinding waits until the mutation's binding admission is settled.
    const rebind = bindings.bind('session-a', env2, 2)
    releaseStop!()
    const settled = await stopping
    await rebind
    expect(settled.target?.containerId).toBe('container-1')
    expect(driver.runs.find(op => op.kind === 'stop' && op.state === 'running')?.target?.containerId).toBe('container-1')
    expect(manager.binding('session-a')?.environmentId).toBe(env2)
  })
})

describe('busy leases', () => {
  const ledger = (count: number, names: string[]): ExecutionLedger => ({
    acquireExecution: async () => () => {},
    withMutation: async (_id, override, job) => count > 0 && !override ? { kind: 'busy', names } : { kind: 'executed', value: await job() },
  })

  it('refuses stop while executions are active', async () => {
    const { manager, inventory, driver } = await makeManager({ executions: ledger(2, ['vm_shell']) })
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    const settled = await manager.stop(env1)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('busy')
    expect(settled.error).toMatch(/vm_shell/)
    expect(driver.runs).toHaveLength(0)
  })

  it('allows an explicit user action to override the lease', async () => {
    const { manager, inventory, driver } = await makeManager({ executions: ledger(1, ['vm_shell']) })
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    const settled = await manager.stop(env1, { userAction: true })
    expect(settled.state).toBe('completed')
    expect(driver.runs).toHaveLength(1)
  })

  it('gates start and resume on an active lease', async () => {
    const { manager, inventory, driver } = await makeManager({ executions: ledger(1, ['vm_shell']) })
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    expect((await manager.start(env1)).errorCode).toBe('busy')
    expect((await manager.resume(env1)).errorCode).toBe('busy')
    expect(driver.runs).toHaveLength(0)
  })
})

describe('pause keeps RAM and is never auto-resumed', () => {
  it('records the paused desired phase and reconciliation does not unpause', async () => {
    const { manager, inventory, driver } = await makeManager()
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    const settled = await manager.pause(env1)
    expect(settled.state).toBe('completed')
    expect(inventory.get(env1)?.desiredPhase).toBe('paused')
    // A later reconciliation pass must not issue any unpause/start.
    await manager.initialize(signal())
    expect(driver.runs.some(op => op.kind === 'resume' || op.kind === 'start')).toBe(false)
    expect(inventory.get(env1)?.desiredPhase).toBe('paused')
  })
})

describe('crash recovery', () => {
  const crashedIntent = {
    displayName: 'Crashed create',
    image: 'ghcr.io/tobi/wrapvm:desktop',
    limits: { cpuMillis: 2_000, memoryBytes: 4 * 2 ** 30 },
    internetAccess: false,
    mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' as const }],
  }

  it('recovers the persisted create intent only after explicit request', async () => {
    const store = new MemoryInventoryStore()
    const inventory = new Inventory(store)
    await inventory.initialize()
    // Simulate the crash: the create operation is durable as "running" WITH
    // its persisted intent, but the descriptor never landed.
    await inventory.putOperation({ id: 'op-crashed', environmentId: env1, kind: 'create', state: 'running', requestedAt: 1000, payload: { kind: 'create', input: crashedIntent } })
    const driver = fakeDriver(op => ({ ...op, state: 'completed', target: { environmentId: op.environmentId, containerId: 'container-1', containerName: `dsh-wrapvm-${op.environmentId}`, networkName: `dsh-wrapvm-${op.environmentId}`, volumeName: `dsh-wrapvm-${op.environmentId}-data`, ports: { viewerPort: 55000, cdpPort: 55001 }, capturedAt: 1500 } }))
    driver.setReport({ unregistered: [descriptorFor(env1)] })
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
  bindings.markComplete()
    const manager = new EnvironmentManager({
      inventory,
      driver: driver.driver,
      bindings,
      mountPolicy: fakeMountContext(),
      budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
      now: () => 1500,
    })
    await manager.initialize(signal())
    expect(inventory.operation('op-crashed')?.errorCode).toBe('recovery-required')
    expect(driver.runs).toHaveLength(0)
    expect((await manager.recoverCreate('op-crashed')).state).toBe('completed')
    const record = inventory.get(env1)
    expect(record?.ownership).toBe('plugin')
    // The adopted descriptor preserves the FULL persisted intent — mounts,
    // limits, and the internet flag are never blindly reconstructed as empty.
    expect(record?.mounts).toEqual(crashedIntent.mounts)
    expect(record?.limits).toEqual(crashedIntent.limits)
    expect(record?.internetAccess).toBe(false)
    expect(record?.displayName).toBe('Crashed create')
    // The container identity comes from the reconciliation observation.
    expect(record?.containerId).toBe('container-1')
    expect(inventory.operation('op-crashed')?.state).toBe('completed')
    // Recovery re-executed the create through the driver (idempotent adoption).
    expect(driver.runs.filter(op => op.kind === 'create')).toHaveLength(1)
  })

  it('refuses to adopt a legacy interrupted create whose intent was never persisted', async () => {
    const store = new MemoryInventoryStore()
    const inventory = new Inventory(store)
    await inventory.initialize()
    // Legacy record from the schema that stripped payloads: no intent to
    // re-execute. Reconstructing a descriptor with empty mounts would be a
    // fabrication, so recovery fails closed and leaves the observed container
    // to reconciliation for an explicit decision.
    await inventory.putOperation({ id: 'op-legacy', environmentId: env1, kind: 'create', state: 'running', requestedAt: 1000 })
    const driver = fakeDriver()
    driver.setReport({ unregistered: [descriptorFor(env1)] })
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
  bindings.markComplete()
    const manager = new EnvironmentManager({
      inventory,
      driver: driver.driver,
      bindings,
      mountPolicy: fakeMountContext(),
      budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
      now: () => 1500,
    })
    await manager.initialize(signal())
    expect(inventory.get(env1)).toBeUndefined()
    const settled = inventory.operation('op-legacy')!
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('interrupted')
    expect(settled.error).toMatch(/not persisted/)
  })

  it('settles an unevidenced interrupted operation as failed', async () => {
    const store = new MemoryInventoryStore()
    const inventory = new Inventory(store)
    await inventory.initialize()
    await inventory.putOperation({ id: 'op-lost', environmentId: env1, kind: 'start', state: 'requested', requestedAt: 1000 })
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
  bindings.markComplete()
    const manager = new EnvironmentManager({
      inventory,
      driver: fakeDriver().driver,
      bindings,
      mountPolicy: fakeMountContext(),
      budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
      now: () => 1500,
    })
    await manager.initialize(signal())
    const settled = inventory.operation('op-lost')!
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('interrupted')
  })
})

describe('binding operations', () => {
  it('refuses a second conversation on a busy environment', async () => {
    const { manager, inventory, bindings } = await makeManager()
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    expect((await manager.bind('session-a', env1, 1)).state).toBe('completed')
    const conflict = await manager.bind('session-b', env1, 1)
    expect(conflict.state).toBe('failed')
    expect(conflict.errorCode).toBe('binding-conflict')
    expect(bindings.binding('session-b')).toBeUndefined()
  })

  it('allows explicit shared reuse', async () => {
    const { manager, inventory } = await makeManager()
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    await manager.bind('session-a', env1, 1)
    expect((await manager.bind('session-b', env1, 1, { allowShared: true })).state).toBe('completed')
  })

  it('unbind without a binding fails explicitly', async () => {
    const { manager } = await makeManager()
    await manager.initialize(signal())
    const settled = await manager.unbind('nobody')
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('not-bound')
  })
})

describe('removal preview and confirmation', () => {
  it('requires a current preview token', async () => {
    const { manager, inventory } = await makeManager()
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    const settled = await manager.remove(env1, 'made-up-token', false)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('preview-required')
    expect(inventory.get(env1)).toBeDefined()
  })

  it('previews involved data, honors the volume choice, and never deletes host directories', async () => {
    const { manager, inventory, driver } = await makeManager()
    await inventory.putDescriptor(descriptorFor(env1, { mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' }] }))
    await manager.initialize(signal())
    const preview = await manager.previewRemoval(env1)
    expect(preview.hostMounts).toEqual(['/Users/tester/projects/app'])
    expect(preview.volumeName).toBe('dsh-wrapvm-env-1-data')
    const settled = await manager.remove(env1, preview.confirmToken, false)
    expect(settled.state).toBe('completed')
    expect(inventory.get(env1)).toBeUndefined()
    // The driver saw the captured target and the explicit volume choice.
    const remove = driver.runs.find(op => op.kind === 'remove' && op.state === 'running')!
    expect(remove.payload).toEqual({ kind: 'remove', deleteVolumes: false })
    // The token is single-use.
    const again = await manager.remove(env1, preview.confirmToken, true)
    expect(again.state).toBe('failed')
    expect(again.errorCode).toBe('preview-required')
  })

  it('refuses removal while executions are active without a user action', async () => {
    const { manager, inventory } = await makeManager({ executions: { acquireExecution: async () => () => {}, withMutation: async () => ({ kind: 'busy', names: ['vm_browser'] }) } })
    await inventory.putDescriptor(descriptorFor(env1))
    await manager.initialize(signal())
    const preview = await manager.previewRemoval(env1, true)
    const settled = await manager.remove(env1, preview.confirmToken, true)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('busy')
    expect(inventory.get(env1)).toBeDefined()
  })
})

describe('legacy import', () => {
  it('records an imported environment without touching the backend', async () => {
    const { manager, inventory, driver } = await makeManager()
    await manager.initialize(signal())
    await manager.importEnvironment(env2, descriptorFor(env2, { ownership: 'imported', containerId: 'legacy-container' }))
    expect(inventory.get(env2)?.ownership).toBe('imported')
    expect(inventory.get(env2)?.containerId).toBe('legacy-container')
    expect(driver.runs).toHaveLength(0)
  })

  it('refuses to overwrite an existing environment', async () => {
    const { manager, inventory } = await makeManager()
    await inventory.putDescriptor(descriptorFor(env2))
    await manager.initialize(signal())
    await expect(manager.importEnvironment(env2, descriptorFor(env2, { ownership: 'imported' }))).rejects.toThrow(/already exists/)
  })

  it('requires the explicit imported ownership marker (identity verified first)', async () => {
    const { manager } = await makeManager()
    await manager.initialize(signal())
    await expect(manager.importEnvironment(env2, descriptorFor(env2, { ownership: 'plugin' }))).rejects.toThrow(/ownership imported/)
  })
})