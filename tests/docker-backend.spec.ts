/**
 * Docker backend tests against a scripted engine (no live daemon): exact
 * argv construction, fail-closed refusals, idempotent create adoption,
 * label/id-based reconciliation, honest health probes, and stats parsing.
 */
import { describe, expect, it } from 'vitest'
import { createDockerStatsSource } from '../src/telemetry.ts'
import {
  defaultDockerBackendConfig,
  DockerEnvironmentBackend,
  parseDockerBytes,
  parseDockerPercent,
  type EngineRunResult,
  type InventoryView,
} from '../src/docker-backend.ts'
import { asEnvironmentId, type EnvironmentCreateInput, type EnvironmentOperation, type EnvironmentTarget } from '../src/environments.ts'
import { descriptorFor, env1, env2, fakeEngine, fakeMountContext, inspectJson, ok } from './fixtures/env-fixtures.ts'

const policy = fakeMountContext({ approvedRoots: ['/Users/tester/projects'] })

function makeBackend(responder: (argv: readonly string[]) => EngineRunResult, records = [descriptorFor(env1)]) {
  const engine = fakeEngine(responder)
  const view: InventoryView = { list: () => records }
  const backend = new DockerEnvironmentBackend(engine.runner, defaultDockerBackendConfig, policy, view, () => 1000)
  return { backend, engine, records }
}

const createInput: EnvironmentCreateInput = {
  displayName: 'Primary',
  image: 'ghcr.io/tobi/wrapvm:desktop',
  limits: { cpuMillis: 1_500, memoryBytes: 2 * 2 ** 30 },
  internetAccess: true,
  mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/mnt/app', access: 'read-only' }],
  ports: { viewerPort: 55000, cdpPort: 55001 },
}

const createOperation = (overrides: Partial<EnvironmentOperation> = {}): EnvironmentOperation => ({
  id: 'op-1',
  environmentId: env1,
  kind: 'create',
  state: 'requested',
  payload: { kind: 'create', input: createInput },
  requestedAt: 900,
  ...overrides,
})

const target: EnvironmentTarget = {
  environmentId: env1,
  containerId: 'container-1',
  containerName: 'dsh-wrapvm-env-1',
  networkName: 'dsh-wrapvm-env-1',
  volumeName: 'dsh-wrapvm-env-1-data',
  ports: { viewerPort: 55000, cdpPort: 55001 },
  capturedAt: 900,
  networkId: 'net-full-1',
  volumeDriver: 'local',
  volumeToken: 'tok-1',
  volumeCreatedAt: '2026-11-10T09:00:00Z',
}

const stateOperation = (kind: EnvironmentOperation['kind'], payload?: EnvironmentOperation['payload']): EnvironmentOperation => ({
  id: 'op-state',
  environmentId: env1,
  kind,
  state: 'requested',
  target,
  ...(payload !== undefined ? { payload } : {}),
})

/** Canned owned-network inspect payload matching the fixture labels. */
const ownedNetworkJson = JSON.stringify({
  Name: 'dsh-wrapvm-env-1',
  Id: 'net-full-1',
  Driver: 'bridge',
  Internal: false,
  Labels: { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': 'env-1' },
})

/** Canned owned-volume inspect payload matching the fixture labels. */
const ownedVolumeJson = JSON.stringify({
  Name: 'dsh-wrapvm-env-1-data',
  Driver: 'local',
  CreatedAt: '2026-11-10T09:00:00Z',
  Labels: { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': 'env-1', 'dsh.wrapvm.volume-token': 'tok-1' },
})

/** Container inspect payload with the environment volume attached (adoption requires it). */
const runningInspectJson = inspectJson({
  Config: { Image: createInput.image, Labels: { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': 'env-1' }, Entrypoint: ['/entrypoint'], Cmd: null, Env: ['HOME=/home/user'], User: '' },
  HostConfig: { NetworkMode: 'dsh-wrapvm-env-1', DeviceRequests: null, DeviceCgroupRules: null, UTSMode: '', CgroupnsMode: 'private',
    PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '55000' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] },
    Memory: 2 * 2 ** 30, NanoCpus: 1.5e9, MemorySwap: 2 * 2 ** 30, PidsLimit: 512, Privileged: false, CapDrop: ['ALL'], CapAdd: ['CHOWN', 'FOWNER', 'SETUID', 'SETGID', 'KILL'], SecurityOpt: ['no-new-privileges:true'], PidMode: '', IpcMode: 'private', UsernsMode: '', Devices: [] },
  NetworkSettings: { Networks: { 'dsh-wrapvm-env-1': { NetworkID: 'net-full-1' } }, Ports: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '55000' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] } },
  Mounts: [{ Type: 'volume', Name: 'dsh-wrapvm-env-1-data', Destination: '/home/user/workspace', RW: true }, { Type: 'bind', Source: '/Users/tester/projects/app', Destination: '/mnt/app', RW: false }],
})

/** Responder for a healthy running container, with real network/volume inspects. */
const runningEngine = (argv: readonly string[]): EngineRunResult => {
  const sub = argv[1]
  if (sub === 'image' && argv[2] === 'inspect') return { exitCode: 0, stdout: JSON.stringify({ Id: 'sha256:aaaabbbbccccdddd', Config: { Entrypoint: ['/entrypoint'], Cmd: null, Env: ['HOME=/home/user'], User: '' } }), stderr: '' }
  if (sub === 'inspect') return { exitCode: 0, stdout: runningInspectJson, stderr: '' }
  if (sub === 'network' && argv[2] === 'inspect') return { exitCode: 0, stdout: ownedNetworkJson, stderr: '' }
  if (sub === 'volume' && argv[2] === 'inspect') return { exitCode: 0, stdout: ownedVolumeJson, stderr: '' }
  if (sub === 'exec') return { exitCode: 0, stdout: '', stderr: '' }
  if (sub === 'create') return { exitCode: 0, stdout: 'container-1\n', stderr: '' }
  return ok
}

describe('docker create', () => {
  it('builds an isolated, loopback-published, label-owned container', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const settled = await backend.run(createOperation(), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(settled.target?.containerId).toBe('container-1')
    expect(settled.target?.ports).toEqual({ viewerPort: 55000, cdpPort: 55001 })
    expect(settled.target?.imageDigest).toBe('sha256:aaaabbbbccccdddd')

    const create = engine.calls.find(argv => argv[1] === 'create')!
    expect(create).toBeDefined()
    expect(create).toContain('--name')
    expect(create).toContain('dsh-wrapvm-env-1')
    expect(create).toContain('--label')
    expect(create).toContain('dsh.wrapvm.environment=1')
    expect(create).toContain('dsh.wrapvm.environment-id=env-1')
    expect(create).toContain('-p')
    expect(create).toContain('127.0.0.1:55000:6080')
    expect(create).toContain('127.0.0.1:55001:9223')
    expect(create).toContain('--cpus')
    expect(create).toContain('1.500')
    expect(create).toContain('--memory')
    expect(create).toContain(String(2 * 2 ** 30))
    expect(create).toContain('--memory-swap')
    expect(create).toContain('--pids-limit')
    expect(create).toContain('--security-opt')
    expect(create).toContain('no-new-privileges')
    expect(create).toContain('--cap-drop')
    expect(create).toContain('ALL')
    expect(create).toContain('--restart')
    expect(create).toContain('no')
    expect(create).toContain('dsh-wrapvm-env-1-data:/home/user/workspace')
    // No privileged mode, no docker socket; the only host path is the approved,
    // canonicalized bind — never a home directory or the whole /Users tree.
    expect(create.some(arg => arg === '--privileged')).toBe(false)
    expect(create.some(arg => arg.includes('/var/run/docker.sock'))).toBe(false)
    // The approved mount is published with explicit --mount grammar: the
    // `-v host:guest,ro` form would mount READ-WRITE at a path ending in ",ro".
    expect(create).toContain('--mount')
    expect(create).toContain('type=bind,src=/Users/tester/projects/app,dst=/mnt/app,readonly')
    expect(create.filter(arg => /^\/Users\//.test(arg))).toEqual([])
    expect(create.some(arg => arg.endsWith(',ro'))).toBe(false)

    const network = engine.calls.find(argv => argv[1] === 'network' && argv[2] === 'create')!
    expect(network).not.toContain('--internal')
  })

  it('enforces the no-Internet declaration with an internal network', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const operation = createOperation({ payload: { kind: 'create', input: { ...createInput, internetAccess: false } } })
    const settled = await backend.run(operation, new AbortController().signal)
    expect(settled.state).toBe('completed')
    const network = engine.calls.find(argv => argv[1] === 'network' && argv[2] === 'create')!
    expect(network).toContain('--internal')
  })

  it('refuses disk quotas with a precise code and no engine call', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const operation = createOperation({ payload: { kind: 'create', input: { ...createInput, limits: { ...createInput.limits, diskBytes: 10 * 2 ** 30 } } } })
    const settled = await backend.run(operation, new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('disk-quota-unsupported')
    expect(engine.calls).toHaveLength(0)
  })

  it('refuses mounts outside the approved roots before touching the engine', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const operation = createOperation({ payload: { kind: 'create', input: { ...createInput, mounts: [{ hostPath: '/Users/tester/.ssh', guestPath: '/mnt/keys', access: 'read-only' }] } } })
    const settled = await backend.run(operation, new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('mount-denied')
    expect(settled.error).toMatch(/blocked path|control path/)
    expect(engine.calls).toHaveLength(0)
  })

  it('refuses a mount that would shadow the persistent workspace volume', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const operation = createOperation({ payload: { kind: 'create', input: { ...createInput, mounts: [{ hostPath: '/Users/tester/projects/app', guestPath: '/home/user/workspace', access: 'read-write' }] } } })
    const settled = await backend.run(operation, new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('mount-denied')
    expect(settled.error).toMatch(/shadow/)
    expect(engine.calls).toHaveLength(0)
  })

  it('adopts an existing owned container instead of duplicating (crash retry)', async () => {
    const { backend, engine } = makeBackend((argv) => {
      if (argv[1] === 'ps') return { exitCode: 0, stdout: 'container-1\n', stderr: '' }
      return runningEngine(argv)
    })
    const settled = await backend.run(createOperation(), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(settled.target?.containerId).toBe('container-1')
    expect(engine.calls.some(argv => argv[1] === 'create')).toBe(false)
    expect(engine.calls.some(argv => argv[1] === 'network' && argv[2] === 'create')).toBe(false)
    expect(engine.calls.some(argv => argv[1] === 'volume' && argv[2] === 'create')).toBe(false)
  })

  it('tolerates already-exists on network/volume re-runs', async () => {
    const { backend } = makeBackend((argv) => {
      if ((argv[1] === 'network' || argv[1] === 'volume') && argv[2] === 'create') return { exitCode: 1, stdout: '', stderr: 'Error response from daemon: dsh-wrapvm-env-1 already exists' }
      return runningEngine(argv)
    })
    const settled = await backend.run(createOperation(), new AbortController().signal)
    expect(settled.state).toBe('completed')
  })

  it('fails the operation when create itself fails', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'create') return { exitCode: 125, stdout: '', stderr: 'manifest unknown' }
      return runningEngine(argv)
    })
    const settled = await backend.run(createOperation(), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.error).toMatch(/manifest unknown/)
  })

  it('refuses identical requested host ports', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const operation = createOperation({ payload: { kind: 'create', input: { ...createInput, ports: { viewerPort: 7000, cdpPort: 7000 } } } })
    const settled = await backend.run(operation, new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('port-conflict')
    expect(engine.calls).toHaveLength(0)
  })
})

describe('docker state transitions', () => {
  const statusEngine = (status: string) => (argv: readonly string[]): EngineRunResult => {
    if (argv[1] === 'inspect') return { exitCode: 0, stdout: inspectJson({ State: { Status: status } }), stderr: '' }
    return ok
  }

  it('starts a stopped container by immutable id', async () => {
    const { backend, engine } = makeBackend(statusEngine('exited'))
    const settled = await backend.run(stateOperation('start'), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(engine.calls.some(argv => argv[1] === 'start' && argv[2] === 'container-1')).toBe(true)
  })

  it('treats start on a running container as a no-op', async () => {
    const { backend, engine } = makeBackend(statusEngine('running'))
    const settled = await backend.run(stateOperation('start'), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(engine.calls.some(argv => argv[1] === 'start')).toBe(false)
  })

  it('refuses to start a paused container, pointing at resume', async () => {
    const { backend } = makeBackend(statusEngine('paused'))
    const settled = await backend.run(stateOperation('start'), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('invalid-transition')
    expect(settled.error).toMatch(/resume/)
  })

  it('refuses to pause a stopped container', async () => {
    const { backend } = makeBackend(statusEngine('exited'))
    const settled = await backend.run(stateOperation('pause'), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('invalid-transition')
  })

  it('pauses a running container (RAM kept)', async () => {
    const { backend, engine } = makeBackend(statusEngine('running'))
    const settled = await backend.run(stateOperation('pause'), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(engine.calls.some(argv => argv[1] === 'pause' && argv[2] === 'container-1')).toBe(true)
  })

  it('resumes a paused container via unpause', async () => {
    const { backend, engine } = makeBackend(statusEngine('paused'))
    const settled = await backend.run(stateOperation('resume'), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(engine.calls.some(argv => argv[1] === 'unpause' && argv[2] === 'container-1')).toBe(true)
  })

  it('refuses resume on a stopped container', async () => {
    const { backend } = makeBackend(statusEngine('exited'))
    const settled = await backend.run(stateOperation('resume'), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('invalid-transition')
  })

  it('fails when the container vanished', async () => {
    const { backend } = makeBackend(argv => argv[1] === 'inspect' ? { exitCode: 1, stdout: '', stderr: 'No such object' } : ok)
    const settled = await backend.run(stateOperation('stop'), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('container-missing')
  })

  it('updates CPU/RAM but refuses disk quotas', async () => {
    const { backend, engine } = makeBackend(statusEngine('running'))
    const settled = await backend.run(stateOperation('update-limits', { kind: 'update-limits', limits: { cpuMillis: 3_000, memoryBytes: 3 * 2 ** 30 } }), new AbortController().signal)
    expect(settled.state).toBe('completed')
    const update = engine.calls.find(argv => argv[1] === 'update')!
    expect(update).toContain('3.000')
    expect(update).toContain(String(3 * 2 ** 30))
    expect(update).toContain('container-1')

    const refused = await backend.run(stateOperation('update-limits', { kind: 'update-limits', limits: { cpuMillis: 3_000, memoryBytes: 3 * 2 ** 30, diskBytes: 2 ** 30 } }), new AbortController().signal)
    expect(refused.state).toBe('failed')
    expect(refused.errorCode).toBe('disk-quota-unsupported')
  })
})

describe('docker remove', () => {
  /** Container gone; network and volume still inspectable as owned resources. */
  const goneEngine = (argv: readonly string[]): EngineRunResult => {
    if (argv[1] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such object' }
    if (argv[1] === 'network' && argv[2] === 'inspect') return { exitCode: 0, stdout: ownedNetworkJson, stderr: '' }
    if (argv[1] === 'volume' && argv[2] === 'inspect') return { exitCode: 0, stdout: ownedVolumeJson, stderr: '' }
    return ok
  }

  it('keeps the volume unless the caller explicitly chooses deletion', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const settled = await backend.run(stateOperation('remove', { kind: 'remove', deleteVolumes: false }), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(engine.calls.some(argv => argv[1] === 'rm')).toBe(true)
    expect(engine.calls.some(argv => argv[1] === 'network' && argv[2] === 'rm')).toBe(true)
    expect(engine.calls.some(argv => argv[1] === 'volume' && argv[2] === 'rm')).toBe(false)
    // Host directories are never deleted: no argv names a host path.
    expect(engine.calls.every(argv => argv.every(arg => !arg.startsWith('/Users/')))).toBe(true)
  })

  it('deletes the named volume on explicit choice', async () => {
    const { backend, engine } = makeBackend(runningEngine)
    const settled = await backend.run(stateOperation('remove', { kind: 'remove', deleteVolumes: true }), new AbortController().signal)
    expect(settled.state).toBe('completed')
    expect(engine.calls.some(argv => argv[1] === 'volume' && argv[2] === 'rm' && argv[3] === 'dsh-wrapvm-env-1-data')).toBe(true)
  })

  it('tolerates a container that vanished before the removal reached it', async () => {
    const { backend, engine } = makeBackend(goneEngine)
    const settled = await backend.run(stateOperation('remove', { kind: 'remove', deleteVolumes: false }), new AbortController().signal)
    expect(settled.state).toBe('completed')
    // The container was already gone: no rm call, but the owned network is still removed.
    expect(engine.calls.some(argv => argv[1] === 'rm')).toBe(false)
    expect(engine.calls.some(argv => argv[1] === 'network' && argv[2] === 'rm')).toBe(true)
  })

  it('requires an explicit volume decision', async () => {
    const { backend } = makeBackend(runningEngine)
    const settled = await backend.run(stateOperation('remove'), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.error).toMatch(/deleteVolumes/)
  })

  it('refuses to delete a network whose labels contradict ownership', async () => {
    const foreignNetwork = JSON.stringify({ Name: 'dsh-wrapvm-env-1', Id: 'net-full-1', Driver: 'bridge', Labels: { 'app.kubernetes.io/managed-by': 'someone-else' } })
    const { backend, engine } = makeBackend((argv) => {
      const base = goneEngine(argv)
      if (argv[1] === 'network' && argv[2] === 'inspect') return { exitCode: 0, stdout: foreignNetwork, stderr: '' }
      return base
    })
    const settled = await backend.run(stateOperation('remove', { kind: 'remove', deleteVolumes: false }), new AbortController().signal)
    expect(settled.state).toBe('failed')
    expect(settled.errorCode).toBe('resource-foreign')
    expect(engine.calls.some(argv => argv[1] === 'network' && argv[2] === 'rm')).toBe(false)
  })
})

describe('docker reconciliation', () => {
  const ownedRow = (id: string, _envId: string) => JSON.stringify({ ID: id, State: 'running', Image: 'ghcr.io/tobi/wrapvm:desktop' })

  it('splits confirmed, unregistered, and missing without touching foreign containers', async () => {
    const records = [descriptorFor(env1), descriptorFor(env2, { containerId: 'container-2' })]
    const { backend, engine } = makeBackend((argv) => {
      if (argv[1] === 'ps') return { exitCode: 0, stdout: `${ownedRow('container-1', 'env-1')}\n${ownedRow('container-9', 'env-9')}\n`, stderr: '' }
      if (argv[1] === 'inspect') {
        const which = argv.at(-1)
        if (which === 'container-9') return { exitCode: 0, stdout: inspectJson({ Id: 'container-9', Config: { Image: 'ghcr.io/tobi/wrapvm:desktop', Labels: { 'dsh.wrapvm.environment': '1', 'dsh.wrapvm.environment-id': 'env-9' } } }), stderr: '' }
        return { exitCode: 0, stdout: inspectJson(), stderr: '' }
      }
      return ok
    }, records)
    const confirmed = await backend.reconcile(new AbortController().signal)
    expect(confirmed.map(record => record.id)).toEqual([env1])
    const report = backend.reconciliationReport!
    expect(report.unregistered.map(record => record.id)).toEqual([env9()])
    expect(report.missing).toEqual([env2])
    expect(report.conflicts).toHaveLength(0)
    // Listing is label-filtered: foreign containers are never even fetched.
    const ps = engine.calls.find(argv => argv[1] === 'ps')!
    expect(ps).toContain('label=dsh.wrapvm.environment=1')
    // Reconciliation never mutates.
    expect(engine.calls.every(argv => !['start', 'stop', 'rm', 'pause', 'unpause', 'create', 'remove'].includes(argv[1] ?? ''))).toBe(true)
  })

  it('reports a second container claiming the same environment id as a conflict', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'ps') return { exitCode: 0, stdout: `${ownedRow('container-1', 'env-1')}\n${ownedRow('container-1b', 'env-1')}\n`, stderr: '' }
      if (argv[1] === 'inspect') {
        const which = argv.at(-1)
        return { exitCode: 0, stdout: inspectJson({ Id: which }), stderr: '' }
      }
      return ok
    })
    await backend.reconcile(new AbortController().signal)
    const report = backend.reconciliationReport!
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]?.reason).toMatch(/second container/)
  })

  function env9() {
    return asEnvironmentId('env-9')
  }
})

describe('docker health probe honesty', () => {
  const probeTarget = target

  it('reports unknown isolation when the container is not running', async () => {
    const { backend } = makeBackend(argv => argv[1] === 'inspect' ? { exitCode: 0, stdout: inspectJson({ State: { Status: 'exited' } }), stderr: '' } : ok)
    const health = await backend.probe(probeTarget, new AbortController().signal)
    expect(health.phase).toBe('stopped')
    expect(health.hostControlPlane.kind).toBe('unknown')
    expect(health.hostControlPlane.kind === 'unknown' && health.hostControlPlane.reason).toMatch(/cannot be observed/)
  })

  it('keeps host control-plane unverified despite guest command responses', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'inspect') return { exitCode: 0, stdout: inspectJson(), stderr: '' }
      if (argv[1] === 'exec') {
        if (argv.includes('curl') && (argv.includes('http://172.17.0.1:8765/') || argv.includes('http://host.docker.internal:8765/'))) {
          return { exitCode: 7, stdout: '', stderr: 'Failed to connect' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return ok
    })
    const health = await backend.probe(probeTarget, new AbortController().signal)
    expect(health.phase).toBe('running')
    expect(health.shell).toEqual({ kind: 'available' })
    expect(health.browser).toEqual({ kind: 'available' })
    expect(health.desktop).toEqual({ kind: 'available' })
    expect(health.hostControlPlane.kind).toBe('unknown')
    expect(health.observedAt).toBe(1000)
    expect(health.target).toBe(probeTarget)
  })

  it('does not rely on guest output to verify the host control plane', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'inspect') return { exitCode: 0, stdout: inspectJson(), stderr: '' }
      if (argv[1] === 'exec' && argv.includes('http://172.17.0.1:8765/')) return { exitCode: 0, stdout: '{"hello":"host"}', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const health = await backend.probe(probeTarget, new AbortController().signal)
    expect(health.hostControlPlane.kind).toBe('unknown')
  })

  it('reports unknown when a control-plane probe cannot prove unreachability', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'inspect') return { exitCode: 0, stdout: inspectJson(), stderr: '' }
      if (argv[1] === 'exec' && argv.includes('curl') && argv.some(arg => arg.includes('8765'))) return { exitCode: 127, stdout: '', stderr: 'curl: command not found' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const health = await backend.probe(probeTarget, new AbortController().signal)
    expect(health.hostControlPlane.kind).toBe('unknown')
    expect(health.hostControlPlane.kind === 'unknown' && health.hostControlPlane.reason).toMatch(/trusted host-side/)
  })

  it('reports unknown for services whose exec could not run', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'inspect') return { exitCode: 0, stdout: inspectJson(), stderr: '' }
      if (argv[1] === 'exec') throw new Error('engine unreachable')
      return ok
    })
    const health = await backend.probe(probeTarget, new AbortController().signal)
    expect(health.shell.kind).toBe('unknown')
    expect(health.browser.kind).toBe('unknown')
    expect(health.hostControlPlane.kind).toBe('unknown')
  })
})

describe('docker stats parsing', () => {
  it('parses binary and SI byte cells', () => {
    expect(parseDockerBytes('1.5GiB')).toBe(1.5 * 1024 ** 3)
    expect(parseDockerBytes('12.3MB')).toBe(12.3e6)
    expect(parseDockerBytes('0B')).toBe(0)
    expect(parseDockerBytes('--')).toBeNull()
    expect(parseDockerBytes('')).toBeNull()
  })

  it('parses percentage cells', () => {
    expect(parseDockerPercent('12.34%')).toBe(12.34)
    expect(parseDockerPercent('--')).toBeNull()
  })

  it('collects a bounded batch and drops unparsable rows', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'stats') {
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ ID: 'container-1', MemUsage: '1GiB / 4GiB', CPUPerc: '7.50%' }),
            'not-json',
          ].join('\n'),
          stderr: '',
        }
      }
      return ok
    })
    const rows = await backend.stats(['container-1', 'container-2'], new AbortController().signal)
    expect(rows.get('container-1')).toEqual({ memoryUsedBytes: 1024 ** 3, memoryLimitBytes: 4 * 1024 ** 3, cpuPercent: 7.5 })
    expect(rows.has('container-2')).toBe(false)
  })

  it('reads the writable layer size', async () => {
    const { backend } = makeBackend(argv => argv[1] === 'ps' ? { exitCode: 0, stdout: '12.5MB (virtual 1.1GB)\n', stderr: '' } : ok)
    expect(await backend.writableLayerSize('container-1', new AbortController().signal)).toBe(12.5e6)
  })

  it('feeds the telemetry stats source with nulls for unobserved values', async () => {
    const { backend } = makeBackend((argv) => {
      if (argv[1] === 'stats') return { exitCode: 1, stdout: '', stderr: 'engine busy' }
      if (argv[1] === 'ps') return { exitCode: 1, stdout: '', stderr: 'no' }
      return ok
    })
    const source = createDockerStatsSource(
      (ids, signal) => backend.stats(ids, signal),
      (id, signal) => backend.writableLayerSize(id, signal),
      () => 'container-1',
    )
    const measurements = await source.measure([env1], new AbortController().signal)
    const sample = measurements.get(env1)!
    expect(sample).toEqual({
      memoryUsedBytes: null, memoryLimitBytes: null, cpuPercent: null, writableLayerBytes: null, volumeUsedBytes: null,
    })
  })
})

describe('engine availability', () => {
  it('reports false when the daemon does not answer', async () => {
    const { backend } = makeBackend(() => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }))
    expect(await backend.engineAvailable(new AbortController().signal)).toBe(false)
  })

  it('reports true on a healthy daemon', async () => {
    const { backend } = makeBackend(() => ({ exitCode: 0, stdout: '27.4.0\n', stderr: '' }))
    expect(await backend.engineAvailable(new AbortController().signal)).toBe(true)
  })
})


it('captures stopped owned resources without runtime ports and rejects non-loopback publication', async () => {
  const bindings = { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }
  const stopped = (portBindings: object) => inspectJson({ State: { Status: 'exited' }, HostConfig: { NetworkMode: 'dsh-wrapvm-env-1', PortBindings: portBindings }, NetworkSettings: { Networks: { 'dsh-wrapvm-env-1': { NetworkID: '' } }, Ports: {} }, Mounts: [{ Type: 'volume', Name: 'dsh-wrapvm-env-1-data', Destination: '/home/user/workspace', RW: true }] })
  const make = (portBindings: object) => makeBackend(argv => {
    if (argv[1] === 'ps') return { ...ok, stdout: 'container-1' }
    if (argv[1] === 'inspect') return { ...ok, stdout: stopped(portBindings) }
    return runningEngine(argv)
  }).backend
  const accepted = await make(bindings).captureTarget(env1, new AbortController().signal)
  expect(accepted).toMatchObject({ kind: 'captured', target: { containerId: 'container-1', ports: { viewerPort: 0, cdpPort: 0 } } })
  const refused = await make({ ...bindings, '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '' }] }).captureTarget(env1, new AbortController().signal)
  expect(refused).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('loopback') })
})
