import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DockerEnvironmentBackend, defaultDockerBackendConfig } from '../src/docker-backend.ts'
import { asEnvironmentId, protectedModeRefusal, type EnvironmentCreateInput, type EnvironmentOperation } from '../src/environments.ts'
import { containerNameFor } from '../src/inventory.ts'
import { fakeMountContext, descriptorFor } from './fixtures/env-fixtures.ts'
import { fakeDockerEngine, ownedContainer, ownedLabels, type FakeContainer, type FakeEngineOptions } from './fixtures/backend-review-fixtures.ts'

const id = asEnvironmentId('env-1')
const containerId = 'a'.repeat(64)
const networkId = 'b'.repeat(64)
const input: EnvironmentCreateInput = {
  displayName: 'Test', image: 'ghcr.io/tobi/wrapvm:desktop', internetAccess: true, mounts: [],
  limits: { cpuMillis: 1500, memoryBytes: 2 * 2 ** 30 }, ports: { viewerPort: 55000, cdpPort: 55001 },
}
const operation: EnvironmentOperation = {
  id: 'recover', environmentId: id, kind: 'create', state: 'requested', payload: { kind: 'create', input },
}
const signal = () => new AbortController().signal

function setup(changes: Partial<FakeContainer> = {}, options: FakeEngineOptions = {}) {
  const name = containerNameFor(id)
  const container = ownedContainer({
    id: containerId, name, environmentId: id, status: 'created', networks: { [name]: { NetworkID: '' } }, ...changes,
  })
  const engine = fakeDockerEngine({
    containers: [container], networks: [{ name, id: networkId, labels: ownedLabels('env-1'), internal: false }],
    volumes: [{ name: 'dsh-wrapvm-env-1-data', driver: 'local', createdAt: '2026-11-10T09:00:00Z', labels: ownedLabels('env-1') }],
  }, options)
  const backend = new DockerEnvironmentBackend(
    engine.runner, defaultDockerBackendConfig, fakeMountContext(), { list: () => [] }, () => 1000,
  )
  return { engine, backend }
}

describe('recovery adoption and trusted observations', () => {
  it('recovers a never-started container with no runtime ports and verifies bindings after start', async () => {
    const { engine, backend } = setup()
    const result = await backend.run(operation, signal())
    expect(result.state).toBe('completed')
    expect(result.target?.ports).toEqual(input.ports)
    expect(engine.calls.filter(call => call[1] === 'start')).toHaveLength(1)
    expect(engine.calls.filter(call => call[1] === 'inspect').length).toBeGreaterThanOrEqual(2)
  })

  it('recovers ephemeral port intent from configured bindings and captures allocated runtime ports', async () => {
    const { backend } = setup({ configuredPorts: {
      '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
    } })
    const { ports: _ports, ...ephemeral } = input
    const result = await backend.run({ ...operation, payload: { kind: 'create', input: ephemeral } }, signal())
    expect(result.state).toBe('completed')
    expect(result.target?.ports).toEqual({ viewerPort: 55000, cdpPort: 55001 })
  })

  it.each(['exited', 'paused'])('does not restart or adopt a %s container', async (status) => {
    const { backend, engine } = setup({ status })
    expect((await backend.run(operation, signal())).state).toBe('failed')
    expect(engine.calls.some(call => call[1] === 'start')).toBe(false)
  })

  it.each([
    ['root environment', { env: ['WRAP_UID=0', 'WRAP_GID=0', 'HOME=/home/user'] }],
    ['root user override', { user: '0' }],
    ['host UTS namespace', { hostConfig: { UTSMode: 'host' } }],
    ['host cgroup namespace', { hostConfig: { CgroupnsMode: 'host' } }],
    ['read-only workspace', { mounts: [{ Type: 'volume', Name: 'dsh-wrapvm-env-1-data', Destination: '/home/user/workspace', RW: false }] }],
    ['entrypoint override', { entrypoint: ['/bin/sh', '-c', 'sleep infinity'] }],
    ['command override', { cmd: ['sh'] }],
    ['device request', { hostConfig: { DeviceRequests: [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }] } }],
    ['device cgroup rule', { hostConfig: { DeviceCgroupRules: ['c 1:3 rwm'] } }],
    ['missing device security data', { hostConfig: { DeviceRequests: undefined } }],
    ['host port open to all', { hostConfig: { PortBindings: { '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '55000' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] } } }],
  ] satisfies Array<[string, Partial<FakeContainer>]>)('rejects %s before starting', async (_name, changes) => {
    const { backend, engine } = setup(changes)
    expect((await backend.run(operation, signal())).state).toBe('failed')
    expect(engine.calls.some(call => call[1] === 'start')).toBe(false)
  })

  it('rejects a missing workspace RW observation without starting', async () => {
    const { engine } = setup()
    const backend = new DockerEnvironmentBackend(async (argv, activeSignal) => {
      const result = await engine.runner(argv, activeSignal)
      if (argv[1] !== 'inspect' || result.exitCode !== 0) return result
      const payload = z.looseObject({ Mounts: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(result.stdout))
      const mount = payload.Mounts[0]
      if (mount !== undefined) delete mount.RW
      return { ...result, stdout: JSON.stringify(payload) }
    }, defaultDockerBackendConfig, fakeMountContext(), { list: () => [] })
    expect((await backend.run(operation, signal())).errorCode).toBe('resource-conflict')
    expect(engine.calls.some(call => call[1] === 'start')).toBe(false)
  })

  it('honors cancellation before starting a recovered container', async () => {
    const controller = new AbortController()
    const { backend, engine } = setup({}, { intercept: (argv) => {
      if (argv[1] === 'network' && argv[2] === 'inspect') controller.abort()
      return undefined
    } })
    await expect(backend.run(operation, controller.signal)).rejects.toBeDefined()
    expect(engine.calls.some(call => call[1] === 'start')).toBe(false)
  })

  it('rejects a different pre-start network id', async () => {
    const { backend, engine } = setup({ networks: { [containerNameFor(id)]: { NetworkID: 'unexpected-id' } } })
    expect((await backend.run(operation, signal())).errorCode).toBe('resource-conflict')
    expect(engine.calls.some(call => call[1] === 'start')).toBe(false)
  })

  it('rejects missing image inspection evidence without starting', async () => {
    const { backend, engine } = setup({}, { intercept: argv => argv[1] === 'image' ? { exitCode: 1, stdout: '', stderr: 'not found' } : undefined })
    expect((await backend.run(operation, signal())).errorCode).toBe('resource-unverified')
    expect(engine.calls.some(call => call[1] === 'start')).toBe(false)
  })

  it('rejects a non-loopback runtime binding even after safe configured bindings', async () => {
    const { backend } = setup({
      ports: { '6080/tcp': [{ HostIp: '0.0.0.0', HostPort: '55000' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] },
      configuredPorts: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '55000' }], '9223/tcp': [{ HostIp: '127.0.0.1', HostPort: '55001' }] },
    })
    expect((await backend.run(operation, signal())).errorCode).toBe('resource-conflict')
  })

  it('does not accept forged guest refusal as a protected-mode observation', async () => {
    const { backend } = setup({ status: 'running', networks: { [containerNameFor(id)]: { NetworkID: networkId } } }, { exec: argv => argv.includes('true') || argv.some(arg => arg.includes('127.0.0.1'))
      ? { exitCode: 0, stdout: '', stderr: '' }
      : { exitCode: 7, stdout: '0.000000', stderr: 'proxy refused' } })
    const result = await backend.run(operation, signal())
    expect(result.target).toBeDefined()
    const health = await backend.probe(result.target!, signal())
    expect(health.hostControlPlane.kind).toBe('unknown')
    expect(protectedModeRefusal(descriptorFor(id), health)).toMatch(/control-plane isolation could not be verified/)
  })
})
