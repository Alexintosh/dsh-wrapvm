/** Generated read codecs over the Loader, Gateway and local Connection transport. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import TypertRegistry, { type TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { apply, inject } from '../../../api/gateway/src/client/index.ts'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { HostConnectionService } from '../../../client/connection/src/rpc-host.ts'
import type { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import { createWebConnectionRpc } from '../../../client/connection/src/client/rpc.ts'
import { openConnectionWebSocket } from '../../../client/connection/src/client/socket.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '../../../storage/storage-domain/src/index.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { wrapvmInventoryDomainSpec } from '../src/inventory.ts'
import { descriptorFor, env1 } from './fixtures/env-fixtures.ts'
import Wrapvm from '../src/index.ts'
import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'
import { adaptV02 } from '../src/client/remote-adapter.ts'

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'wrapvm-test-guest': { readonly kind: 'wrapvm-test-guest' } } }

let root: string | undefined
let host: Context | undefined
let client: Context | undefined

afterEach(async () => {
  await client?.fiber.dispose()
  await host?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  client = undefined
  host = undefined
  root = undefined
})

it('uses the generated read face for unary replies, stream baselines and cancellation', async () => {
  root = await mkdtemp(join(tmpdir(), 'wrapvm-generated-face-'))
  const engine = join(root, 'engine')
  await writeFile(engine, `#!${process.execPath}\n` + await readFile(new URL('./fixtures/engine.mjs', import.meta.url), 'utf8'))
  await chmod(engine, 0o700)
  await writeFile(join(root, 'state'), 'running')
  await writeFile(join(root, 'managed'), '')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: 'cordis:prompt' }, { name: 'cordis:tools' }, { name: 'cordis:subprocess' },
    { name: 'cordis:registry' }, { name: 'cordis:access' }, { name: 'cordis:gateway' },
    { name: 'cordis:wrapvm', config: { backend: engine, workspaceDir: root } },
  ]))
  host = new Context()
  host.baseUrl = pathToFileURL(root).href + '/'
  await host.plugin(Storage)
  const backend = new MemoryStorageBackend()
  host.storage.backend.register('memory', backend)
  host.provide(storageBackendServiceKey('memory'), backend)
  await host.plugin(StorageDomain, { backend: 'memory' })
  const domain = await host.storageDomain.open(StorageDomain.defineDomain(wrapvmInventoryDomainSpec))
  await domain.table('snapshots').put('current', { environments: { [env1]: descriptorFor(env1) }, operations: {} })
  await domain.close()
  await host.plugin(SessionProjectionRegistry)
  await host.plugin(SessionStore)
  await host.plugin(Loader)
  Object.assign(host.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, subprocess: Subprocess, wrapvm: Wrapvm, registry: TypertRegistry, access: RemoteAccessService, gateway: TypertGateway })
  await host.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await host.loader.await()
  host.typert.register(TYPERT as TypertContribution)
  const id = SessionId('generated-read-session')
  host.sessions.create(id)
  const server = host
  await host.plugin(scope => { new HostConnectionService(scope, [], {} as BrowserAuth) })
  const connection = host.get('connection') as HostConnectionService
  const handler = connection.createSharedFetchHandler('/api')
  const rpc = createWebConnectionRpc(
    async (path, init) => handler.fetch(new Request(new URL(path, 'http://host'), init), connection.browserPeer),
    (endpoint, payload, signal, uplink) => ({
      async *[Symbol.asyncIterator]() {
        const stream = await server.typertGateway.wireStream.open(endpoint, payload, uplink ?? (async function* () {})(), connection.browserPeer, signal)
        yield* stream
      },
    }),
  )
  client = new Context()
  await client.plugin(TypertRegistry)
  client.provide('connection', {
    interactions: 'answer', openWebSocket: openConnectionWebSocket, isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, rpc, registerGenerationSource: () => () => {}, start: () => ({ stop: () => {} }),
  } satisfies ConnectionHandle)
  await client.plugin({ inject, apply })
  await client.remote.$mount(TYPERT_REMOTE)
  const wire = client.remote.wrapvmIsolate
  const read = adaptV02(wire)
  expect(await read.v02Snapshot(id)).toMatchObject({ bindingComplete: true, environments: [{ id: env1, observed: { phase: 'running' } }] })
  expect(read.v02Create).toBeTypeOf('function')
  expect(read.v02Start).toBeTypeOf('function')
  expect(read.v02Bind).toBeTypeOf('function')
  const operation = await read.v02Create!({ displayName: 'test', image: 'test', limits: { cpuMillis: 100, memoryBytes: 1048576, diskBytes: 100 }, internetAccess: false, mounts: [] }, 'unsupported-quota')
  expect(operation).toMatchObject({ state: 'failed', errorCode: 'disk-quota-unsupported' })
  await expect(host.wrapvmIsolate.v02Bind(id, env1, 'direct')).rejects.toThrow('authenticated owner')
  const guest = new Peer(host, { principal: { kind: 'wrapvm-test-guest' } })
  await expect(host.typertGateway.invoke({ namespace: 'wrapvmIsolate', method: 'v02Bind', args: { session: id, id: env1, _key: 'guest' }, peer: guest })).rejects.toThrow()
  await guest.dispose()
  const session = wire.v02WatchSession(id)
  const iterator = session[Symbol.asyncIterator]()
  const baseline = await iterator.next()
  expect(baseline.value).toMatchObject({ binding: null, bindingComplete: true, policy: { mode: 'normal' } })
  if (baseline.done) throw new Error('session stream ended before its baseline')
  await expect(wire.v02ViewerUrl(id, baseline.value.epoch, baseline.value.revision)).resolves.toEqual({ ok: true, value: null })
  const pendingBind = iterator.next()
  expect(await read.v02Bind!(id, env1, 'bind')).toMatchObject({ state: 'completed' })
  const selected = await pendingBind
  expect(selected.value).toMatchObject({ binding: { environmentId: env1 } })
  if (selected.done) throw new Error('session stream ended')
  expect(await read.v02ViewerUrl!(id, selected.value.epoch, selected.value.revision)).toMatchObject({ url: 'http://127.0.0.1:55000/?token=fixture-viewer-secret' })
  const execution = { agent: { session: { id } }, signal: new AbortController().signal } as never
  const shell = host.tools.definitions().find(tool => tool.name === 'vm_shell')!
  const desktop = host.tools.definitions().find(tool => tool.name === 'vm_desktop')!
  const browser = host.tools.definitions().find(tool => tool.name === 'vm_browser')!
  expect(await shell.execute({ command: 'echo test', description: 'test' }, execution)).toMatchObject({ output: 'guest output' })
  expect(await desktop.execute({ argv: ['list-apps'] }, execution)).toMatchObject({ output: 'guest output' })
  expect(await browser.execute({ action: 'tabs' }, execution)).toMatchObject({ targets: [{ id: 'page-1' }] })
  expect(await read.v02Stop!(env1, 'stop')).toMatchObject({ state: 'completed' })
  expect(await read.v02Snapshot(id)).toMatchObject({ environments: [{ id: env1, observed: { phase: 'stopped' } }] })
  const status = host.tools.definitions().find(tool => tool.name === 'vm_status')!
  expect(await status.execute({}, execution)).toMatchObject({ state: 'stopped', running: false })
  await expect(shell.execute({ command: 'echo test', description: 'test' }, execution)).rejects.toThrow('not running')
  expect(await read.v02PreviewRemoval!(env1, false)).toMatchObject({ containerId: 'container-1' })
  expect(await read.v02Start!(env1, 'start')).toMatchObject({ state: 'completed' })
  const pendingUnbind = iterator.next()
  expect(await read.v02Unbind!(id, 'unbind')).toMatchObject({ state: 'completed' })
  expect((await pendingUnbind).value).toMatchObject({ binding: null, revision: selected.value.revision + 1 })
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(calls.some(args => args.includes('container-1') && args.includes('/opt/wrap/bin/wrap-entrypoint') && args.includes('echo test'))).toBe(true)
  expect(calls).toContainEqual(['exec', 'container-1', '/opt/wrap/bin/wrap-entrypoint', 'sh', '-lc', 'exec "$@"', 'wrapvm-viewer', 'wrap-desktop', 'url', 'http://127.0.0.1:55000'])
  expect(calls).toContainEqual(['stop', 'container-1'])
  expect(calls).toContainEqual(['start', 'container-1'])
  await expect(wire.v02ViewerUrl(id, 'stale', baseline.value.revision)).resolves.toMatchObject({ ok: false })
  session.dispose()
  await expect(iterator.next()).resolves.toMatchObject({ done: true })
}, 30_000)
