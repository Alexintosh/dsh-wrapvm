import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SafetyRuntime } from '../../../core/tools/src/safety-latch.ts'
import { BindingRegistry, MemoryBindingEventSink } from '../src/binding.ts'
import type { EnvironmentBackendDriver } from '../src/environments.ts'
import { Inventory, MemoryInventoryStore } from '../src/inventory.ts'
import { EnvironmentManager, ExecutionLeaseRegistry } from '../src/lifecycle.ts'
import { GuestShell } from '../src/guest-shell.ts'
import { descriptorFor, env1, env2, fakeMountContext } from './fixtures/env-fixtures.ts'

let ctx: Context | undefined
let root = ''
afterEach(async () => { await ctx?.fiber.dispose(); if (root) await rm(root, { recursive: true, force: true }); ctx = undefined; root = '' })

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'wrapvm-guest-shell-'))
  const log = join(root, 'argv')
  const engine = join(root, 'engine')
  await writeFile(engine, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); await new Promise(resolve => setTimeout(resolve, 200)); process.stdout.write('guest');`)
  await chmod(engine, 0o700)
  ctx = new Context()
  await ctx.plugin(Subprocess)
  const store = new MemoryInventoryStore()
  const inventory = new Inventory(store)
  await inventory.initialize()
  await inventory.putDescriptor(descriptorFor(env1))
  await inventory.putDescriptor(descriptorFor(env2, { containerId: 'container-2' }))
  const bindings = new BindingRegistry(new MemoryBindingEventSink())
  bindings.markComplete()
  await bindings.bind('session-1', env1, 1)
  const driver: EnvironmentBackendDriver = {
    reconcile: async () => [],
    run: async operation => ({ ...operation, state: 'completed' }),
    probe: async () => ({ phase: 'running', shell: { kind: 'unknown', reason: 'not tested' }, browser: { kind: 'unknown', reason: 'not tested' }, desktop: { kind: 'unknown', reason: 'not tested' }, hostControlPlane: { kind: 'unknown', reason: 'not tested' } }),
    captureTarget: async id => ({ kind: 'captured', target: { environmentId: id, containerId: id === env1 ? 'container-1' : 'container-2', containerName: `vm-${id}`, networkName: `network-${id}`, volumeName: `volume-${id}`, ports: { viewerPort: 5001, cdpPort: 5002 }, capturedAt: 1 } }),
    verifyTarget: async () => ({ container: { kind: 'owned' }, network: { kind: 'owned' }, volume: { kind: 'owned' } }),
  }
  const leases = new ExecutionLeaseRegistry()
  const manager = new EnvironmentManager({ inventory, driver, bindings, executions: leases, mountPolicy: fakeMountContext(), budget: { totalCpuMillis: 10000, totalMemoryBytes: 20 * 2 ** 30 } })
  await manager.initialize(new AbortController().signal)
  const safety = new SafetyRuntime()
  safety.attachStore({ load: () => undefined, save: async () => {}, clear: async () => {} })
  const id = SessionId('session-1')
  safety.setProvider(id, { check: () => ({ kind: 'allow' }), admitted: () => {}, settled: () => {} })
  await safety.arm({ sessionKey: id, generation: 1, mode: 'activating', stage: 'closing-admission' }, { attemptId: 'a' })
  await safety.commit({ sessionKey: id, generation: 1, mode: 'protected', stage: 'idle', environmentId: env1 }, { attemptId: 'a' })
  return { ctx, log, engine, bindings, driver, leases, manager, safety }
}

it('holds the real lifecycle lease until guest termination is verified', async () => {
  const env = await setup()
  const guestExit = Promise.withResolvers<boolean>()
  const shell = new GuestShell({ ...env, backend: env.driver, binary: env.engine, guestEntrypoint: '/entry', defaultWorkdir: '/workspace', verifyEligibility: async () => {}, verifyGuestQuiescence: async () => await guestExit.promise })
  const running = shell.execute('session-1', { command: 'echo hi', timeoutMs: 10000 }, new AbortController().signal)
  await vi.waitFor(async () => { expect(await readFile(env.log, 'utf8')).toContain('container-1') })
  await env.bindings.bind('session-1', env2, 2)
  const result = await running
  expect(result.output).toBe('guest')
  expect(JSON.parse(await readFile(env.log, 'utf8'))).toContain('container-1')
  expect((await env.leases.withMutation(env1, false, async () => 'stopped')).kind).toBe('busy')
  guestExit.resolve(true)
  await vi.waitFor(async () => { expect((await env.leases.withMutation(env1, false, async () => 'stopped')).kind).toBe('executed') })
})

it('rejects a changed binding before spawning against any target', async () => {
  const env = await setup()
  const shell = new GuestShell({ ...env, backend: env.driver, binary: env.engine, guestEntrypoint: '/entry', defaultWorkdir: '/workspace', verifyEligibility: async () => { await env.bindings.bind('session-1', env2, 2) }, verifyGuestQuiescence: async () => true })
  await expect(shell.execute('session-1', { command: 'echo hi', timeoutMs: 10000 }, new AbortController().signal)).rejects.toThrow('binding changed')
  await expect(readFile(env.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
