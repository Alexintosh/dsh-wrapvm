/** Real Loader, tool registry and subprocesses; only the external container engine is a fixture. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '../../../core/tools/src/index.ts'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '../../../storage/storage-domain/src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { wrapvmInventoryDomainSpec } from '../src/inventory.ts'
import { descriptorFor, env1 } from './fixtures/env-fixtures.ts'
import type { VmSessionView } from '../src/types.ts'
import Wrapvm from '../src/index.ts'
import { cdpServer } from './fixtures/cdp-server.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'wrapvm-test-guest': { readonly kind: 'wrapvm-test-guest' } }
}

let root: string
let ctx: Context | undefined
let cdp: Awaited<ReturnType<typeof cdpServer>> | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  await cdp?.close()
  if (root) await rm(root, { recursive: true, force: true })
  ctx = undefined
  cdp = undefined
})

async function load(config: { cdpPort?: number; containerName?: string } = {}, withRemote: boolean = false, withInventory: boolean = false, withSafety: boolean = false) {
  root = await mkdtemp(join(tmpdir(), 'wrapvm-loader-'))
  const engine = join(root, 'engine')
  await writeFile(engine, `#!${process.execPath}\n` + await readFile(new URL('./fixtures/engine.mjs', import.meta.url), 'utf8'))
  await chmod(engine, 0o700)
  await writeFile(join(root, 'state'), 'missing')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: 'cordis:prompt' }, { name: 'cordis:tools' }, { name: 'cordis:subprocess' },
    ...(withRemote ? [{ name: 'cordis:registry' }, { name: 'cordis:access' }, { name: 'cordis:gateway' }] : []),
    { id: 'wrapvm', name: 'cordis:wrapvm', config: { backend: engine, workspaceDir: root, ...config } },
  ]))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  if (withInventory) {
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    await ctx.plugin(StorageDomain, { backend: 'memory' })
    const domain = await ctx.storageDomain.open(StorageDomain.defineDomain(wrapvmInventoryDomainSpec))
    await domain.table('snapshots').put('current', { environments: { [env1]: descriptorFor(env1) }, operations: { unknown: { id: 'unknown', environmentId: env1, kind: 'stop', state: 'failed', errorCode: 'outcome-unknown', error: 'reconciliation required' } } })
    await domain.close()
  }
  if (withSafety) { await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(SessionStore) }
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, subprocess: Subprocess, wrapvm: Wrapvm, registry: TypertRegistry, access: RemoteAccessService, gateway: TypertGateway })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

it('loads bundled tools, runs lifecycle operations, preserves shell stderr and exit code, and unregisters on disposal', async () => {
  cdp = await cdpServer((command, peer) => {
    expect(command.method).toBe('Browser.getVersion')
    peer.send({ id: command.id, result: { product: 'Chrome/fixture' } })
  })
  const ctx = await load({ cdpPort: cdp.port })
  expect(ctx.tools.definitions().map(tool => tool.name).sort()).toEqual(['load_vm_skill', 'vm_browser', 'vm_desktop', 'vm_shell', 'vm_status'])
  expect((await ctx.wrapvmIsolate.status()).state).toBe('missing')
  expect((await ctx.wrapvmIsolate.start()).running).toBe(true)
  const result = await executeToolFixture(ctx, {
    callId: ToolCallId('vm-shell'), name: 'vm_shell', arguments: { command: 'echo test', description: 'Check guest' }, signal: new AbortController().signal,
  })
  expect(result.content).toMatchInlineSnapshot(`
    [
      {
        "text": "guest output

    guest diagnostic

    [exit code: 7]",
        "type": "text",
      },
    ]
  `)
  const commands = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(commands.find(args => args[0] === 'run')).toContain('127.0.0.1:6080:6080')
  expect(commands.find(args => args.includes('echo test'))).toEqual(['exec', '-w', '/home/user/workspace', 'wrapvm-isolate', '/opt/wrap/bin/wrap-entrypoint', 'timeout', '--kill-after=1s', '120s', 'sh', '-lc', 'echo test'])
  expect((await ctx.wrapvmIsolate.desktop({ argv: ['list-apps'] })).output).toBe('desktop applications')
  expect((await ctx.wrapvmIsolate.stop()).running).toBe(false)
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'wrapvm')
  expect(entry?.fiber).toBeDefined()
  await entry?.fiber?.dispose()
  expect(ctx.tools.definitions()).toEqual([])
}, 30_000)

it('loads only bundled VM guidance through the real tool executor', async () => {
  const ctx = await load()
  for (const skill of ['use-vm', 'vm-workspace', 'vm-browser', 'vm-desktop', 'vm-development', 'vm-recovery']) {
    const result = await executeToolFixture(ctx, {
      callId: ToolCallId(`skill-${skill}`), name: 'load_vm_skill', arguments: { skill }, signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('Do not fall back to Mac tools')
  }
  const rejected = await executeToolFixture(ctx, {
    callId: ToolCallId('skill-path'), name: 'load_vm_skill', arguments: { skill: '../../secret' }, signal: new AbortController().signal,
  })
  expect(rejected.isError).toBe(true)
})

it('joins the image user login environment and preserves desktop arguments literally', async () => {
  const ctx = await load()
  await writeFile(join(root, 'state'), 'running')
  const argv = ['snapshot', '--app', 'name with spaces; $(touch /tmp/never)', '--compact']
  const result = await executeToolFixture(ctx, {
    callId: ToolCallId('vm-desktop-login'), name: 'vm_desktop', arguments: { argv, timeoutMs: 5000 }, signal: new AbortController().signal,
  })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: 'desktop applications\n[exit code: 0]' }])
  const commands = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(commands.find(args => args.includes('agent-desktop'))).toEqual([
    'exec', 'wrapvm-isolate', '/opt/wrap/bin/wrap-entrypoint', 'timeout', '--kill-after=1s', '5s',
    'sh', '-lc', 'exec "$@"', 'wrapvm-desktop', 'agent-desktop', ...argv,
  ])
})

it('uses Chrome target endpoints and accepts the text close response', async () => {
  const ctx = await load()
  await writeFile(join(root, 'state'), 'running')
  expect(await ctx.wrapvmIsolate.cdpOpen('https://example.com/?a=1&b=2')).toEqual({ id: 'page-1' })
  expect(await ctx.wrapvmIsolate.cdpTargets()).toEqual([{ id: 'page-1', title: 'Test page', url: 'about:blank' }])
  expect(await ctx.wrapvmIsolate.cdpClose('page-1')).toEqual({ id: 'page-1' })
  const commands = await readFile(join(root, 'calls.jsonl'), 'utf8')
  expect(commands).toContain('/json/new?https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2')
})

it('reports engine failure rather than treating it as a missing container', async () => {
  const ctx = await load()
  await writeFile(join(root, 'state'), 'unavailable')
  await expect(ctx.wrapvmIsolate.start()).rejects.toThrow('engine unavailable')
  expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).not.toContain('"run"')
})

it('returns viewer credentials only to the dedicated UI method', async () => {
  const ctx = await load()
  expect(await ctx.wrapvmIsolate.viewerUrl()).toBeNull()
  await writeFile(join(root, 'state'), 'running')
  expect(await ctx.wrapvmIsolate.viewerUrl()).toBe('http://127.0.0.1:6080/?token=fixture-viewer-secret')
  const status = await executeToolFixture(ctx, {
    callId: ToolCallId('vm-status'), name: 'vm_status', arguments: {}, signal: new AbortController().signal,
  })
  expect(JSON.stringify(status)).not.toContain('fixture-viewer-secret')
  expect(JSON.stringify(status)).not.toContain('viewerUrl')
  expect((await ctx.wrapvmIsolate.status()).viewerUrl).toBeNull()
})

it('evaluates large CDP messages, reassembles fragmented replies and ignores browser events', async () => {
  const value = 'large browser content '.repeat(6000)
  const expression = JSON.stringify(value)
  cdp = await cdpServer((command, peer) => {
    expect(command.method).toBe('Runtime.evaluate')
    expect(command.params).toEqual({ expression, returnByValue: true, awaitPromise: true })
    peer.send({ method: 'Runtime.consoleAPICalled', params: {} })
    peer.send({ id: 99, result: {} })
    peer.send({ id: command.id, result: { result: { type: 'string', value } } }, true)
  })
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  expect(await ctx.wrapvmIsolate.cdpEval('page-1', expression)).toBe(value)
})

it.each([
  ['protocol error', { error: { code: -32000, message: 'Target closed' } }, 'CDP command failed'],
  ['JavaScript exception', { result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: browser failure' } } } }, 'JavaScript failed'],
  ['missing result', { id: 1 }, 'missing CDP result'],
])('rejects a CDP %s', async (_name, response, message) => {
  cdp = await cdpServer((command, peer) => peer.send({ id: command.id, ...response }))
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  await expect(ctx.wrapvmIsolate.cdpEval('page-1', 'throw new Error()')).rejects.toThrow(message)
})

it.each(['disconnect', 'timeout', 'malformed', 'handshake'] as const)('settles the CDP request after %s', async (failure) => {
  cdp = await cdpServer((_command, peer) => {
    if (failure === 'disconnect') peer.disconnect()
    if (failure === 'malformed') peer.text('{broken')
  }, failure === 'handshake')
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  const message = failure === 'disconnect' ? 'disconnected' : failure === 'timeout' ? 'timed out' : failure === 'handshake' ? 'connection failed' : 'JSON'
  await expect(ctx.wrapvmIsolate.cdpEval('page-1', '1', 100)).rejects.toThrow(message)
})

it('uses Page.navigate and reports browser navigation failures through the tool', async () => {
  const url = 'https://example.com/a?quoted="value"'
  cdp = await cdpServer((command, peer) => {
    expect(command.method).toBe('Page.navigate')
    expect(command.params).toEqual({ url })
    peer.send({ id: command.id, result: { errorText: 'net::ERR_NAME_NOT_RESOLVED' } })
  })
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  const result = await executeToolFixture(ctx, {
    callId: ToolCallId('vm-navigate'), name: 'vm_browser', arguments: { action: 'navigate', targetId: 'page-1', url }, signal: new AbortController().signal,
  })
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('net::ERR_NAME_NOT_RESOLVED') }])
})

it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid operation timeout %s before a browser connection', async timeoutMs => {
  const ctx = await load()
  await writeFile(join(root, 'state'), 'running')
  await expect(ctx.wrapvmIsolate.cdpEval('page-1', '1', timeoutMs)).rejects.toThrow('invalid timeoutMs')
  await expect(ctx.wrapvmIsolate.exec({ command: 'echo test', timeoutMs })).rejects.toThrow('invalid timeoutMs')
  expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).not.toContain('"exec"')
})

it('matches container names with literal dots', async () => {
  const ctx = await load({ containerName: 'wrapvm.name' })
  await ctx.wrapvmIsolate.status()
  const commands = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(commands[0]).toContain('name=^/wrapvm\\.name$')
})

it('does not report an existing container ready when only guest Chrome is reachable', async () => {
  const controller = new AbortController()
  cdp = await cdpServer((_command, _peer) => {}, true, () => controller.abort(new Error('cancel unreachable host')))
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  await expect(ctx.wrapvmIsolate.start(controller.signal)).rejects.toThrow('cancel unreachable host')
  expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).not.toContain('"start"')
})

it('retries the host CDP forwarder while guest Chrome is already reachable', async () => {
  let requests = 0
  cdp = await cdpServer((command, peer) => {
    requests++
    if (requests === 1) peer.send({ id: command.id, error: { code: -32000, message: 'forwarder starting' } })
    else peer.send({ id: command.id, result: { product: 'Chrome/fixture' } })
  })
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  await expect(ctx.wrapvmIsolate.start()).resolves.toMatchObject({ running: true })
  expect(requests).toBe(2)
})

it.each([
  ['vm_status', {}, 'hold-status'],
  ['vm_shell', { command: 'hold-shell', description: 'Wait for cancellation' }, 'running'],
  ['vm_desktop', { argv: ['hold-desktop'] }, 'running'],
])('cancels %s and awaits its host subprocess exit', async (name, args, state) => {
  const ctx = await load()
  await writeFile(join(root, 'state'), state)
  const controller = new AbortController()
  const pending = executeToolFixture(ctx, {
    callId: ToolCallId('vm-cancel'), name, arguments: args, signal: controller.signal,
  })
  let pid = 0
  await vi.waitFor(async () => { pid = Number(await readFile(join(root, 'held-pid'), 'utf8')); expect(pid).toBeGreaterThan(0) })
  controller.abort(new Error('cancel requested'))
  const result = await pending
  expect(result.isError).toBe(true)
  expect(() => process.kill(pid, 0)).toThrow()
})

it('cancels an in-flight CDP tool request', async () => {
  const controller = new AbortController()
  cdp = await cdpServer((_command, _peer) => controller.abort(new Error('cancel requested')))
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  const result = await executeToolFixture(ctx, {
    callId: ToolCallId('vm-cancel-cdp'), name: 'vm_browser', arguments: { action: 'eval', targetId: 'page-1', expression: 'new Promise(() => {})' }, signal: controller.signal,
  })
  expect(result.isError).toBe(true)
  expect(controller.signal.aborted).toBe(true)
})

it('does not start subprocesses for an already cancelled operation', async () => {
  const ctx = await load()
  const signal = AbortSignal.abort(new Error('cancel requested'))
  await expect(ctx.wrapvmIsolate.status(signal)).rejects.toThrow('cancel requested')
  await expect(ctx.wrapvmIsolate.exec({ command: 'echo test' }, signal)).rejects.toThrow('cancel requested')
  await expect(ctx.wrapvmIsolate.desktop({ argv: ['list-apps'] }, signal)).rejects.toThrow('cancel requested')
  await expect(ctx.wrapvmIsolate.cdpEval('page-1', '1', 100, signal)).rejects.toThrow('cancel requested')
  await expect(readFile(join(root, 'calls.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps evaluated objects as readable JSON in the model result', async () => {
  cdp = await cdpServer((command, peer) => peer.send({ id: command.id, result: { result: { type: 'object', value: { links: ['https://example.com/'] } } } }))
  const ctx = await load({ cdpPort: cdp.port })
  await writeFile(join(root, 'state'), 'running')
  const result = await executeToolFixture(ctx, {
    callId: ToolCallId('vm-eval-object'), name: 'vm_browser', arguments: { action: 'eval', targetId: 'page-1', expression: '({ links: [] })' }, signal: new AbortController().signal,
  })
  expect(result.content).toEqual([{ type: 'text', text: '{"links":["https://example.com/"]}' }])
})

it('dispatches UI Remote methods through the loaded gateway and refuses calls after unload', async () => {
  cdp = await cdpServer((command, peer) => peer.send({ id: command.id, result: { product: 'Chrome/fixture' } }))
  const ctx = await load({ cdpPort: cdp.port }, true)
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string) => ctx.typertGateway.invoke({ namespace: 'wrapvmIsolate', method, args: {}, peer })
  await expect(invoke('status')).resolves.toMatchObject({ state: 'missing', running: false })
  await expect(invoke('viewerUrl')).resolves.toBeNull()
  await expect(invoke('start')).resolves.toMatchObject({ running: true })
  await expect(invoke('viewerUrl')).resolves.toBe('http://127.0.0.1:6080/?token=fixture-viewer-secret')
  await expect(invoke('stop')).resolves.toMatchObject({ running: false })
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'wrapvm')
  await entry?.fiber?.dispose()
  expect(ctx.get('wrapvmIsolate')).toBeUndefined()
  await expect(invoke('status')).rejects.toThrow()
})


it('streams null-safe samples from the shared inventory through the Gateway and stops on cancellation', async () => {
  const ctx = await load({}, true, true)
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const abort = new AbortController()
  const stream = await ctx.typertGateway.stream({
    namespace: 'wrapvmIsolate', method: 'v02WatchResources', args: { environmentIds: [env1] }, peer, signal: abort.signal,
  })
  const iterator = stream[Symbol.asyncIterator]()
  const update = await iterator.next()
  expect(update.done).toBe(false)
  expect(update.value).toMatchObject({ environmentId: env1, resources: { cpuPercent: null, memoryUsedBytes: null, volumeUsedBytes: null } })
  const secondAbort = new AbortController()
  const second = await ctx.typertGateway.stream({
    namespace: 'wrapvmIsolate', method: 'v02WatchResources', args: { environmentIds: [env1] }, peer, signal: secondAbort.signal,
  })
  const secondIterator = second[Symbol.asyncIterator]()
  expect((await secondIterator.next()).value).toEqual(update.value)
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls.filter(args => args[0] === 'stats')).toHaveLength(1)
  abort.abort()
  secondAbort.abort()
  await iterator.return?.()
  await secondIterator.return?.()
})


it('does not allow an unauthenticated local call or guest to subscribe to resource data', async () => {
  const ctx = await load({}, true, true)
  const local = ctx.wrapvmIsolate.v02WatchResources([env1], new AbortController().signal)
  await expect(local[Symbol.asyncIterator]().next()).rejects.toThrow('authenticated owner required')
  const peer = new Peer(ctx, { principal: { kind: 'wrapvm-test-guest' } })
  await expect(async () => {
    const stream = await ctx.typertGateway.stream({ namespace: 'wrapvmIsolate', method: 'v02WatchResources', args: { environmentIds: [env1] }, peer })
    await stream[Symbol.asyncIterator]().next()
  }).rejects.toThrow()
})


it('streams the real core baseline and synchronous arm through the Gateway', async () => {
  const ctx = await load({}, true, true, true)
  const id = SessionId('vm-session')
  ctx.sessions.create(id)
  await vi.waitFor(() => { expect(ctx.get('toolSafety')).toBeDefined() })
  const safety = ctx.get('toolSafety')!
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const abort = new AbortController()
  const stream = await ctx.typertGateway.stream({ namespace: 'wrapvmIsolate', method: 'v02WatchSession', args: { sessionKey: id }, peer, signal: abort.signal })
  const iterator = stream[Symbol.asyncIterator]()
  const baseline = await iterator.next()
  expect(baseline.value).toMatchObject({ binding: null, bindingComplete: false, policy: { mode: 'normal', generation: 0 } })
  const view = baseline.value as VmSessionView
  const invoke = (method: string, args: object) => ctx.typertGateway.invoke({ namespace: 'wrapvmIsolate', method, args, peer })
  await expect(invoke('v02Snapshot', { sessionKey: id })).resolves.toMatchObject({ bindingComplete: false, environments: [{ id: env1, bindingsComplete: false, observed: null, uncertainty: 'reconciliation required' }] })
  expect(existsSync(join(root, 'calls.jsonl'))).toBe(false)
  await expect(invoke('v02ViewerUrl', { sessionKey: id, expectedEpoch: view.epoch, expectedRevision: view.revision })).resolves.toBeNull()
  await expect(invoke('v02ViewerUrl', { sessionKey: id, expectedEpoch: 'stale', expectedRevision: view.revision })).rejects.toThrow('outdated')
  const armed = safety.arm({ sessionKey: id, mode: 'activating', generation: 1, stage: 'closing-admission' }, { attemptId: 'test' })
  await expect(armed).rejects.toThrow()
  const update = await iterator.next()
  expect(update.value).toMatchObject({ bindingComplete: false, policy: { mode: 'activating', generation: 1 } })
  abort.abort()
  await iterator.return?.()
})
