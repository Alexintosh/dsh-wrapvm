/**
 * Manager + REAL DockerEnvironmentBackend composition review suite.
 *
 * Reproduces the confirmed Sol findings against the actual modules — real
 * `Inventory`, real `DockerEnvironmentBackend` over a scripted stateful
 * engine (no live Docker, no foreign resources), real `BindingRegistry`, and
 * real `EnvironmentManager` — never a permissive driver double. Assertions
 * inspect the ACTUAL persisted records and the ACTUAL engine call log.
 *
 * Own fixtures on purpose (stateful mini-daemon, own mount context, own
 * crash store): shared fixture files are owned by other workers and race
 * under parallel edits.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  DockerEnvironmentBackend,
  defaultDockerBackendConfig,
  VOLUME_TOKEN_LABEL,
  type EngineRunResult,
  type EngineRunner,
} from '../src/docker-backend.ts'
import { EnvironmentManager, ExecutionLeaseRegistry, type ExecutionLedger } from '../src/lifecycle.ts'
import {
  DomainInventoryStore,
  Inventory,
  MemoryInventoryStore,
  type InventorySnapshot,
  type KvTableLike,
} from '../src/inventory.ts'
import { BindingRegistry, MemoryBindingEventSink } from '../src/binding.ts'
import type { MountPolicyContext } from '../src/mount-policy.ts'
import type { EnvironmentBackendDriver, EnvironmentDescriptor, EnvironmentId, EnvironmentTarget } from '../src/environments.ts'

// ---------------------------------------------------------------- fixtures

const IMAGE = 'ghcr.io/tobi/wrapvm:desktop'
const IMAGE_ID = 'sha256:aaaabbbbccccdddd'
const GUEST_WORKSPACE = defaultDockerBackendConfig.guestWorkspace
const IMAGE_CONFIG = {
  Entrypoint: ['/opt/wrap/bin/wrap-entrypoint'],
  Cmd: null,
  Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  User: '',
} as const

interface DaemonContainer {
  id: string
  name: string
  imageRef: string
  imageId: string
  labels: Record<string, string>
  state: 'created' | 'running' | 'paused' | 'exited'
  network: string
  volume: string
  ports: Record<string, { HostIp: string; HostPort: string }[]>
  portBindings: Record<string, { HostIp: string; HostPort: string }[]>
  imageConfig: { Entrypoint: string[] | null; Cmd: string[] | null; Env: string[] | null; User: string }
  binds: { src: string; dst: string; writable: boolean }[]
  memory: number
  nanoCpus: number
  memorySwap: number
  pidsLimit: number
  securityOpt: string[]
  capAdd: string[]
  capDrop: string[]
}

interface DaemonNetwork {
  id: string
  labels: Record<string, string>
  internal: boolean
}

interface DaemonVolume {
  driver: string
  createdAt: string
  labels: Record<string, string>
}

/**
 * Stateful mini-Daemon engine double: models containers, networks, and
 * volumes with labels, full ids, and the real CLI's reuse/failure semantics
 * (`volume create` silently reuses; inspects report `No such ...`). Records
 * every argv for assertions. `failNext` scripts one-shot engine failures.
 */
function makeDaemon() {
  const containers = new Map<string, DaemonContainer>()
  const networks = new Map<string, DaemonNetwork>()
  const volumes = new Map<string, DaemonVolume>()
  const calls: string[][] = []
  let containerCounter = 0
  let networkCounter = 0
  let ephemeralPort = 32_000
  let failNext: ((argv: readonly string[]) => EngineRunResult | undefined) | undefined

  const ok = (stdout = ''): EngineRunResult => ({ exitCode: 0, stdout, stderr: '' })
  const err = (stderr: string): EngineRunResult => ({ exitCode: 1, stdout: '', stderr })
  const flagValues = (words: readonly string[], flag: string): string[] => {
    const out: string[] = []
    for (let index = 0; index < words.length; index += 1) {
      if (words[index] === flag) out.push(words[index + 1]!)
    }
    return out
  }
  const parseLabels = (pairs: readonly string[]): Record<string, string> => {
    const labels: Record<string, string> = {}
    for (const pair of pairs) {
      const split = pair.indexOf('=')
      labels[pair.slice(0, split)] = pair.slice(split + 1)
    }
    return labels
  }
  const findContainer = (idOrName: string): DaemonContainer | undefined =>
    containers.get(idOrName) ?? [...containers.values()].find(record => record.name === idOrName)

  const runner: EngineRunner = async (argv, signal) => {
    signal.throwIfAborted()
    calls.push([...argv])
    const scripted = failNext?.(argv)
    if (scripted !== undefined) return scripted
    const [, ...words] = argv
    const [command, sub] = words

    if (command === 'version') return ok('27.0.0')

    if (command === 'ps') {
      const format = words[words.indexOf('--format') + 1]
      const filters = flagValues(words, '--filter').map(filter => filter.slice('label='.length)).map(pair => {
        const split = pair.indexOf('=')
        return [pair.slice(0, split), pair.slice(split + 1)] as const
      })
      const matched = [...containers.values()].filter(record => filters.every(([key, value]) => record.labels[key] === value))
      if (format === '{{json .}}') return ok(matched.map(record => JSON.stringify({ ID: record.id, State: record.state, Image: record.imageRef })).join('\n'))
      return ok(matched.map(record => record.id).join('\n'))
    }

    if (command === 'image' && sub === 'inspect' && words[2] === '--format' && words[3] === '{{json .}}') {
      if (words[4] !== IMAGE_ID || words.length !== 5) return err(`Error: No such image: ${words[4]}`)
      return ok(JSON.stringify({ Id: IMAGE_ID, Config: IMAGE_CONFIG }))
    }

    if (command === 'inspect' && sub === '--format') {
      const record = findContainer(words[3]!)
      if (record === undefined) return err(`Error: No such object: ${words[3]}`)
      return ok(JSON.stringify({
        Id: record.id,
        Image: record.imageId,
        State: { Status: record.state },
        Config: { Image: record.imageRef, Labels: record.labels, ...record.imageConfig },
        HostConfig: {
          Memory: record.memory, NanoCpus: record.nanoCpus, MemorySwap: record.memorySwap, PidsLimit: record.pidsLimit,
          Privileged: false, CapDrop: record.capDrop, CapAdd: record.capAdd, SecurityOpt: record.securityOpt,
          PidMode: '', IpcMode: 'private', UsernsMode: '', UTSMode: '', CgroupnsMode: 'private',
          Devices: null, DeviceRequests: null, DeviceCgroupRules: null,
          NetworkMode: record.network, PortBindings: record.portBindings,
        },
        NetworkSettings: {
          Networks: { [record.network]: { NetworkID: record.state === 'created' ? '' : networks.get(record.network)?.id } },
          Ports: record.ports,
        },
        Mounts: [
          { Type: 'volume', Name: record.volume, Destination: GUEST_WORKSPACE, RW: true },
          ...record.binds.map(bind => ({ Type: 'bind', Source: bind.src, Destination: bind.dst, RW: bind.writable })),
        ],
      }))
    }

    if (command === 'network') {
      if (sub === 'create') {
        const name = words[words.length - 1]!
        if (networks.has(name)) return err(`Error response from daemon: network with name ${name} already exists`)
        const id = `network-${++networkCounter}`
        networks.set(name, { id, labels: parseLabels(flagValues(words, '--label')), internal: words.includes('--internal') })
        return ok(id)
      }
      if (sub === 'inspect') {
        const network = networks.get(words[words.length - 1]!)
        if (network === undefined) return err(`Error: No such network: ${words[words.length - 1]}`)
        return ok(JSON.stringify({ Name: words[words.length - 1], Id: network.id, Labels: network.labels, Internal: network.internal }))
      }
      if (sub === 'rm') {
        const requested = words[words.length - 1]!
        const name = [...networks].find(([key, value]) => key === requested || value.id === requested)?.[0]
        if (name === undefined || !networks.delete(name)) return err(`Error response from daemon: error while removing network: network ${requested} not found`)
        return ok(name)
      }
    }

    if (command === 'volume') {
      if (sub === 'create') {
        const name = words[words.length - 1]!
        // Real `docker volume create` silently reuses an existing volume.
        if (volumes.has(name)) return ok(name)
        volumes.set(name, { driver: 'local', createdAt: '2026-11-01T00:00:00Z', labels: parseLabels(flagValues(words, '--label')) })
        return ok(name)
      }
      if (sub === 'inspect') {
        const name = words[words.length - 1]!
        const volume = volumes.get(name)
        if (volume === undefined) return err(`Error response from daemon: get ${name}: no such volume`)
        return ok(JSON.stringify({ Name: name, Driver: volume.driver, CreatedAt: volume.createdAt, Labels: volume.labels }))
      }
      if (sub === 'rm') {
        const name = words[words.length - 1]!
        if (!volumes.delete(name)) return err(`Error response from daemon: remove ${name}: no such volume`)
        return ok(name)
      }
    }

    if (command === 'create') {
      const name = flagValues(words, '--name')[0]!
      const volumeMount = flagValues(words, '--volume')[0]!
      const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {}
      for (const published of flagValues(words, '-p')) {
        const parts = published.split(':')
        portBindings[`${parts[2]}/tcp`] = [{ HostIp: parts[0]!, HostPort: parts[1]! }]
      }
      const binds = flagValues(words, '--mount').map(mount => ({
        src: /src=([^,]*)/.exec(mount)?.[1] ?? '',
        dst: /dst=([^,]*)/.exec(mount)?.[1] ?? '',
        writable: !mount.split(',').includes('readonly'),
      }))
      const id = `container-full-${++containerCounter}`
      containers.set(id, {
        id,
        name,
        imageRef: words[words.length - 1]!,
        imageId: IMAGE_ID,
        labels: parseLabels(flagValues(words, '--label')),
        state: 'created',
        network: flagValues(words, '--network')[0]!,
        volume: volumeMount.split(':')[0]!,
        ports: {},
        portBindings,
        imageConfig: {
          Entrypoint: [...IMAGE_CONFIG.Entrypoint], Cmd: IMAGE_CONFIG.Cmd,
          Env: [...IMAGE_CONFIG.Env], User: IMAGE_CONFIG.User,
        },
        binds,
        memory: Number(flagValues(words, '--memory')[0]),
        nanoCpus: Number(flagValues(words, '--cpus')[0]) * 1e9,
        memorySwap: Number(flagValues(words, '--memory-swap')[0]),
        pidsLimit: Number(flagValues(words, '--pids-limit')[0]),
        securityOpt: flagValues(words, '--security-opt'),
        capAdd: flagValues(words, '--cap-add'),
        capDrop: flagValues(words, '--cap-drop'),
      })
      return ok(id)
    }

    if (command === 'start' || command === 'stop' || command === 'pause' || command === 'unpause') {
      const record = findContainer(words[1]!)
      if (record === undefined) return err(`Error response from daemon: No such container: ${words[1]}`)
      if (command === 'start' && record.state === 'created') {
        for (const [port, bindings] of Object.entries(record.portBindings)) {
          record.ports[port] = bindings.map(binding => ({
            HostIp: binding.HostIp,
            HostPort: binding.HostPort === '' || binding.HostPort === '0' ? String(ephemeralPort++) : binding.HostPort,
          }))
        }
      }
      record.state = command === 'start' ? 'running' : command === 'stop' ? 'exited' : command === 'pause' ? 'paused' : 'running'
      return ok(record.id)
    }

    if (command === 'update') {
      const record = findContainer(words[words.length - 1]!)
      if (record === undefined) return err(`Error response from daemon: No such container: ${words[words.length - 1]}`)
      record.nanoCpus = Number(flagValues(words, '--cpus')[0]) * 1e9
      record.memory = Number(flagValues(words, '--memory')[0])
      return ok(record.id)
    }

    if (command === 'rm') {
      const record = findContainer(words[words.length - 1]!)
      if (record === undefined) return err(`Error response from daemon: No such container: ${words[words.length - 1]}`)
      containers.delete(record.id)
      return ok(record.id)
    }

    return err(`fake engine: unhandled argv: ${argv.join(' ')}`)
  }

  return {
    runner,
    calls,
    containers,
    networks,
    volumes,
    /** Script the NEXT matching engine call to fail once (crash simulation). */
    failNextWith: (predicate: (argv: readonly string[]) => EngineRunResult | undefined): void => {
      failNext = argv => {
        const result = predicate(argv)
        if (result !== undefined) failNext = undefined
        return result
      }
    },
    callsLike: (...prefix: readonly string[]): string[][] =>
      calls.filter(argv => prefix.every((word, index) => argv[index + 1] === word)),
  }
}

type Daemon = ReturnType<typeof makeDaemon>

/** Own mount-policy context: one approved root, everything exists. */
function makeMountContext(): MountPolicyContext {
  return {
    realpath: path => path,
    exists: () => true,
    homedir: '/Users/tester',
    approvedRoots: ['/Users/tester/projects'],
  }
}

/** Inventory store whose Nth save throws (crash-between-writes simulation). */
class CrashInventoryStore extends MemoryInventoryStore {
  failOnSave: number | undefined
  private savesDone = 0

  override async save(snapshot: InventorySnapshot): Promise<void> {
    this.savesDone += 1
    if (this.failOnSave === this.savesDone) throw new Error('simulated crash during persist')
    await super.save(snapshot)
  }
}

/** In-memory KvTable stand-in for the storage-domain adapter roundtrip. */
class MemoryKvTable<V> implements KvTableLike<V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined {
    return this.records.get(key)
  }
  entries(): IterableIterator<[string, V]> {
    return [...this.records.entries()]
  }
  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

interface Composition {
  readonly daemon: Daemon
  readonly store: CrashInventoryStore
  readonly inventory: Inventory
  readonly backend: DockerEnvironmentBackend
  readonly bindings: BindingRegistry
  readonly sink: MemoryBindingEventSink
  readonly manager: EnvironmentManager
  readonly clock: { now: number }
}

async function makeComposition(options: {
  store?: CrashInventoryStore
  daemon?: Daemon
  budget?: { totalCpuMillis: number; totalMemoryBytes: number }
  executions?: ExecutionLedger
  previewTtlMs?: number
  driver?: EnvironmentBackendDriver
  now?: () => number
} = {}): Promise<Composition> {
  const daemon = options.daemon ?? makeDaemon()
  const store = options.store ?? new CrashInventoryStore()
  const inventory = new Inventory(store)
  await inventory.initialize()
  const mountPolicy = makeMountContext()
  const clock = { now: 1000 }
  const now = options.now ?? (() => clock.now)
  const backend = new DockerEnvironmentBackend(daemon.runner, defaultDockerBackendConfig, mountPolicy, inventory, now)
  const sink = new MemoryBindingEventSink()
  const bindings = new BindingRegistry(sink, now)
  bindings.markComplete()
  const manager = new EnvironmentManager({
    inventory,
    driver: options.driver ?? backend,
    bindings,
    mountPolicy,
    budget: options.budget ?? { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
    executions: options.executions ?? new ExecutionLeaseRegistry(),
    ...(options.previewTtlMs !== undefined ? { previewTtlMs: options.previewTtlMs } : {}),
    now,
  })
  return { daemon, store, inventory, backend, bindings, sink, manager, clock }
}

const createInput = {
  displayName: 'Primary',
  image: IMAGE,
  limits: { cpuMillis: 2_000, memoryBytes: 4 * 2 ** 30 },
  internetAccess: true,
  mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' as const }],
  ports: { viewerPort: 55_000, cdpPort: 55_001 },
}

const signal = (): AbortSignal => new AbortController().signal

async function createdEnvironment(composition: Composition, input = createInput): Promise<EnvironmentId> {
  const settled = await composition.manager.create(input)
  if (settled.state !== 'completed') throw new Error(`fixture create failed: ${settled.error ?? 'unknown'}`)
  return settled.environmentId
}

function descriptorFixture(id: EnvironmentId, overrides: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor {
  return {
    id,
    backend: 'docker',
    containerId: 'container-full-1',
    ownership: 'plugin',
    image: IMAGE,
    digest: IMAGE_ID,
    createdAt: 1000,
    mounts: [],
    limits: { cpuMillis: 2_000, memoryBytes: 4 * 2 ** 30 },
    internetAccess: true,
    displayName: 'Fixture',
    volumeName: `dsh-wrapvm-${id}-data`,
    networkName: `dsh-wrapvm-${id}`,
    ports: { viewerPort: 55_000, cdpPort: 55_001 },
    desiredPhase: 'running',
    ...overrides,
  }
}

// ------------------------------------------------------------------- tests

describe('finding 1: update-limits and remove reach the engine with an admission-captured target', () => {
  it('updateLimits captures the inspected target inside admission and updates the live container', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const settled = await composition.manager.updateLimits(id, { cpuMillis: 3_000, memoryBytes: 6 * 2 ** 30 })
    // The reproduction: this used to fail `invalid-transition` with ZERO
    // engine calls because the operation carried no target.
    expect(settled.state).toBe('completed')
    const updates = composition.daemon.callsLike('update')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain('container-full-1')
    // The persisted operation carries the FULL inspected identity, not a
    // reconstruction from the inventory record.
    const persisted = composition.inventory.operation(settled.id)!
    expect(persisted.target?.containerId).toBe('container-full-1')
    expect(persisted.target?.imageDigest).toBe(IMAGE_ID)
    expect(persisted.target?.networkId).toBeDefined()
    expect(persisted.target?.volumeToken).toBeDefined()
    expect(persisted.target?.volumeCreatedAt).toBeDefined()
    expect(composition.inventory.get(id)?.limits).toEqual({ cpuMillis: 3_000, memoryBytes: 6 * 2 ** 30 })
    expect(composition.daemon.containers.get('container-full-1')?.nanoCpus).toBe(3e9)
  })

  it('remove dispatches rm/network-rm against the approved target and honors the volume choice', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id)
    const settled = await composition.manager.remove(id, preview.confirmToken, false)
    expect(settled.state).toBe('completed')
    expect(composition.daemon.callsLike('rm', '-f')).toHaveLength(1)
    expect(composition.daemon.callsLike('network', 'rm')).toHaveLength(1)
    expect(composition.daemon.callsLike('volume', 'rm')).toHaveLength(0)
    expect(composition.daemon.volumes.has(`dsh-wrapvm-${id}-data`)).toBe(true)
    expect(composition.inventory.get(id)).toBeUndefined()
    expect(composition.inventory.operationsFor(id).some(op => op.kind === 'remove' && op.state === 'completed')).toBe(true)
  })

  it('remove with deleteVolumes deletes the named volume, never host directories', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id, true)
    const settled = await composition.manager.remove(id, preview.confirmToken, true)
    expect(settled.state).toBe('completed')
    expect(composition.daemon.callsLike('volume', 'rm')).toHaveLength(1)
    expect(composition.daemon.volumes.has(`dsh-wrapvm-${id}-data`)).toBe(false)
    // The bind mount source (host directory) still exists in the fake fs:
    // nothing ever deleted it (the daemon has no fs at all — the mount is a
    // --mount option only).
    const binds = composition.daemon.calls.filter(argv => argv.includes('--mount'))
    expect(binds.length).toBeGreaterThan(0)
  })
})

describe('finding 2: the persisted operation keeps the complete validated intent', () => {
  it('round-trips payload, nested mounts, ports, resources, and target identity through the storage-domain adapter', async () => {
    const snapshots = new MemoryKvTable<unknown>()
    const store = new DomainInventoryStore(snapshots)
    const inventory = new Inventory(store)
    await inventory.initialize()
    const daemon = makeDaemon()
    const mountPolicy = makeMountContext()
    const backend = new DockerEnvironmentBackend(daemon.runner, defaultDockerBackendConfig, mountPolicy, inventory, () => 1500)
    const bindings = new BindingRegistry(new MemoryBindingEventSink(), () => 1500)
    bindings.markComplete()
    const manager = new EnvironmentManager({
      inventory,
      driver: backend,
      bindings,
      mountPolicy,
      budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
      now: () => 1500,
    })
    await manager.initialize(signal())
    const settled = await manager.create(createInput, { idempotencyKey: 'roundtrip-1' })
    expect(settled.state).toBe('completed')

    // Reopen from the medium: the FULL intent and target survive (the old
    // schema silently stripped payload/target on put/load).
    const reopened = new Inventory(new DomainInventoryStore(snapshots))
    await reopened.initialize()
    const record = reopened.operation(settled.id)!
    expect(record.state).toBe('completed')
    expect(record.payload).toEqual({ kind: 'create', input: createInput })
    expect(record.target?.containerId).toBe('container-full-1')
    expect(record.target?.volumeToken).toBeDefined()
    expect(record.target?.volumeCreatedAt).toBe('2026-11-01T00:00:00Z')
    expect(record.target?.networkId).toBeDefined()
    expect(record.target?.imageDigest).toBe(IMAGE_ID)
    expect(record.requestSignature).toBeDefined()
    // Plain JSON data only: the record survives serialization untouched.
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)

    // A non-serializable field (AbortSignal) can never enter the record:
    // the durable boundary refuses it loudly instead of stripping silently.
    await expect(inventory.putOperation({ ...record, signal: new AbortController().signal } as never)).rejects.toThrow(/invalid/)
  })

  it('update-limits and remove persist their parameters for crash replay', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const updated = await composition.manager.updateLimits(id, { cpuMillis: 1_000, memoryBytes: 2 ** 30 })
    expect(composition.inventory.operation(updated.id)?.payload).toEqual({ kind: 'update-limits', limits: { cpuMillis: 1_000, memoryBytes: 2 ** 30 } })
    const preview = await composition.manager.previewRemoval(id, true)
    const removed = await composition.manager.remove(id, preview.confirmToken, true)
    // The remove op is pruned with the environment log; assert BEFORE prune
    // via the returned record instead: the settled result carries the choice.
    expect(removed.payload).toEqual({ kind: 'remove', deleteVolumes: true })
  })
})

describe('finding 3: crash before/after every durable write reconciles deterministically', () => {
  it('crash before the requested write persists nothing and leaves the engine untouched', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    composition.store.failOnSave = 1
    await expect(composition.manager.create(createInput, { idempotencyKey: 'crash-1' })).rejects.toThrow(/simulated crash/)
    expect(() => composition.inventory.pendingOperations()).toThrow(/initialize/)
    expect(composition.daemon.callsLike('create')).toHaveLength(0)
    // Reload after a write error before retrying.
    composition.store.failOnSave = undefined
    await composition.manager.initialize(signal())
    const settled = await composition.manager.create(createInput, { idempotencyKey: 'crash-1' })
    expect(settled.state).toBe('completed')
    expect(composition.daemon.callsLike('create')).toHaveLength(1)
  })

  it('crash after the requested write waits for explicit recovery', async () => {
    const store = new CrashInventoryStore()
    const composition = await makeComposition({ store })
    await composition.manager.initialize(signal())
    store.failOnSave = 2 // the 'running' write crashes; 'requested' is durable
    await expect(composition.manager.create(createInput, { idempotencyKey: 'crash-2' })).rejects.toThrow(/simulated crash/)
    expect(() => composition.inventory.pendingOperations()).toThrow(/initialize/)
    const pending = Object.values((await store.load())!.operations)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.payload?.kind).toBe('create') // intent survived the crash
    expect(composition.daemon.callsLike('create')).toHaveLength(0)

    // A fresh process on the same durable state recovers deterministically.
    const revived = await makeComposition({ store })
    await revived.manager.initialize(signal())
    expect(revived.daemon.callsLike('create')).toHaveLength(0)
    expect(revived.inventory.operation(pending[0]!.id)?.errorCode).toBe('recovery-required')
    expect((await revived.manager.recoverCreate(pending[0]!.id)).state).toBe('completed')
    expect(revived.daemon.callsLike('create')).toHaveLength(1)
    const record = revived.inventory.get(pending[0]!.environmentId)
    // The adopted descriptor preserves the FULL intent, never mounts: [].
    expect(record?.mounts).toEqual(createInput.mounts)
    expect(record?.limits).toEqual(createInput.limits)
    expect(record?.displayName).toBe('Primary')
    expect(revived.inventory.operation(pending[0]!.id)?.state).toBe('completed')
  })

  it('crash after the engine created the container adopts the observed result exactly once', async () => {
    const store = new CrashInventoryStore()
    const composition = await makeComposition({ store })
    await composition.manager.initialize(signal())
    store.failOnSave = 3 // the atomic settle commit crashes AFTER the engine worked
    await expect(composition.manager.create(createInput, { idempotencyKey: 'crash-3' })).rejects.toThrow(/simulated crash/)
    expect(composition.daemon.containers.size).toBe(1)
    expect(() => composition.inventory.pendingOperations()).toThrow(/initialize/)
    const pending = Object.values((await store.load())!.operations)[0]!

    // A fresh process on the same durable state AND the same engine: the
    // re-executed create must ADOPT the owned container, never duplicate it.
    const revived = await makeComposition({ store, daemon: composition.daemon })
    await revived.manager.initialize(signal())
    expect(revived.daemon.containers.size).toBe(1)
    expect(revived.inventory.operation(pending.id)?.errorCode).toBe('recovery-required')
    expect((await revived.manager.recoverCreate(pending.id)).state).toBe('completed')
    const record = revived.inventory.get(pending.environmentId)
    expect(revived.inventory.operation(pending.id)?.state, JSON.stringify(revived.inventory.operation(pending.id))).toBe('completed')
    expect(record?.containerId).toBe('container-full-1')
    expect(record?.mounts).toEqual(createInput.mounts)
    expect(revived.inventory.operation(pending.id)?.state).toBe('completed')
    // No second container-create reached the engine.
    expect(revived.daemon.callsLike('create')).toHaveLength(1)
  })

  it('the settled record and its outcome commit atomically', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const settled = await composition.manager.create(createInput)
    const last = composition.store.saves.at(-1)!
    // One snapshot carries BOTH the completed operation and the descriptor:
    // no observer can ever see completed-without-descriptor from this path.
    expect(last.operations[settled.id]?.state).toBe('completed')
    expect(Object.keys(last.environments)).toEqual([settled.environmentId])
  })

  it('heals a legacy completed-but-uncommitted create and a legacy completed remove', async () => {
    const store = new CrashInventoryStore()
    const composition = await makeComposition({ store })
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    // Legacy split-write artifacts: a completed create whose descriptor lost,
    // and a completed remove whose record survived.
    await composition.inventory.deleteDescriptor(id)
    const orphan = composition.inventory.operation(composition.inventory.operationsFor(id)[0]!.id)!
    await composition.inventory.putOperation({ ...orphan, state: 'completed' })
    const secondId = await createdEnvironment(composition, { ...createInput, displayName: 'Second' })
    const removeTarget: EnvironmentTarget = {
      environmentId: secondId,
      containerId: 'container-full-2',
      containerName: `dsh-wrapvm-${secondId}`,
      networkName: `dsh-wrapvm-${secondId}`,
      volumeName: `dsh-wrapvm-${secondId}-data`,
      ports: { viewerPort: 55_000, cdpPort: 55_001 },
      capturedAt: 1000,
    }
    await composition.inventory.putOperation({
      id: 'op-legacy-remove',
      environmentId: secondId,
      kind: 'remove',
      state: 'completed',
      payload: { kind: 'remove', deleteVolumes: false },
      target: removeTarget,
      requestedAt: 900,
      settledAt: 950,
    })

    const mutatingBefore = composition.daemon.calls.filter(argv => ['rm', 'start', 'stop', 'pause', 'unpause', 'update', 'create'].includes(argv[1]!)).length
    await composition.manager.initialize(signal())
    // Record healing issues NO mutating engine calls (read-only reconcile
    // listings are fine): recovery never deletes or creates backend resources.
    const mutatingAfter = composition.daemon.calls.filter(argv => ['rm', 'start', 'stop', 'pause', 'unpause', 'update', 'create'].includes(argv[1]!)).length
    expect(mutatingAfter).toBe(mutatingBefore)
    expect(composition.inventory.get(id)).toBeUndefined()
    expect(composition.inventory.operation(orphan.id)?.errorCode).toBe('recovery-required')
    expect(composition.inventory.get(secondId)).toBeUndefined()
    expect((await composition.manager.recoverCreate(orphan.id)).state).toBe('completed')
    expect(composition.inventory.get(id)?.mounts).toEqual(createInput.mounts)
  })
})

describe('finding 4: concurrent binds cannot both pass the user check', () => {
  it('serializes check + durable emit + apply: exactly one winner', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const [first, second] = await Promise.all([
      composition.manager.bind('session-a', id, 1),
      composition.manager.bind('session-b', id, 1),
    ])
    const states = [first.state, second.state].sort()
    expect(states).toEqual(['completed', 'failed'])
    const loser = first.state === 'failed' ? first : second
    expect(loser.errorCode).toBe('binding-conflict')
    // Only ONE durable event; the loser never silently joined the users.
    expect(composition.sink.events).toHaveLength(1)
    expect(composition.bindings.usersOf(id)).toHaveLength(1)
  })

  it('refuses binding to an unknown environment before emitting anything', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const settled = await composition.manager.bind('session-a', 'env-nope' as EnvironmentId, 1)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('unknown-environment')
    expect(composition.sink.events).toHaveLength(0)
  })

  it('bind effects run under admission: a refused bind persists no operation', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    await composition.manager.bind('session-a', id, 1)
    const opsBefore = composition.store.saves.at(-1)!.operations
    const conflict = await composition.manager.bind('session-b', id, 1)
    expect(conflict.state).toBe('failed')
    const opsAfter = composition.inventory.operationsFor(id)
    expect(opsAfter.filter(op => op.kind === 'bind' && op.state === 'completed')).toHaveLength(1)
    expect(opsAfter.filter(op => op.kind === 'bind' && op.state === 'failed')).toHaveLength(1)
    expect(opsAfter.length).toBe(Object.keys(opsBefore).length + 1)
  })
})

describe('finding 5: an idempotency key never answers a different request', () => {
  it('refuses a differing payload under a used key without touching state or engine', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const created = await composition.manager.create(createInput, { idempotencyKey: 'shared-key' })
    expect(created.state).toBe('completed')
    const opsBefore = Object.keys(composition.store.saves.at(-1)!.operations).length

    // The reproduction: the same key replayed for a DIFFERENT request used to
    // return the previous unrelated create's success.
    const hijack = await composition.manager.stop(created.environmentId, { idempotencyKey: 'shared-key' })
    expect(hijack.state).toBe('failed')
    expect(hijack.errorCode).toBe('idempotency-conflict')
    expect(composition.daemon.callsLike('stop')).toHaveLength(0)
    expect(composition.inventory.get(created.environmentId)?.desiredPhase).toBe('running')
    expect(Object.keys(composition.store.saves.at(-1)!.operations)).toHaveLength(opsBefore)

    // The SAME semantic request still deduplicates to the same operation.
    const again = await composition.manager.create(createInput, { idempotencyKey: 'shared-key' })
    expect(again.id).toBe(created.id)
    expect(composition.daemon.callsLike('create')).toHaveLength(1)
  })

  it('the signature comparison survives a crash/reload (persisted, not in-memory)', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const created = await composition.manager.create(createInput, { idempotencyKey: 'persist-key' })
    // Fresh process on the same durable state.
    const revived = await makeComposition({ store: composition.store })
    await revived.manager.initialize(signal())
    const hijack = await revived.manager.stop(created.environmentId, { idempotencyKey: 'persist-key' })
    expect(hijack.state).toBe('failed')
    expect(hijack.errorCode).toBe('idempotency-conflict')
    const same = await revived.manager.create(createInput, { idempotencyKey: 'persist-key' })
    expect(same.id).toBe(created.id)
    expect(revived.daemon.callsLike('create')).toHaveLength(0)
  })
})

describe('finding 6: preview staleness, expiry, consumption, and ownership revalidation', () => {
  it('a replaced inventory record invalidates the token inside serialized admission', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id)
    // Descriptor replacement (the exact reproduction): same id, new content.
    await composition.inventory.putDescriptor(descriptorFixture(id, { displayName: 'Replaced', mounts: [] }))
    const settled = await composition.manager.remove(id, preview.confirmToken, false)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('preview-stale')
    expect(composition.daemon.callsLike('rm', '-f')).toHaveLength(0)
    expect(composition.inventory.get(id)).toBeDefined()
  })

  it('a volume recreated with the SAME ownership labels invalidates the preview', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id, true)
    const volumeName = `dsh-wrapvm-${id}-data`
    const original = composition.daemon.volumes.get(volumeName)!
    // Recreate: same name, same ownership labels, NEW creation identity.
    composition.daemon.volumes.set(volumeName, {
      driver: original.driver,
      createdAt: '2026-11-12T09:00:00Z',
      labels: { ...original.labels, [VOLUME_TOKEN_LABEL]: 'a-different-incarnation' },
    })
    const settled = await composition.manager.remove(id, preview.confirmToken, true)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('preview-stale')
    expect(composition.daemon.callsLike('rm', '-f')).toHaveLength(0)
    expect(composition.daemon.callsLike('volume', 'rm')).toHaveLength(0)
  })

  it('expires, consumes, and refuses replayed tokens', async () => {
    const composition = await makeComposition({ previewTtlMs: 1_000 })
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id)
    expect(preview.expiresAt).toBe(2_000)

    const wrong = await composition.manager.remove(id, 'not-the-token', false)
    expect(wrong.errorCode).toBe('preview-required')

    composition.clock.now = 5_000
    const expired = await composition.manager.remove(id, preview.confirmToken, false)
    expect(expired.errorCode).toBe('preview-expired')
    // The expired token is still stored until consumed by a valid removal.
    composition.clock.now = 1_500
    const consumed = await composition.manager.remove(id, preview.confirmToken, false)
    expect(consumed.state).toBe('completed')
    const replay = await composition.manager.remove(id, preview.confirmToken, true)
    expect(replay.errorCode).toBe('preview-required')
    expect(composition.daemon.callsLike('volume', 'rm')).toHaveLength(0)
  })

  it('busy refusal keeps the token; the user override then completes with it', async () => {
    const executions = new ExecutionLeaseRegistry()
    const composition = await makeComposition({ executions })
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const release = await executions.acquireExecution(id, 'vm_shell')
    const preview = await composition.manager.previewRemoval(id)
    const busy = await composition.manager.remove(id, preview.confirmToken, false)
    expect(busy.errorCode).toBe('busy')
    expect(composition.daemon.callsLike('rm', '-f')).toHaveLength(0)
    const forced = await composition.manager.remove(id, preview.confirmToken, false, { userAction: true })
    expect(forced.state).toBe('completed')
    release()
  })

  it('destructive removal refuses when the driver cannot re-verify ownership', async () => {
    const base = await makeComposition()
    await base.manager.initialize(signal())
    const id = await createdEnvironment(base)
    // A driver exposing captureTarget but NOT verifyTarget is compatibility
    // surface only: the destructive call must refuse, never fall back.
    const driver: EnvironmentBackendDriver = {
      reconcile: (sig) => base.backend.reconcile(sig),
      run: (op, sig) => base.backend.run(op, sig),
      probe: (target, sig) => base.backend.probe(target, sig),
      captureTarget: (envId, sig) => base.backend.captureTarget(envId, sig),
    }
    const store = base.store
    const inventory = new Inventory(store)
    await inventory.initialize()
    const bindings = new BindingRegistry(new MemoryBindingEventSink(), () => 1000)
    bindings.markComplete()
    const manager = new EnvironmentManager({
      inventory,
      driver,
      bindings,
      executions: new ExecutionLeaseRegistry(),
      mountPolicy: makeMountContext(),
      budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
      now: () => 1000,
    })
    await manager.initialize(signal())
    const preview = await manager.previewRemoval(id)
    const settled = await manager.remove(id, preview.confirmToken, false)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('verification-unavailable')
    expect(base.daemon.callsLike('rm', '-f')).toHaveLength(0)
    expect(inventory.get(id)).toBeDefined()
  })

  it('two concurrent removes with the same token dispatch exactly one engine removal', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id)
    const [first, second] = await Promise.all([
      composition.manager.remove(id, preview.confirmToken, false),
      composition.manager.remove(id, preview.confirmToken, false),
    ])
    const states = [first.state, second.state].sort()
    expect(states).toEqual(['completed', 'failed'])
    const loser = first.state === 'failed' ? first : second
    expect(loser.errorCode).toBe('preview-required')
    expect(composition.daemon.callsLike('rm', '-f')).toHaveLength(1)
  })

  it('refuses preview when the container cannot be inspected', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    composition.daemon.containers.clear()
    await expect(composition.manager.previewRemoval(id)).rejects.toThrow(/cannot preview/)
    expect(composition.daemon.callsLike('network', 'rm')).toHaveLength(0)
    expect(composition.inventory.get(id)).toBeDefined()
  })

  it('normal mutations refuse a missing resource instead of cleaning up', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    composition.daemon.containers.clear()
    const settled = await composition.manager.stop(id)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-missing')
    expect(composition.daemon.callsLike('stop')).toHaveLength(0)
  })
})

describe('finding 7: limit updates respect the aggregate budget under the create serialization', () => {
  it('concurrent updates that together exceed the budget: one passes, one refuses, engine sees one update', async () => {
    const composition = await makeComposition({ budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 } })
    await composition.manager.initialize(signal())
    const first = await createdEnvironment(composition)
    const second = await createdEnvironment(composition, { ...createInput, displayName: 'Second', ports: { viewerPort: 55_010, cdpPort: 55_011 } })
    const [updateA, updateB] = await Promise.all([
      composition.manager.updateLimits(first, { cpuMillis: 6_000, memoryBytes: 4 * 2 ** 30 }),
      composition.manager.updateLimits(second, { cpuMillis: 6_000, memoryBytes: 4 * 2 ** 30 }),
    ])
    const states = [updateA.state, updateB.state].sort()
    expect(states).toEqual(['completed', 'failed'])
    const loser = updateA.state === 'failed' ? updateA : updateB
    expect(loser.errorCode).toBe('budget-exceeded')
    expect(composition.daemon.callsLike('update')).toHaveLength(1)
    // Desired state stays coherent: only the admitted update persisted.
    const winner = updateA.state === 'completed' ? updateA : updateB
    expect(composition.inventory.get(winner.environmentId)?.limits.cpuMillis).toBe(6_000)
    expect(composition.inventory.get(loser.environmentId)?.limits.cpuMillis).toBe(2_000)
  })

  it('a failed engine update leaves the persisted limits untouched (no phantom desired state)', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    composition.daemon.failNextWith(argv => (argv[1] === 'update' ? { exitCode: 1, stdout: '', stderr: 'daemon rejected the update' } : undefined))
    const settled = await composition.manager.updateLimits(id, { cpuMillis: 5_000, memoryBytes: 8 * 2 ** 30 })
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('outcome-unknown')
    expect(composition.inventory.get(id)?.limits).toEqual(createInput.limits)
    // The journal shows the failure, not a completed lie.
    expect(composition.inventory.operation(settled.id)?.state).toBe('failed')
  })
})

describe('real-engine create crash matrix (manager + backend, engine mutated)', () => {
  it('engine failure mid-create settles failed and a keyed retry completes without duplicates', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    // The container create fails after network/volume were created.
    composition.daemon.failNextWith(argv => (argv[1] === 'create' ? { exitCode: 1, stdout: '', stderr: 'no space left on device' } : undefined))
    const failed = await composition.manager.create(createInput, { idempotencyKey: 'engine-fail' })
    expect(failed.state).toBe('failed')
    expect(composition.inventory.get(failed.environmentId)).toBeUndefined()
    // Retry reuses the durable operation and environment identity.
    const retried = await composition.manager.create(createInput, { idempotencyKey: 'engine-fail' })
    expect(retried.environmentId).toBe(failed.environmentId)
    expect(retried.id).toBe(failed.id)
    expect(retried.state).toBe('completed')
    expect(composition.daemon.containers.size).toBe(1)
    expect(composition.daemon.networks.size).toBe(1)
    expect(composition.daemon.volumes.size).toBe(1)
  })
})
describe('admission regression cases', () => {
  it('binds the volume deletion choice to the preview', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id, false)
    expect(preview.deleteVolumes).toBe(false)
    const result = await composition.manager.remove(id, preview.confirmToken, true)
    expect(result.errorCode).toBe('preview-stale')
    expect(composition.daemon.callsLike('rm', '-f')).toHaveLength(0)
    expect(composition.daemon.callsLike('volume', 'rm')).toHaveLength(0)
  })

  it('keeps the deletion key reserved after removal and reload', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id, false)
    const removed = await composition.manager.remove(id, preview.confirmToken, false, { idempotencyKey: 'remove-key' })
    expect(removed.state).toBe('completed')
    const revived = await makeComposition({ store: composition.store, daemon: composition.daemon })
    await revived.manager.initialize(signal())
    expect(revived.inventory.get(id)).toBeUndefined()
    const collision = await revived.manager.create(createInput, { idempotencyKey: 'remove-key' })
    expect(collision.errorCode).toBe('idempotency-conflict')
  })

  it('refuses a captured owned container that replaced the inventoried container', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const original = composition.daemon.containers.get('container-full-1')!
    composition.daemon.containers.delete(original.id)
    composition.daemon.containers.set('container-replacement', { ...original, id: 'container-replacement' })
    const result = await composition.manager.updateLimits(id, { cpuMillis: 1000, memoryBytes: 2 ** 30 })
    expect(result.errorCode).toBe('resource-conflict')
    expect(composition.daemon.callsLike('update')).toHaveLength(0)
  })

  it('includes explicit sharing in bind idempotency comparison', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const first = await composition.manager.bind('a', id, 1, { idempotencyKey: 'bind-key' })
    expect(first.state).toBe('completed')
    const second = await composition.manager.bind('a', id, 1, { idempotencyKey: 'bind-key', allowShared: true })
    expect(second.errorCode).toBe('idempotency-conflict')
    expect(composition.sink.events).toHaveLength(1)
  })
})

describe('interrupted create verification', () => {
  it('does not adopt a labelled container whose actual bind mount changed', async () => {
    const store = new CrashInventoryStore()
    const composition = await makeComposition({ store })
    await composition.manager.initialize(signal())
    store.failOnSave = 3
    await expect(composition.manager.create(createInput, { idempotencyKey: 'changed-bind' })).rejects.toThrow(/simulated crash/)
    const pending = Object.values((await store.load())!.operations)[0]!
    const container = composition.daemon.containers.get('container-full-1')!
    container.binds[0]!.src = '/Users/tester/projects/other'
    const revived = await makeComposition({ store, daemon: composition.daemon })
    await revived.manager.initialize(signal())
    expect(revived.inventory.get(pending.environmentId)).toBeUndefined()
    expect(revived.inventory.operation(pending.id)?.errorCode).toBe('recovery-required')
    await revived.manager.recoverCreate(pending.id)
    expect(revived.inventory.operation(pending.id)).toMatchObject({ state: 'failed', errorCode: 'resource-conflict' })
    expect(revived.daemon.callsLike('create')).toHaveLength(1)
  })
})

describe('interrupted removal recovery', () => {
  it('settles a removal whose resources disappeared before the final snapshot write', async () => {
    const store = new CrashInventoryStore()
    const composition = await makeComposition({ store })
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const preview = await composition.manager.previewRemoval(id, true)
    // Three create writes, two remove journal writes, then the remove settlement.
    store.failOnSave = 6
    await expect(composition.manager.remove(id, preview.confirmToken, true)).rejects.toThrow(/simulated crash/)
    expect(composition.daemon.containers.size).toBe(0)
    expect(composition.daemon.networks.size).toBe(0)
    expect(composition.daemon.volumes.size).toBe(0)
    const revived = await makeComposition({ store, daemon: composition.daemon })
    await revived.manager.initialize(signal())
    expect(revived.inventory.get(id)).toBeUndefined()
    expect(revived.inventory.operationsFor(id).find(op => op.kind === 'remove')?.state).toBe('completed')
    expect(revived.daemon.callsLike('rm', '-f')).toHaveLength(1)
  })
})

describe('unknown mutation outcomes', () => {
  it.each(['update-limits', 'stop'] as const)('blocks dependent operations after a crashed %s', async (kind) => {
    const store = new CrashInventoryStore()
    const composition = await makeComposition({ store })
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    store.failOnSave = 6
    const action = kind === 'stop'
      ? composition.manager.stop(id)
      : composition.manager.updateLimits(id, { cpuMillis: 5_000, memoryBytes: 8 * 2 ** 30 })
    await expect(action).rejects.toThrow(/simulated crash/)
    const engine = composition.daemon.containers.get('container-full-1')!
    if (kind === 'stop') expect(engine.state).toBe('exited')
    else expect(engine.memory).toBe(8 * 2 ** 30)
    const revived = await makeComposition({ store, daemon: composition.daemon })
    await revived.manager.initialize(signal())
    expect(revived.manager.uncertainty(id)).toMatchObject({ kind, errorCode: 'outcome-unknown' })
    const previousCalls = revived.daemon.callsLike('update').length
    expect((await revived.manager.updateLimits(id, { cpuMillis: 1_000, memoryBytes: 2 ** 30 })).errorCode).toBe('outcome-unknown')
    expect((await revived.manager.bind('new-session', id, 1)).errorCode).toBe('outcome-unknown')
    await expect(revived.manager.previewRemoval(id)).rejects.toThrow(/unknown operation outcome/)
    expect(revived.daemon.callsLike('update')).toHaveLength(previousCalls)
    if (kind === 'update-limits') {
      expect((await revived.manager.create({ ...createInput, displayName: 'another' })).errorCode).toBe('outcome-unknown')
    }
  })

  it('refuses a mutation when no shared lease coordinator exists, even with override', async () => {
    const composition = await makeComposition()
    await composition.manager.initialize(signal())
    const id = await createdEnvironment(composition)
    const manager = new EnvironmentManager({ inventory: composition.inventory, driver: composition.backend,
      bindings: composition.bindings, mountPolicy: makeMountContext(), budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 } })
    await manager.initialize(signal())
    const result = await manager.stop(id, { userAction: true })
    expect(result.errorCode).toBe('lease-unavailable')
    expect(composition.daemon.callsLike('stop')).toHaveLength(0)
  })
})

describe('shared lifecycle and execution lease', () => {
  it('prevents execution admission while a mutation holds the coordinator and preserves new leases on repeated release', async () => {
    const ledger = new ExecutionLeaseRegistry()
    const id = 'env-lease' as EnvironmentId
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { finish = resolve })
    const mutation = ledger.withMutation(id, false, async () => { entered(); await hold; return 'done' })
    await started
    let acquired = false
    const acquiring = ledger.acquireExecution(id, 'tool').then(release => { acquired = true; return release })
    await Promise.resolve()
    expect(acquired).toBe(false)
    finish()
    expect(await mutation).toEqual({ kind: 'executed', value: 'done' })
    const release = await acquiring
    expect((await ledger.withMutation(id, false, async () => 'bad')).kind).toBe('busy')
    release()
    const releaseNext = await ledger.acquireExecution(id, 'second')
    release()
    expect((await ledger.withMutation(id, false, async () => 'bad')).kind).toBe('busy')
    releaseNext()
  })
})

describe('manager readiness', () => {
  it('refuses mutations before its recovery has run', async () => {
    const composition = await makeComposition()
    await expect(composition.manager.create(createInput)).rejects.toThrow(/initialize/)
    expect(composition.daemon.callsLike('create')).toHaveLength(0)
  })
})

describe('manager binding completeness', () => {
  it('refuses stop, pause, update, preview and removal with an incomplete index, including user override', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const preview = await c.manager.previewRemoval(id)
    c.bindings.invalidateCompleteness()
    expect((await c.manager.stop(id, { userAction: true })).errorCode).toBe('binding-incomplete')
    expect((await c.manager.pause(id, { userAction: true })).errorCode).toBe('binding-incomplete')
    expect((await c.manager.updateLimits(id, { cpuMillis: 1000, memoryBytes: 2 ** 30 }, { userAction: true })).errorCode).toBe('binding-incomplete')
    await expect(c.manager.previewRemoval(id)).rejects.toThrow(/binding index is incomplete/)
    expect((await c.manager.remove(id, preview.confirmToken, false, { userAction: true })).errorCode).toBe('binding-incomplete')
    expect(c.daemon.callsLike('stop')).toHaveLength(0)
    expect(c.daemon.callsLike('pause')).toHaveLength(0)
    expect(c.daemon.callsLike('update')).toHaveLength(0)
    expect(c.daemon.callsLike('rm', '-f')).toHaveLength(0)
  })

  it('allows lifecycle controls on selected environments, prevents selected removal, and invalidates previews on binding changes', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    await c.bindings.bind('session-a', id, 1)
    expect((await c.manager.stop(id)).state).toBe('completed')
    expect((await c.manager.start(id)).state).toBe('completed')
    expect((await c.manager.pause(id)).state).toBe('completed')
    expect((await c.manager.resume(id)).state).toBe('completed')
    expect((await c.manager.updateLimits(id, { cpuMillis: 1000, memoryBytes: 2 ** 30 })).state).toBe('completed')
    const preview = await c.manager.previewRemoval(id)
    expect(preview.boundSessions).toEqual(['session-a'])
    expect((await c.manager.remove(id, preview.confirmToken, false)).errorCode).toBe('binding-in-use')
    await c.bindings.bind('session-b', id, 1, { allowShared: true })
    expect((await c.manager.remove(id, preview.confirmToken, false, { userAction: true })).errorCode).toBe('binding-in-use')
    await c.bindings.unbind('session-a')
    await c.bindings.unbind('session-b')
    expect((await c.manager.remove(id, preview.confirmToken, false, { userAction: true })).errorCode).toBe('preview-stale')
    expect(c.daemon.callsLike('rm', '-f')).toHaveLength(0)
    expect((await c.manager.stop(id, { userAction: true })).state).toBe('completed')
  })

  it.each(['stop', 'pause', 'remove'] as const)('revocation while %s captures the target prevents backend mutation', async kind => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const preview = kind === 'remove' ? await c.manager.previewRemoval(id) : undefined
    const capture = c.backend.captureTarget.bind(c.backend)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    c.backend.captureTarget = async (environmentId, abort) => { enter(); await hold; abort.throwIfAborted(); return await capture(environmentId, abort) }
    const request = kind === 'stop' ? c.manager.stop(id, { userAction: true })
      : kind === 'pause' ? c.manager.pause(id, { userAction: true })
        : c.manager.remove(id, preview!.confirmToken, false, { userAction: true })
    await entered
    c.bindings.invalidateCompleteness()
    release()
    const result = await request
    expect(result.errorCode).toBe('binding-incomplete')
    expect(c.daemon.callsLike(kind === 'remove' ? 'rm' : kind)).toHaveLength(0)
  })

  it('revocation while preview captures its target never issues a token', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const capture = c.backend.captureTarget.bind(c.backend)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    c.backend.captureTarget = async (environmentId, abort) => { enter(); await hold; abort.throwIfAborted(); return await capture(environmentId, abort) }
    const request = c.manager.previewRemoval(id)
    await entered
    c.bindings.invalidateCompleteness()
    release()
    await expect(request).rejects.toThrow(/binding index is incomplete/)
  })
})

describe('manager binding admission races', () => {
  it('serializes a new binding behind a destructive operation already in admission', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const verify = c.backend.verifyTarget.bind(c.backend)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    c.backend.verifyTarget = async (target, abort) => { enter(); await hold; return await verify(target, abort) }
    const stopped = c.manager.stop(id)
    await entered
    let bindingFinished = false
    const binding = c.bindings.bind('session-a', id, 1).then(() => { bindingFinished = true })
    await Promise.resolve()
    expect(bindingFinished).toBe(false)
    release()
    expect((await stopped).state).toBe('completed')
    await binding
    expect(c.bindings.usersOf(id)).toEqual(['session-a'])
  })

  it('revokes completeness during verification before stop reaches the engine', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const verify = c.backend.verifyTarget.bind(c.backend)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    c.backend.verifyTarget = async (target, abort) => { enter(); await hold; abort.throwIfAborted(); return await verify(target, abort) }
    const stopped = c.manager.stop(id, { userAction: true })
    await entered
    c.bindings.invalidateCompleteness()
    release()
    expect((await stopped).errorCode).toBe('binding-incomplete')
    expect(c.daemon.callsLike('stop')).toHaveLength(0)
    expect(c.manager.uncertainty(id)).toBeUndefined()
  })

  it('marks an operation unknown if completeness is revoked after backend dispatch', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const run = c.backend.run.bind(c.backend)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    c.backend.run = async (operation, abort) => {
      if (operation.kind === 'stop') { enter(); await hold; abort.throwIfAborted() }
      return await run(operation, abort)
    }
    const stopped = c.manager.stop(id)
    await entered
    c.bindings.invalidateCompleteness()
    release()
    expect((await stopped).errorCode).toBe('outcome-unknown')
    expect(c.manager.uncertainty(id)?.kind).toBe('stop')
    expect(c.daemon.callsLike('stop')).toHaveLength(0)
  })
})

describe('operations independent of binding absence', () => {
  it('allows create and explicit start or resume while the binding index is incomplete', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    expect((await c.manager.stop(id)).state).toBe('completed')
    c.bindings.invalidateCompleteness()
    expect((await c.manager.start(id)).state).toBe('completed')

    const other = await makeComposition()
    await other.manager.initialize(signal())
    const otherId = await createdEnvironment(other)
    expect((await other.manager.pause(otherId)).state).toBe('completed')
    other.bindings.invalidateCompleteness()
    expect((await other.manager.resume(otherId)).state).toBe('completed')
    expect((await other.manager.create({ ...createInput, displayName: 'independent' })).state).toBe('completed')
  })
})

describe('selective create recovery', () => {
  it('snapshot, initialization and an unrelated create never start an interrupted container', async () => {
    const store = new CrashInventoryStore()
    const initial = await makeComposition({ store })
    await initial.manager.initialize(signal())
    store.failOnSave = 3
    await expect(initial.manager.create(createInput, { idempotencyKey: 'interrupted-a' })).rejects.toThrow(/simulated crash/)
    const original = Object.values((await store.load())!.operations)[0]!
    const container = initial.daemon.containers.get('container-full-1')!
    container.state = 'created'
    container.ports = {}
    const startsBefore = initial.daemon.callsLike('start').length

    const revived = await makeComposition({ store, daemon: initial.daemon })
    await revived.manager.initialize(signal())
    await revived.manager.list(signal())
    expect(container.state).toBe('created')
    expect(revived.inventory.operation(original.id)?.errorCode).toBe('recovery-required')
    expect(revived.daemon.callsLike('start')).toHaveLength(startsBefore)

    const other = await revived.manager.create({ ...createInput, displayName: 'B', ports: { viewerPort: 56000, cdpPort: 56001 } })
    expect(other.state).toBe('completed')
    expect(container.state).toBe('created')
    expect(revived.daemon.callsLike('start').slice(startsBefore).map(call => call[2])).toEqual(['container-full-2'])
    expect(revived.inventory.operation(original.id)?.errorCode).toBe('recovery-required')

    const recovered = await revived.manager.recoverCreate(original.id)
    expect(recovered).toMatchObject({ id: original.id, environmentId: original.environmentId, state: 'completed', idempotencyKey: 'interrupted-a' })
    expect(container.state).toBe('running')
    expect(revived.inventory.get(original.environmentId)?.mounts).toEqual(createInput.mounts)
    expect((await revived.manager.recoverCreate(original.id)).id).toBe(original.id)
    expect(revived.daemon.callsLike('start').filter(call => call[2] === 'container-full-1')).toHaveLength(2)
  })

  it('reserves the budget of an unresolved create and does not count it twice on recovery', async () => {
    const store = new CrashInventoryStore()
    const c = await makeComposition({ store, budget: { totalCpuMillis: 2000, totalMemoryBytes: 4 * 2 ** 30 } })
    await c.manager.initialize(signal())
    store.failOnSave = 2
    await expect(c.manager.create(createInput)).rejects.toThrow(/simulated crash/)
    const pending = Object.values((await store.load())!.operations)[0]!
    const revived = await makeComposition({ store, daemon: c.daemon, budget: { totalCpuMillis: 2000, totalMemoryBytes: 4 * 2 ** 30 } })
    await revived.manager.initialize(signal())
    expect((await revived.manager.create({ ...createInput, displayName: 'B' })).errorCode).toBe('budget-exceeded')
    expect(revived.daemon.callsLike('create')).toHaveLength(0)
    expect((await revived.manager.recoverCreate(pending.id)).state).toBe('completed')
  })

  it('refuses recovery against a replaced captured container, even with matching labels', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    const operation = c.inventory.operationsFor(id).find(op => op.kind === 'create')!
    await c.inventory.deleteDescriptor(id)
    const original = c.daemon.containers.get('container-full-1')!
    c.daemon.containers.delete(original.id)
    c.daemon.containers.set('replacement', { ...original, id: 'replacement' })
    await c.manager.initialize(signal())
    expect(c.inventory.operation(operation.id)?.errorCode).toBe('recovery-required')
    const before = c.daemon.callsLike('start').length
    const result = await c.manager.recoverCreate(operation.id)
    expect(result.state).toBe('failed')
    expect(result.errorCode).toBe('resource-missing')
    expect(c.inventory.get(id)).toBeUndefined()
    expect(c.daemon.callsLike('start')).toHaveLength(before)
  })
})

describe('selective recovery budget and concurrency', () => {
  it('refuses budget decisions if a legacy unresolved create has no persisted limits', async () => {
    const c = await makeComposition()
    await c.manager.initialize(signal())
    const id = await createdEnvironment(c)
    await c.inventory.putOperation({ id: 'legacy-unknown', environmentId: 'env-unknown' as EnvironmentId, kind: 'create', state: 'running' })
    await c.manager.initialize(signal())
    expect((await c.manager.create({ ...createInput, displayName: 'B' })).errorCode).toBe('outcome-unknown')
    expect((await c.manager.updateLimits(id, { cpuMillis: 1000, memoryBytes: 2 ** 30 })).errorCode).toBe('outcome-unknown')
    expect(c.daemon.callsLike('create')).toHaveLength(1)
    expect(c.daemon.callsLike('update')).toHaveLength(0)
  })

  it('serializes duplicate explicit recovery requests for one keyless intent', async () => {
    const store = new CrashInventoryStore()
    const c = await makeComposition({ store })
    await c.manager.initialize(signal())
    store.failOnSave = 2
    await expect(c.manager.create(createInput)).rejects.toThrow(/simulated crash/)
    const pending = Object.values((await store.load())!.operations)[0]!
    const revived = await makeComposition({ store })
    await revived.manager.initialize(signal())
    const [first, second] = await Promise.all([revived.manager.recoverCreate(pending.id), revived.manager.recoverCreate(pending.id)])
    expect(first).toMatchObject({ id: pending.id, environmentId: pending.environmentId, state: 'completed' })
    expect(second).toMatchObject({ id: pending.id, environmentId: pending.environmentId, state: 'completed' })
    expect(revived.daemon.callsLike('create')).toHaveLength(1)
  })
})
