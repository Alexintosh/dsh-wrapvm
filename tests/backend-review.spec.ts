/**
 * Backend-review suite: adversarial tests against the realistic scripted
 * Docker engine fixture (full-vs-truncated ids, silent volume reuse, label
 * collisions, replacement after capture). Every expectation encodes the
 * Docker CLI grammar the review found the backend previously assumed away.
 */
import { describe, expect, it } from 'vitest'
import {
  defaultDockerBackendConfig,
  DockerEnvironmentBackend,
  VOLUME_TOKEN_LABEL,
  type InventoryView,
} from '../src/docker-backend.ts'
import {
  asEnvironmentId,
  type EnvironmentCreateInput,
  type EnvironmentDescriptor,
  type EnvironmentOperation,
  type EnvironmentTarget,
} from '../src/environments.ts'
import { containerNameFor, ENVIRONMENT_ID_LABEL, Inventory, MemoryInventoryStore, OWNERSHIP_LABEL } from '../src/inventory.ts'
import { EnvironmentManager, ExecutionLeaseRegistry, type ManagerPorts } from '../src/lifecycle.ts'
import { BindingRegistry, MemoryBindingEventSink } from '../src/binding.ts'
import { fakeMountContext } from './fixtures/env-fixtures.ts'
import {
  fakeDockerEngine,
  fail,
  ok,
  ownedContainer,
  ownedLabels,
  type FakeContainer,
  type FakeEngineOptions,
  type FakeEngineState,
} from './fixtures/backend-review-fixtures.ts'

const env1 = asEnvironmentId('env-1')

/** Deterministic 64-hex ids with unique 12-char prefixes (like real ids). */
const fullId = (head: string): string => (head + 'd2c3b4a59687f0e1').repeat(4)
const CONTAINER_A = fullId('a001')
const CONTAINER_B = fullId('b002')
const CONTAINER_FOREIGN = fullId('f003')
const NETWORK_ID = fullId('0a01')
const NETWORK_ID_REPLACED = fullId('0b02')
const VOLUME_TOKEN_OLD = 'token-old-0001'
const VOLUME_TOKEN_NEW = 'token-new-0002'

const policy = fakeMountContext({
  approvedRoots: ['/Users/tester/projects'],
  existing: ['/', '/Users', '/Users/tester', '/Users/tester/projects', '/Users/tester/projects/app'],
})

function makeBackend(state: FakeEngineState, options: FakeEngineOptions = {}, records: readonly EnvironmentDescriptor[] = []) {
  const engine = fakeDockerEngine(state, options)
  const view: InventoryView = { list: () => records }
  const backend = new DockerEnvironmentBackend(engine.runner, defaultDockerBackendConfig, policy, view, () => 1000)
  return { backend, engine, state }
}

const createInput: EnvironmentCreateInput = {
  displayName: 'Primary',
  image: 'ghcr.io/tobi/wrapvm:desktop',
  limits: { cpuMillis: 1_500, memoryBytes: 2 * 2 ** 30 },
  internetAccess: true,
  mounts: [],
  ports: { viewerPort: 55000, cdpPort: 55001 },
}

const createOperation = (input: EnvironmentCreateInput = createInput): EnvironmentOperation => ({
  id: 'op-create',
  environmentId: env1,
  kind: 'create',
  state: 'requested',
  payload: { kind: 'create', input },
  requestedAt: 900,
})

/** A fully-owned engine state: container, network, and volume all labeled. */
function ownedState(volumeToken: string = VOLUME_TOKEN_OLD): FakeEngineState {
  return {
    containers: [ownedContainer({
      id: CONTAINER_A,
      name: containerNameFor(env1),
      environmentId: 'env-1',
      networks: { [containerNameFor(env1)]: { NetworkID: NETWORK_ID } },
    })],
    networks: [{ name: containerNameFor(env1), id: NETWORK_ID, labels: ownedLabels('env-1'), internal: false }],
    volumes: [{ name: 'dsh-wrapvm-env-1-data', driver: 'local', createdAt: '2026-11-10T09:00:00Z', labels: ownedLabels('env-1', { [VOLUME_TOKEN_LABEL]: volumeToken }) }],
  }
}

const capturedTarget = (overrides: Partial<EnvironmentTarget> = {}): EnvironmentTarget => ({
  environmentId: env1,
  containerId: CONTAINER_A,
  containerName: containerNameFor(env1),
  networkName: containerNameFor(env1),
  volumeName: 'dsh-wrapvm-env-1-data',
  ports: { viewerPort: 55000, cdpPort: 55001 },
  imageDigest: 'sha256:aaaabbbbccccdddd',
  capturedAt: 900,
  networkId: NETWORK_ID,
  volumeDriver: 'local',
  volumeToken: VOLUME_TOKEN_OLD,
  volumeCreatedAt: '2026-11-10T09:00:00Z',
  ...overrides,
})

const removeOperation = (target: EnvironmentTarget, deleteVolumes: boolean): EnvironmentOperation => ({
  id: 'op-remove',
  environmentId: env1,
  kind: 'remove',
  state: 'requested',
  target,
  payload: { kind: 'remove', deleteVolumes },
})

const signal = (): AbortSignal => new AbortController().signal

const callsFor = (calls: readonly (readonly string[])[], ...prefix: string[]): string[][] =>
  calls.filter(argv => prefix.every((word, index) => argv[index + 1] === word))

// --------------------------------------------------------------------------

describe('bind mount grammar', () => {
  it('publishes a read-only bind as an explicit --mount, never -v host:guest,ro', async () => {
    const { backend, engine } = makeBackend({ containers: [], networks: [], volumes: [] })
    const operation = createOperation({ ...createInput, mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' }] })
    const settled = await backend.run(operation, signal())
    expect(settled.state).toBe('completed')

    const create = callsFor(engine.calls, 'create')[0] ?? []
    const mountIndex = create.indexOf('--mount')
    expect(mountIndex).toBeGreaterThan(-1)
    expect(create[mountIndex + 1]).toBe('type=bind,src=/Users/tester/projects/app,dst=/mnt/app,readonly')
    // The wrong grammar must be gone entirely: no -v host bind, no `,ro` suffix.
    expect(create.some(arg => /^\/Users\//.test(arg))).toBe(false)
    expect(create.some(arg => arg.endsWith(',ro'))).toBe(false)
    // The engine model parsed the option and mounted it read-only at the right path.
    const bind = engine.state.containers[0]?.mounts.find(mount => mount.Type === 'bind')
    expect(bind?.Source).toBe('/Users/tester/projects/app')
    expect(bind?.Destination).toBe('/mnt/app')
    expect(bind?.readonly).toBe(true)
  })

  it('omits readonly for read-write binds', async () => {
    const { backend, engine } = makeBackend({ containers: [], networks: [], volumes: [] })
    const operation = createOperation({ ...createInput, mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-write' }] })
    await backend.run(operation, signal())
    const create = callsFor(engine.calls, 'create')[0] ?? []
    expect(create).toContain('type=bind,src=/Users/tester/projects/app,dst=/mnt/app')
  })

  it('refuses ambiguous separators before touching the engine', async () => {
    const commaPolicy = fakeMountContext({
      approvedRoots: ['/Users/tester/projects'],
      existing: ['/', '/Users', '/Users/tester', '/Users/tester/projects', '/Users/tester/projects/we,ird'],
    })
    const engine = fakeDockerEngine({ containers: [], networks: [], volumes: [] })
    const backend = new DockerEnvironmentBackend(engine.runner, defaultDockerBackendConfig, commaPolicy, { list: () => [] }, () => 1000)
    for (const guestPath of ['/mnt/we,ird', '/mnt/we:ird']) {
      const settled = await backend.run(createOperation({ ...createInput, mounts: [{ hostPath: '/Users/tester/projects/we,ird', guestPath, access: 'read-only' }] }), signal())
      expect(settled.errorCode).toBe('mount-denied')
    }
    expect(engine.calls).toHaveLength(0)
  })

  it('refuses mount paths carrying control characters before touching the engine', async () => {
    const controlPolicy = fakeMountContext({
      approvedRoots: ['/Users/tester/projects'],
      existing: ['/', '/Users', '/Users/tester', '/Users/tester/projects'],
    })
    const engine = fakeDockerEngine({ containers: [], networks: [], volumes: [] })
    const backend = new DockerEnvironmentBackend(engine.runner, defaultDockerBackendConfig, controlPolicy, { list: () => [] }, () => 1000)
    const operation = createOperation({ ...createInput, mounts: [{ hostPath: '/Users/tester/projects/app\u0007evil', guestPath: '/mnt/app', access: 'read-only' }] })
    const settled = await backend.run(operation, signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('mount-denied')
    expect(engine.calls).toHaveLength(0)
  })
})

describe('create adoption rigor', () => {
  it('adopts only a fully matching owned container, capturing verified identity', async () => {
    const { backend, engine } = makeBackend(ownedState())
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('completed')
    expect(settled.target?.containerId).toBe(CONTAINER_A)
    expect(settled.target?.networkId).toBe(NETWORK_ID)
    expect(settled.target?.volumeToken).toBe(VOLUME_TOKEN_OLD)
    expect(settled.target?.imageDigest).toBe('sha256:aaaabbbbccccdddd')
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
    expect(callsFor(engine.calls, 'network', 'create')).toHaveLength(0)
    expect(callsFor(engine.calls, 'volume', 'create')).toHaveLength(0)
  })

  it('refuses to adopt when multiple containers claim the environment id', async () => {
    const state = ownedState()
    state.containers.push(ownedContainer({ id: CONTAINER_B, name: 'dsh-wrapvm-env-1-alt', environmentId: 'env-1' }))
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-conflict')
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
    expect(state.containers).toHaveLength(2)
  })

  it('refuses a claimant running a different image', async () => {
    const state = ownedState()
    const claimant = state.containers[0]
    if (claimant !== undefined) state.containers[0] = { ...claimant, image: 'evil:latest' }
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-conflict')
    expect(settled.error).toMatch(/image/)
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
  })

  it('refuses adoption when the actual bind mounts differ from the request', async () => {
    const state = ownedState()
    const claimant = state.containers[0]!
    state.containers[0] = { ...claimant, mounts: [...claimant.mounts, { Type: 'bind', Source: '/Users/tester/.ssh', Destination: '/mnt/keys', RW: true }] }
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.errorCode).toBe('resource-conflict')
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
  })

  it('refuses adoption when the attached network id differs from the inspected network', async () => {
    const state = ownedState()
    state.networks[0]!.id = NETWORK_ID_REPLACED
    const { backend } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.errorCode).toBe('resource-conflict')
  })

  it.each([
    ['extra network', (c: FakeContainer): FakeContainer => ({ ...c, networks: { ...c.networks, other: { NetworkID: 'other' } } })],
    ['non-loopback port', (c: FakeContainer): FakeContainer => ({ ...c, ports: { ...c.ports, '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '55000' }] } })],
    ['unexpected published port', (c: FakeContainer): FakeContainer => ({ ...c, ports: { ...c.ports, '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '55002' }] } })],
    ['memory limit', (c: FakeContainer): FakeContainer => ({ ...c, memory: 4 * 2 ** 30 })],
    ['CPU limit', (c: FakeContainer): FakeContainer => ({ ...c, nanoCpus: 2e9 })],
    ['swap limit', (c: FakeContainer): FakeContainer => ({ ...c, hostConfig: { MemorySwap: -1 } })],
    ['privileged mode', (c: FakeContainer): FakeContainer => ({ ...c, hostConfig: { Privileged: true } })],
    ['extra capability', (c: FakeContainer): FakeContainer => ({ ...c, hostConfig: { CapAdd: ['CHOWN', 'FOWNER', 'SETUID', 'SETGID', 'KILL', 'SYS_ADMIN'] } })],
    ['missing no-new-privileges', (c: FakeContainer): FakeContainer => ({ ...c, hostConfig: { SecurityOpt: [] } })],
    ['workspace target', (c: FakeContainer): FakeContainer => ({ ...c, mounts: [{ Type: 'volume', Name: 'dsh-wrapvm-env-1-data', Destination: '/elsewhere' }] })],
  ])('refuses adoption with mismatched %s', async (_label, mutate) => {
    const state = ownedState()
    state.containers[0] = mutate(state.containers[0]!)
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.errorCode).toBe('resource-conflict')
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
  })

  it('refuses adoption when bind access mode or target differs', async () => {
    for (const mount of [
      { Type: 'bind', Source: '/Users/tester/projects/app', Destination: '/mnt/app', RW: true },
      { Type: 'bind', Source: '/Users/tester/projects/app', Destination: '/mnt/other', RW: false },
    ]) {
      const state = ownedState()
      const c = state.containers[0]!
      state.containers[0] = { ...c, mounts: [...c.mounts, mount] }
      const { backend } = makeBackend(state)
      const input = { ...createInput, mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' as const }] }
      expect((await backend.run(createOperation(input), signal())).errorCode).toBe('resource-conflict')
    }
  })

  it('refuses adoption when the network internet setting differs', async () => {
    const state = ownedState()
    state.networks[0]!.internal = true
    const { backend } = makeBackend(state)
    expect((await backend.run(createOperation(), signal())).errorCode).toBe('resource-conflict')
  })

  it('refuses a claimant that does not attach the environment volume', async () => {
    const state = ownedState()
    const claimant = state.containers[0]
    if (claimant !== undefined) state.containers[0] = { ...claimant, mounts: [] }
    const { backend } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-conflict')
    expect(settled.error).toMatch(/volume/)
  })

  it('never adopts a container missing the ownership label and reports the taken name honestly', async () => {
    const squatter: FakeContainer = ownedContainer({
      id: CONTAINER_FOREIGN,
      name: containerNameFor(env1),
      environmentId: 'env-1',
      labels: { [ENVIRONMENT_ID_LABEL]: 'env-1' },
    })
    const { backend, engine } = makeBackend({ containers: [squatter], networks: [], volumes: [] })
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('port-conflict')
    expect(settled.error).toMatch(/does not own/)
    expect(engine.state.containers.map(container => container.id)).toContain(CONTAINER_FOREIGN)
  })

  it('fails closed when the owned-container listing cannot be read', async () => {
    const { backend, engine } = makeBackend(ownedState(), {
      intercept: argv => argv[1] === 'ps' ? fail(1, 'Cannot connect to the Docker daemon') : undefined,
    })
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-unverified')
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
    expect(callsFor(engine.calls, 'network', 'create')).toHaveLength(0)
  })
})

describe('network and volume reuse verification', () => {
  it('refuses to reuse a foreign network claiming the environment name', async () => {
    const state: FakeEngineState = {
      containers: [],
      networks: [{ name: containerNameFor(env1), id: NETWORK_ID, labels: { 'app.kubernetes.io/managed-by': 'someone-else' }, internal: false }],
      volumes: [],
    }
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-foreign')
    expect(settled.error).toMatch(/network/)
    expect(state.networks[0]?.labels[OWNERSHIP_LABEL]).toBeUndefined()
    expect(callsFor(engine.calls, 'volume', 'create')).toHaveLength(0)
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
  })

  it('refuses a foreign volume even when the engine silently reuses the name', async () => {
    const state: FakeEngineState = {
      containers: [],
      networks: [],
      volumes: [{ name: 'dsh-wrapvm-env-1-data', driver: 'local', createdAt: '2026-01-01T00:00:00Z', labels: { 'app.kubernetes.io/managed-by': 'someone-else' } }],
    }
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-foreign')
    expect(settled.error).toMatch(/volume/)
    // The foreign volume kept its own labels and data: nothing was applied to it.
    expect(state.volumes[0]?.labels[VOLUME_TOKEN_LABEL]).toBeUndefined()
    expect(callsFor(engine.calls, 'create')).toHaveLength(0)
  })

  it('adopts a crash-retry network and volume only after verifying their labels', async () => {
    const state = ownedState()
    state.containers = []
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('completed')
    expect(settled.target?.networkId).toBe(NETWORK_ID)
    expect(settled.target?.volumeToken).toBe(VOLUME_TOKEN_OLD)
    // The reused volume kept the token the earlier attempt minted, not a fresh one.
    expect(engine.state.volumes[0]?.labels[VOLUME_TOKEN_LABEL]).toBe(VOLUME_TOKEN_OLD)
  })

  it('mints a creation-incarnation token on a fresh volume and captures it', async () => {
    const { backend, engine } = makeBackend({ containers: [], networks: [], volumes: [] })
    const settled = await backend.run(createOperation(), signal())
    expect(settled.state).toBe('completed')
    const minted = engine.state.volumes[0]?.labels[VOLUME_TOKEN_LABEL]
    expect(minted).toBeDefined()
    expect(settled.target?.volumeToken).toBe(minted)
    expect(settled.target?.volumeCreatedAt).toBe('2026-11-11T10:00:00Z')
  })
})

describe('removal revalidation before mutation', () => {
  it('removes owned resources and never names a host path in any argv', async () => {
    const { backend, engine } = makeBackend(ownedState())
    const settled = await backend.run(removeOperation(capturedTarget(), true), signal())
    expect(settled.state).toBe('completed')
    expect(engine.state.containers).toHaveLength(0)
    expect(engine.state.networks).toHaveLength(0)
    expect(engine.state.volumes).toHaveLength(0)
    expect(engine.calls.every(argv => argv.every(arg => !arg.startsWith('/Users/')))).toBe(true)
  })

  it('refuses a forged target addressing a foreign container', async () => {
    const foreign: FakeContainer = ownedContainer({
      id: CONTAINER_FOREIGN,
      name: 'other-app',
      environmentId: 'env-1',
      labels: { [OWNERSHIP_LABEL]: '1', [ENVIRONMENT_ID_LABEL]: 'env-7' },
    })
    const { backend, engine } = makeBackend({ containers: [foreign], networks: [], volumes: [] })
    const settled = await backend.run(removeOperation(capturedTarget({ containerId: CONTAINER_FOREIGN }), false), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-foreign')
    expect(callsFor(engine.calls, 'rm')).toHaveLength(0)
    expect(engine.state.containers.map(container => container.id)).toContain(CONTAINER_FOREIGN)
  })

  it('refuses to delete a network recreated since capture (same name, new id)', async () => {
    const state = ownedState()
    if (state.networks[0] !== undefined) state.networks[0] = { ...state.networks[0], id: NETWORK_ID_REPLACED }
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(removeOperation(capturedTarget(), false), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-conflict')
    expect(settled.error).toMatch(/recreated/)
    expect(callsFor(engine.calls, 'network', 'rm')).toHaveLength(0)
    expect(engine.state.networks.map(network => network.id)).toContain(NETWORK_ID_REPLACED)
  })

  it('refuses to delete a volume recreated since capture (fresh incarnation token)', async () => {
    const state = ownedState(VOLUME_TOKEN_NEW)
    const { backend, engine } = makeBackend(state)
    const settled = await backend.run(removeOperation(capturedTarget(), true), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-conflict')
    expect(settled.error).toMatch(/incarnation/)
    expect(callsFor(engine.calls, 'volume', 'rm')).toHaveLength(0)
    expect(engine.state.volumes[0]?.labels[VOLUME_TOKEN_LABEL]).toBe(VOLUME_TOKEN_NEW)
  })

  it('refuses volume deletion when the target never captured creation identity', async () => {
    const { backend, engine } = makeBackend(ownedState())
    const stale = capturedTarget()
    const noIdentity: EnvironmentTarget = {
      environmentId: stale.environmentId,
      containerId: stale.containerId,
      containerName: stale.containerName,
      networkName: stale.networkName,
      volumeName: stale.volumeName,
      ports: stale.ports,
      capturedAt: stale.capturedAt,
    }
    const settled = await backend.run(removeOperation(noIdentity, true), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-unverified')
    expect(settled.error).toMatch(/identity/)
    // Fail-closed BEFORE any mutation: the container is still there too.
    expect(callsFor(engine.calls, 'rm')).toHaveLength(0)
    expect(engine.state.containers).toHaveLength(1)
    expect(engine.state.volumes).toHaveLength(1)
  })

  it('does not remove resources a replacement container still uses', async () => {
    const state = ownedState()
    const { backend, engine } = makeBackend(state)
    // The captured container vanished and a replacement (different id) took its
    // name, network, and volume mount.
    const original = state.containers[0]
    if (original !== undefined) state.containers = [{ ...original, id: CONTAINER_B }]
    const settled = await backend.run(removeOperation(capturedTarget(), true), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('engine-unavailable')
    expect(settled.error).toMatch(/active endpoints|in use/)
    expect(engine.state.volumes).toHaveLength(1)
    expect(engine.state.networks).toHaveLength(1)
    expect(engine.state.containers.map(container => container.id)).toContain(CONTAINER_B)
  })

  it('never stops or starts a foreign container behind a stale target', async () => {
    const foreign: FakeContainer = ownedContainer({
      id: CONTAINER_FOREIGN,
      name: 'other-app',
      environmentId: 'env-1',
      labels: { [OWNERSHIP_LABEL]: '1', [ENVIRONMENT_ID_LABEL]: 'env-7' },
    })
    const { backend, engine } = makeBackend({ containers: [foreign], networks: [], volumes: [] })
    const operation: EnvironmentOperation = {
      id: 'op-stop',
      environmentId: env1,
      kind: 'stop',
      state: 'requested',
      target: capturedTarget({ containerId: CONTAINER_FOREIGN }),
    }
    const settled = await backend.run(operation, signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-foreign')
    expect(callsFor(engine.calls, 'stop')).toHaveLength(0)
    expect(engine.state.containers[0]?.status).toBe('running')
  })
})

describe('full-id matching across CLI surfaces', () => {
  it('reconciles a healthy container without truncated-id conflicts', async () => {
    const record: EnvironmentDescriptor = {
      id: env1,
      backend: 'docker',
      containerId: CONTAINER_A,
      ownership: 'plugin',
      image: 'ghcr.io/tobi/wrapvm:desktop',
      digest: 'sha256:aaaabbbbccccdddd',
      createdAt: 100,
      mounts: [],
      limits: { cpuMillis: 2_000, memoryBytes: 4 * 2 ** 30 },
      internetAccess: true,
    }
    const { backend, engine } = makeBackend(ownedState(), {}, [record])
    const confirmed = await backend.reconcile(signal())
    expect(confirmed.map(entry => entry.containerId)).toEqual([CONTAINER_A])
    const report = backend.reconciliationReport
    expect(report?.conflicts).toHaveLength(0)
    expect(report?.missing).toHaveLength(0)
    const ps = callsFor(engine.calls, 'ps')[0] ?? []
    expect(ps).toContain('--no-trunc')
  })

  it('keys stats rows by full id and drops rows for unrequested ids', async () => {
    const truncatedRow = JSON.stringify({ ID: CONTAINER_A.slice(0, 12), MemUsage: '1GiB / 4GiB', CPUPerc: '7.50%' })
    const { backend, engine } = makeBackend(ownedState(), {
      intercept: argv => argv[1] === 'stats' ? ok(truncatedRow) : undefined,
    })
    const rows = await backend.stats([CONTAINER_A], signal())
    expect(rows.size).toBe(0)
    const stats = callsFor(engine.calls, 'stats')[0] ?? []
    expect(stats).toContain('--no-trunc')
  })

  it('captureTarget returns full ids and observed identity', async () => {
    const { backend } = makeBackend(ownedState())
    const acquisition = await backend.captureTarget(env1, signal())
    expect(acquisition.kind).toBe('captured')
    if (acquisition.kind !== 'captured') return
    expect(acquisition.target.containerId).toBe(CONTAINER_A)
    expect(acquisition.target.networkId).toBe(NETWORK_ID)
    expect(acquisition.target.volumeToken).toBe(VOLUME_TOKEN_OLD)
    expect(acquisition.target.volumeCreatedAt).toBe('2026-11-10T09:00:00Z')
    expect(acquisition.target.imageDigest).toBe('sha256:aaaabbbbccccdddd')
  })

  it('captureTarget fails closed on multiple claimants', async () => {
    const state = ownedState()
    state.containers.push(ownedContainer({ id: CONTAINER_B, name: 'dsh-wrapvm-env-1-alt', environmentId: 'env-1' }))
    const { backend } = makeBackend(state)
    const acquisition = await backend.captureTarget(env1, signal())
    expect(acquisition.kind).toBe('conflicting')
  })
})

describe('control-plane trust boundary', () => {
  it('does not execute guest-controlled curl or treat its refusal as isolation evidence', async () => {
    const engine = fakeDockerEngine(ownedState(), { exec: () => fail(7, 'proxy refused connection') })
    const backend = new DockerEnvironmentBackend(engine.runner, defaultDockerBackendConfig, policy, { list: () => [] }, () => 1000)
    const health = await backend.probe(capturedTarget(), signal())
    expect(health.hostControlPlane.kind).toBe('unknown')
    expect(health.hostControlPlane.kind === 'unknown' && health.hostControlPlane.reason).toMatch(/trusted host-side/)
    expect(engine.calls.some(argv => argv.some(arg => arg.includes('172.17.0.1:8765')))).toBe(false)
  })
})

describe('update limits keep swap pinned', () => {
  it('passes --memory-swap equal to the new memory limit', async () => {
    const { backend, engine } = makeBackend(ownedState())
    const operation: EnvironmentOperation = {
      id: 'op-update',
      environmentId: env1,
      kind: 'update-limits',
      state: 'requested',
      target: capturedTarget(),
      payload: { kind: 'update-limits', limits: { cpuMillis: 3_000, memoryBytes: 3 * 2 ** 30 } },
    }
    const settled = await backend.run(operation, signal())
    expect(settled.state).toBe('completed')
    const update = callsFor(engine.calls, 'update')[0] ?? []
    const memoryIndex = update.indexOf('--memory')
    const swapIndex = update.indexOf('--memory-swap')
    expect(swapIndex).toBeGreaterThan(-1)
    expect(update[memoryIndex + 1]).toBe(String(3 * 2 ** 30))
    expect(update[swapIndex + 1]).toBe(update[memoryIndex + 1])
  })
})

describe('manager + driver composition (real modules, scripted engine)', () => {
  function makeManager(state: FakeEngineState, store: MemoryInventoryStore = new MemoryInventoryStore()) {
    const engine = fakeDockerEngine(state)
    const inventory = new Inventory(store)
    const backend = new DockerEnvironmentBackend(engine.runner, defaultDockerBackendConfig, policy, inventory, () => 1000)
    const bindings = new BindingRegistry(new MemoryBindingEventSink(), () => 1000)
    bindings.markComplete()
    const ports: ManagerPorts = {
      inventory,
      driver: backend,
      bindings,
      executions: new ExecutionLeaseRegistry(),
      mountPolicy: policy,
      budget: { totalCpuMillis: 8_000, totalMemoryBytes: 16 * 2 ** 30 },
      newId: () => env1,
      now: () => 1000,
    }
    const manager = new EnvironmentManager(ports)
    return { manager, engine, store, backend, inventory }
  }

  it('create persists the full inspected identity and a fresh manager reconciles without conflicts', async () => {
    const first = makeManager({ containers: [], networks: [], volumes: [] })
    await first.manager.initialize(signal())
    const settled = await first.manager.create(createInput, { idempotencyKey: 'k1' })
    expect(settled.state).toBe('completed')
    const createdId = first.engine.createdContainerIds[0]
    expect(settled.target?.containerId).toBe(createdId)
    const record = first.manager.get(env1)
    expect(record?.containerId).toBe(createdId)
    expect(record?.digest).toBe('sha256:aaaabbbbccccdddd')

    // A fresh process against the same durable store and engine: reconcile must
    // confirm the FULL id without a truncated-id conflict.
    const second = makeManager(first.engine.state, first.store)
    await second.manager.initialize(signal())
    const report = second.backend.reconciliationReport
    expect(report?.conflicts).toHaveLength(0)
    expect(report?.confirmed.map(entry => entry.containerId)).toEqual([createdId])
    expect(report?.missing).toHaveLength(0)
  })

  it('state transitions refuse when the container no longer claims the environment', async () => {
    const { manager, engine } = makeManager(ownedState())
    await manager.initialize(signal())
    // Adopt the observed container into the inventory through the real create.
    const adopted = await manager.create(createInput, { idempotencyKey: 'adopt' })
    expect(adopted.state).toBe('completed')

    const stopped = await manager.stop(env1, { userAction: true })
    expect(stopped.state).toBe('completed')
    expect(engine.state.containers[0]?.status).toBe('exited')

    // The container's labels were rewritten to another environment: no owned
    // resource claims env-1 anymore, so the start must refuse at admission
    // and no state transition may reach the engine.
    const container = engine.state.containers[0]
    if (container !== undefined) engine.state.containers[0] = { ...container, labels: ownedLabels('env-7') }
    const refused = await manager.start(env1)
    expect(refused.state).toBe('failed')
    expect(refused.errorCode).toBe('resource-missing')
    expect(callsFor(engine.calls, 'start')).toHaveLength(0)
    expect(engine.state.containers[0]?.status).toBe('exited')
  })

  it('remove with volume deletion completes when the preview captured the creation identity', async () => {
    const { manager, engine } = makeManager(ownedState())
    await manager.initialize(signal())
    const adopted = await manager.create(createInput, { idempotencyKey: 'adopt' })
    expect(adopted.state).toBe('completed')
    const preview = await manager.previewRemoval(env1, true)
    const settled = await manager.remove(env1, preview.confirmToken, true)
    expect(settled.state).toBe('completed')
    expect(engine.state.containers).toHaveLength(0)
    expect(engine.state.networks).toHaveLength(0)
    expect(engine.state.volumes).toHaveLength(0)
    expect(manager.get(env1)).toBeUndefined()
  })

  it('a volume recreated after the preview invalidates the approved removal', async () => {
    const { manager, engine } = makeManager(ownedState())
    await manager.initialize(signal())
    const adopted = await manager.create(createInput, { idempotencyKey: 'adopt' })
    expect(adopted.state).toBe('completed')
    const preview = await manager.previewRemoval(env1, true)
    // Between preview and confirmation the volume is recreated under the same
    // name and ownership labels with a fresh incarnation token.
    const volume = engine.state.volumes[0]
    if (volume !== undefined) volume.labels = ownedLabels('env-1', { [VOLUME_TOKEN_LABEL]: VOLUME_TOKEN_NEW })
    const refused = await manager.remove(env1, preview.confirmToken, true)
    expect(refused.state).toBe('failed')
    expect(['preview-stale', 'resource-conflict']).toContain(refused.errorCode)
    expect(callsFor(engine.calls, 'volume', 'rm')).toHaveLength(0)
    expect(engine.state.volumes[0]?.labels[VOLUME_TOKEN_LABEL]).toBe(VOLUME_TOKEN_NEW)
    expect(engine.state.containers).toHaveLength(1)
  })

  it('a volume recreated after capture invalidates the removal even with full identity', async () => {
    const { engine, backend } = makeManager(ownedState())
    const acquisition = await backend.captureTarget(env1, signal())
    expect(acquisition.kind).toBe('captured')
    if (acquisition.kind !== 'captured') return
    // Recreate the volume under the same name and labels with a fresh token.
    const volume = engine.state.volumes[0]
    if (volume !== undefined) volume.labels = ownedLabels('env-1', { [VOLUME_TOKEN_LABEL]: VOLUME_TOKEN_NEW })
    const settled = await backend.run(removeOperation(acquisition.target, true), signal())
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-conflict')
    expect(engine.state.volumes[0]?.labels[VOLUME_TOKEN_LABEL]).toBe(VOLUME_TOKEN_NEW)
  })
})
