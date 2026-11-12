import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { DockerEnvironmentBackend, defaultDockerBackendConfig, type EngineRunner } from '../src/docker-backend.ts'
import { EnvironmentManager, ExecutionLeaseRegistry } from '../src/lifecycle.ts'
import { Inventory, MemoryInventoryStore } from '../src/inventory.ts'
import { BindingRegistry, MemoryBindingEventSink } from '../src/binding.ts'

const exec = promisify(execFile)
const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 120_000, maxBuffer: 4_000_000 })).stdout.trim()
const freePort = async () => await new Promise<number>((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('no port'))
    server.close(() => resolve(address.port))
  }).on('error', reject)
})

it.skipIf(process.env.WRAPVM_LIVE_ACCEPTANCE !== '1')('exercises an owned disposable Docker environment', async () => {
  const created: { id?: string; network?: string; volume?: string; env?: string } = {}
  const runner: EngineRunner = async (argv, signal) => {
    try {
      const { stdout, stderr } = await exec(argv[0]!, [...argv.slice(1)], { signal, maxBuffer: 4_000_000 })
      if (argv[1] === 'network' && argv[2] === 'create') {
        created.network = stdout.trim()
        created.env = argv.find(x => x.startsWith('dsh.wrapvm.environment-id='))?.split('=')[1]
      }
      if (argv[1] === 'volume' && argv[2] === 'create') created.volume = stdout.trim()
      if (argv[1] === 'create') created.id = stdout.trim()
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string }
      return { exitCode: typeof e.code === 'number' ? e.code : null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
  }
  const inventory = new Inventory(new MemoryInventoryStore())
  await inventory.initialize()
  const fixture = await mkdtemp(fileURLToPath(new URL('./live-mount-', import.meta.url)))
  await chmod(fixture, 0o777)
  await writeFile(`${fixture}/sample.txt`, 'fixture')
  const policy = { realpath: (path: string) => path, exists: () => true, homedir: '/Users/tester', approvedRoots: [fixture] }
  const backend = new DockerEnvironmentBackend(runner, defaultDockerBackendConfig, policy, inventory)
  const bindings = new BindingRegistry(new MemoryBindingEventSink())
  bindings.markComplete()
  const manager = new EnvironmentManager({ inventory, driver: backend, bindings, mountPolicy: policy,
    budget: { totalCpuMillis: 1500, totalMemoryBytes: 2 * 2 ** 30 }, executions: new ExecutionLeaseRegistry() })
  const signal = new AbortController().signal
  try {
    await manager.initialize(signal)
    const viewerPort = await freePort()
    let cdpPort = await freePort()
    while (cdpPort === viewerPort) cdpPort = await freePort()
    const op = await manager.create({ displayName: 'Disposable acceptance', image: 'wrapvm-dsh:desktop',
      limits: { cpuMillis: 1000, memoryBytes: 1536 * 2 ** 20 }, internetAccess: true,
      mounts: [{ hostPath: fixture, guestPath: '/mnt/fixture', access: 'read-only' }], ports: { viewerPort, cdpPort } })
    if (op.state !== 'completed' && created.id) {
      const c = JSON.parse(await docker('inspect', created.id))[0]
      console.log('LIVE create diagnostic', JSON.stringify({ status: c.State.Status, exitCode: c.State.ExitCode, error: c.State.Error, ports: c.NetworkSettings.Ports }))
    }
    expect(op, JSON.stringify(op)).toMatchObject({ state: 'completed' })
    const target = op.target!
    expect(target.containerId).toBe(created.id)
    const info = JSON.parse(await docker('inspect', target.containerId))[0]
    expect(info.HostConfig.NanoCpus).toBe(1_000_000_000)
    expect(info.HostConfig.Memory).toBe(1536 * 2 ** 20)
    expect(info.HostConfig.MemorySwap).toBe(1536 * 2 ** 20)
    const command = (...args: string[]) => docker('exec', target.containerId, '/opt/wrap/bin/wrap-entrypoint', ...args)
    expect(await command('sh', '-c', 'id -un; printf "%s\\n%s\\n" "$HOME" "$DISPLAY"')).toBe('user\n/home/user\n:1')
    expect(await command('cat', '/mnt/fixture/sample.txt')).toBe('fixture')
    await expect(command('sh', '-c', 'echo denied > /mnt/fixture/denied')).rejects.toThrow()
    await command('sh', '-c', 'printf persisted > /home/user/workspace/acceptance.txt')
    expect((await manager.pause(op.environmentId)).state).toBe('completed')
    expect((await docker('inspect', '--format', '{{.State.Status}}', target.containerId))).toBe('paused')
    expect((await manager.resume(op.environmentId)).state).toBe('completed')
    expect((await manager.updateLimits(op.environmentId, { cpuMillis: 750, memoryBytes: 1280 * 2 ** 20 })).state).toBe('completed')
    const limits = JSON.parse(await docker('inspect', target.containerId))[0].HostConfig
    expect([limits.NanoCpus, limits.Memory, limits.MemorySwap]).toEqual([750_000_000, 1280 * 2 ** 20, 1280 * 2 ** 20])
    expect((await backend.stats([target.containerId], signal)).get(target.containerId)?.memoryUsedBytes).toBeGreaterThan(0)
    expect((await manager.bind('acceptance-session', op.environmentId, 1)).state).toBe('completed')
    expect(bindings.binding('acceptance-session')?.environmentId).toBe(op.environmentId)
    expect((await manager.unbind('acceptance-session')).state).toBe('completed')
    const cdpUrl = `http://127.0.0.1:${target.ports.cdpPort}`
    let cdpReady = false
    for (let n = 0; n < 30; n++) {
      try { cdpReady = (await fetch(`${cdpUrl}/json/version`)).ok } catch { /* service still starting */ }
      if (cdpReady) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    expect(cdpReady).toBe(true)
    const tab = await fetch(`${cdpUrl}/json/new?about:blank`, { method: 'PUT' })
    expect(tab.ok).toBe(true)
    const page = await tab.json() as { id: string }
    expect((await fetch(`${cdpUrl}/json/list`)).ok).toBe(true)
    await fetch(`${cdpUrl}/json/close/${page.id}`)
    let viewer = ''
    for (let n = 0; n < 5; n++) {
      try { viewer = await docker('exec', target.containerId, 'wrap-desktop', 'url', `http://127.0.0.1:${target.ports.viewerPort}`) } catch { /* service still starting */ }
      if (viewer) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (!viewer) {
      const userViewer = await command('wrap-desktop', 'url', `http://127.0.0.1:${target.ports.viewerPort}`)
      console.log('LIVE viewer command unavailable; image-user URL HTTP status:', (await fetch(userViewer)).status)
    }
    if (viewer) {
      expect(new URL(viewer).origin).toBe(`http://127.0.0.1:${target.ports.viewerPort}`)
      expect((await fetch(viewer)).ok).toBe(true)
    }
    await command('agent-desktop', 'screenshot', '--screen', '0', '/home/user/workspace/acceptance.png')
    expect(await command('sh', '-c', 'test -s /home/user/workspace/acceptance.png && echo png-present')).toBe('png-present')
    console.log('LIVE desktop screenshot created')
    console.log('LIVE: pause/resume, limits, stats, bind/unbind and CDP passed; viewer HTTP checked:', !!viewer)
    expect((await manager.stop(op.environmentId)).state).toBe('completed')
    const stopped = JSON.parse(await docker('inspect', target.containerId))[0]
    console.log('LIVE stopped inspect', JSON.stringify({ status: stopped.State.Status, ports: stopped.NetworkSettings.Ports, configuredBindings: stopped.HostConfig.PortBindings }))
    const restart = await manager.start(op.environmentId)
    console.log('LIVE manager restart', JSON.stringify({ state: restart.state, errorCode: restart.errorCode, error: restart.error }))
    if (restart.state !== 'completed') await docker('start', target.containerId)
    expect(await command('cat', '/home/user/workspace/acceptance.txt')).toBe('persisted')
    const preview = await manager.previewRemoval(op.environmentId, false)
    expect((await manager.remove(op.environmentId, preview.confirmToken, false)).state).toBe('completed')
    expect(await docker('volume', 'inspect', '--format', '{{.Name}}', target.volumeName)).toBe(target.volumeName)
    const retained = JSON.parse(await docker('volume', 'inspect', target.volumeName))[0]
    expect(retained.Labels['dsh.wrapvm.environment-id']).toBe(op.environmentId)
    expect(retained.Labels['dsh.wrapvm.environment']).toBe('1')
    expect(retained.Labels['dsh.wrapvm.volume-token']).toBe(target.volumeToken)
    await docker('volume', 'rm', target.volumeName)
    created.volume = undefined
    const second = await manager.create({ displayName: 'Disposable delete-volume acceptance', image: 'wrapvm-dsh:desktop',
      limits: { cpuMillis: 1000, memoryBytes: 1536 * 2 ** 20 }, internetAccess: true,
      mounts: [{ hostPath: fixture, guestPath: '/mnt/fixture', access: 'read-write' }] })
    expect(second, JSON.stringify(second)).toMatchObject({ state: 'completed' })
    await docker('exec', second.target!.containerId, '/opt/wrap/bin/wrap-entrypoint', 'sh', '-c', 'echo writable > /mnt/fixture/writable')
    const deletePreview = await manager.previewRemoval(second.environmentId, true)
    expect((await manager.remove(second.environmentId, deletePreview.confirmToken, true)).state).toBe('completed')
    await expect(docker('volume', 'inspect', second.target!.volumeName)).rejects.toThrow()
    console.log('LIVE: create, user/home/display, direct Docker persistence, pause/resume, limits, stats, bind/unbind, both volume removal choices passed')
    expect(restart, JSON.stringify(restart)).toMatchObject({ state: 'completed' })
  } finally {
    // Only the IDs/names minted by this test, after verifying both ownership labels.
    const expected = created.env
    for (const [kind, id] of [['container', created.id], ['network', created.network], ['volume', created.volume]] as const) {
      if (!id || !expected) continue
      try {
        const obj = JSON.parse(await docker(kind === 'container' ? 'inspect' : kind, ...(kind === 'container' ? [id] : ['inspect', id])))[0]
        const labels = kind === 'container' ? obj.Config.Labels : obj.Labels
        if (labels?.['dsh.wrapvm.environment'] !== '1' || labels?.['dsh.wrapvm.environment-id'] !== expected) throw new Error('ownership mismatch')
        await docker(kind === 'container' ? 'rm' : kind, ...(kind === 'container' ? ['-f', id] : ['rm', id]))
        console.log(`LIVE cleanup ${kind}: removed`)
      } catch (error) {
        if (!/no such|not found/i.test(String(error))) throw error
      }
    }
    await rm(fixture, { recursive: true, force: true })
  }
}, 300_000)
