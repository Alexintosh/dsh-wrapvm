/** Generated read codecs over the Loader, Gateway and local Connection transport. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
import Wrapvm from './live-built-entry.ts'
import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'
import { adaptV02 } from '../src/client/remote-adapter.ts'

declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'wrapvm-test-guest': { readonly kind: 'wrapvm-test-guest' } } }

let root: string | undefined
let ownedId: string | undefined
const ownedIds: string[] = []
let host: Context | undefined
let client: Context | undefined

afterEach(async () => {
  for (const ownedId of ownedIds) {
    const run = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const label = `label=dsh.wrapvm.environment-id=${ownedId}`
    const ids = run('ps', '-aq', '--no-trunc', '--filter', 'label=dsh.wrapvm.environment=1', '--filter', label).split('\n').filter(Boolean)
    for (const id of ids) run('rm', '-f', id)
    const networks = run('network', 'ls', '-q', '--no-trunc', '--filter', 'label=dsh.wrapvm.environment=1', '--filter', label).split('\n').filter(Boolean)
    for (const id of networks) run('network', 'rm', id)
    const volumes = run('volume', 'ls', '-q', '--filter', 'label=dsh.wrapvm.environment=1', '--filter', label).split('\n').filter(Boolean)
    for (const id of volumes) run('volume', 'rm', id)
    console.log('LIVE plugin cleanup', ids.length, networks.length, volumes.length)
  }
  await client?.fiber.dispose()
  await host?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  client = undefined
  host = undefined
  root = undefined
})

it.skipIf(process.env.WRAPVM_LIVE_ACCEPTANCE !== '1')('exercises the plugin entry and generated remote face against Docker', async () => {
  root = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), 'live-fixture-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: 'cordis:prompt' }, { name: 'cordis:tools' }, { name: 'cordis:subprocess' },
    { name: 'cordis:registry' }, { name: 'cordis:access' }, { name: 'cordis:gateway' },
    { name: 'cordis:wrapvm', config: { backend: 'docker' } },
  ]))
  host = new Context()
  host.baseUrl = pathToFileURL(root).href + '/'
  await host.plugin(Storage)
  const backend = new MemoryStorageBackend()
  host.storage.backend.register('memory', backend)
  host.provide(storageBackendServiceKey('memory'), backend)
  await host.plugin(StorageDomain, { backend: 'memory' })
  const domain = await host.storageDomain.open(StorageDomain.defineDomain(wrapvmInventoryDomainSpec))
  await domain.table('snapshots').put('current', { environments: {}, operations: {} })
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
  const result = await read.v02Create!({ displayName: 'Plugin acceptance', image: 'wrapvm-dsh:desktop', limits: { cpuMillis: 1000, memoryBytes: 1536 * 2 ** 20, diskBytes: null }, internetAccess: true, mounts: [] }, 'acceptance')
  ownedId = result.environmentId
  if (ownedId) ownedIds.push(ownedId)
  console.log('LIVE built plugin create', JSON.stringify({ state: result.state, errorCode: result.errorCode, error: result.error }))
  expect(result).toMatchObject({ state: 'completed' })
  const selection = await read.v02Bind!(id, ownedId!, 'bind')
  expect(selection.state).toBe('completed')
  const execution = { agent: { session: { id } }, signal: new AbortController().signal } as never
  const shell = host.tools.definitions().find(tool => tool.name === 'vm_shell')!
  const shellResult = await shell.execute({ command: 'id -un; printf \"%s\\n%s\\n\" \"$HOME\" \"$DISPLAY\"', description: 'acceptance' }, execution)
  expect(shellResult).toMatchObject({ output: 'user\n/home/user\n:1\n', exitCode: 0 })
  await shell.execute({ command: 'printf first > /home/user/workspace/selection-marker', description: 'mark first' }, execution)
  const second = await read.v02Create!({ displayName: 'Plugin acceptance second', image: 'wrapvm-dsh:desktop', limits: { cpuMillis: 1000, memoryBytes: 1536 * 2 ** 20, diskBytes: null }, internetAccess: true, mounts: [] }, 'acceptance-second')
  if (second.environmentId) ownedIds.push(second.environmentId)
  expect(second).toMatchObject({ state: 'completed' })
  const otherId = SessionId('generated-read-other-session')
  host.sessions.create(otherId)
  expect((await read.v02Bind!(otherId, second.environmentId, 'bind-other')).state).toBe('completed')
  const otherExecution = { agent: { session: { id: otherId } }, signal: new AbortController().signal } as never
  await shell.execute({ command: 'printf second > /home/user/workspace/selection-marker', description: 'mark second' }, otherExecution)
  expect(await shell.execute({ command: 'cat /home/user/workspace/selection-marker', description: 'read first' }, execution)).toMatchObject({ output: 'first' })
  expect(await shell.execute({ command: 'cat /home/user/workspace/selection-marker', description: 'read second' }, otherExecution)).toMatchObject({ output: 'second' })
  console.log('LIVE two selected sessions routed to distinct environments')
  const unselected = { agent: { session: { id: 'unselected-acceptance' } }, signal: new AbortController().signal } as never
  await expect(shell.execute({ command: 'true', description: 'unselected' }, unselected)).rejects.toThrow(/select a VM/)
  const browser = host.tools.definitions().find(tool => tool.name === 'vm_browser')!
  let opened: { target?: string } | undefined
  for (let n = 0; n < 30; n++) {
    try { opened = await browser.execute({ action: 'open', url: 'about:blank' }, execution) as { target?: string }; break } catch { /* desktop starting */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  expect(opened?.target).toBeTruthy()
  expect(await browser.execute({ action: 'eval', targetId: opened!.target, expression: '6 * 7' }, execution)).toMatchObject({ value: '42' })
  await browser.execute({ action: 'close', targetId: opened!.target }, execution)
  const desktop = host.tools.definitions().find(tool => tool.name === 'vm_desktop')!
  expect(await desktop.execute({ argv: ['screenshot', '--screen', '0', '/home/user/workspace/plugin-acceptance.png'] }, execution)).toMatchObject({ exitCode: 0 })
  expect(await shell.execute({ command: 'test -s /home/user/workspace/plugin-acceptance.png && echo screenshot-ok', description: 'check screenshot' }, execution)).toMatchObject({ output: 'screenshot-ok\n', exitCode: 0 })
  const stream = wire.v02WatchSession(id)
  const iterator = stream[Symbol.asyncIterator]()
  const view = await iterator.next()
  if (view.done) throw new Error('session stream ended')
  const link = await read.v02ViewerUrl!(id, view.value.epoch, view.value.revision)
  expect(link?.url).toBeTruthy()
  expect((await fetch(link!.url)).status).toBe(200)
  console.log('LIVE owner viewer HTTP 200')
  await iterator.return?.()
  console.log('LIVE built plugin: owner create, session bind, selected shell/browser/desktop, unselected rejection passed')
}, 180_000)
