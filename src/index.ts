/**
 * @deepseek-ai/dsh-wrapvm-isolate — isolated wrapvm desktop VM for DeepSeek Harness.
 *
 * Host half: container lifecycle (start/stop/status/exec/innerUrl) and agent
 * tools (vm_shell, vm_browser, vm_desktop, vm_status) driven through the docker
 * CLI via `ctx.subprocess.spawn`, plus the Remote face the settings panel calls.
 *
 * The VM image is `ghcr.io/tobi/wrapvm:desktop` (wrap's desktop image: Xvfb +
 * XFCE, one persistent Chrome with CDP forwarded to all guest interfaces at
 * 9223, voxl viewer on 6080, agent-browser and agent-desktop preinstalled).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'

/** Workspace mount path inside the VM, matching wrapvm's Smolfile layout. */
const VM_WORKSPACE = '/home/user/workspace'
/** Image helper that selects its configured desktop user and home. */
const GUEST_ENTRYPOINT = '/opt/wrap/bin/wrap-entrypoint'
/** Default command timeout for shell and CLI tools, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000

import { readVmSkill, vmSkillNames } from './vm-skills.ts'
import { DomainInventoryStore, Inventory, wrapvmInventoryDomainSpec } from './inventory.ts'
import { DockerEnvironmentBackend, defaultDockerBackendConfig } from './docker-backend.ts'
import { makeFsMountPolicyContext } from './mount-policy.ts'
import { asEnvironmentId, type EnvironmentOperation, type EnvironmentLimits, type EnvironmentTarget } from './environments.ts'
import { BindingRegistry, type BindingEvent } from './binding.ts'
import { EnvironmentManager, ExecutionLeaseRegistry } from './lifecycle.ts'
import { cpus, totalmem } from 'node:os'
import { ResourceSampler, createDockerStatsSource } from './telemetry.ts'
import type { ExecResult, VmResourceUpdate, VmSessionView, VmStatus, VmViewerLink, VmPolicy, VmInventorySnapshot, VmOperationView, VmRemovalPreview } from './types.ts'
export type { ExecResult, VmStatus, CdpTarget, VmResourceUpdate, VmSessionView, VmViewerLink, VmPolicy, VmBinding, VmOperationView, VmEnvironmentView, VmInventorySnapshot } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Configured wrapvm container lifecycle and tools. */
    wrapvmIsolate: WrapvmIsolateService
  }
}

/** Configuration schema for the wrapvm isolate service. */
export interface Config {
  /** Docker executable. */
  backend: string
  /** Shared resource sampling cadence in milliseconds. */
  metricsCadenceMs: number
  /** Age after which resource samples are stale. */
  metricsStalenessMs: number
}

/** Status output schema for `vm_status`. */
const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    containerName: { type: 'string', required: true },
    image: { type: 'string', required: true },
    state: { type: 'string', required: true },
    running: { type: 'boolean', required: true },
    viewerPort: { type: 'number', required: true },
    cdpPort: { type: 'number', required: true },
    workspaceDir: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const

/** ExecResult output schema shared by vm_shell and vm_desktop. */
const EXEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    output: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    exitCode: { type: 'number', required: true },
  },
} as const

function resolveTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('wrapvm-isolate: invalid timeoutMs')
  return value
}

/** Send one CDP command, rejecting protocol errors, disconnects, cancellation, and timeouts. */
async function cdpRequest(url: string, method: string, params: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let settled = false
    const finish = (error?: Error, result?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.close()
      if (error) reject(error)
      else resolve(result ?? {})
    }
    const timer = setTimeout(() => finish(new Error(`wrapvm-isolate: ${method} timed out; inspect the browser before retrying`)), timeoutMs)
    const onAbort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error('wrapvm-isolate: browser request cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    socket.addEventListener('open', () => {
      if (!settled) socket.send(JSON.stringify({ id: 1, method, params }))
    })
    socket.addEventListener('error', () => finish(new Error('wrapvm-isolate: Chrome connection failed')))
    socket.addEventListener('close', () => finish(new Error('wrapvm-isolate: Chrome disconnected before replying')))
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string') throw new Error('wrapvm-isolate: invalid CDP response')
        const message = validate.object({ id: validate.number().optional(), error: validate.unknown().optional(), result: validate.record(validate.string(), validate.unknown()).optional() }).parse(JSON.parse(event.data))
        if (message.id !== 1) return
        if (message.error) throw new Error(`wrapvm-isolate: CDP command failed: ${JSON.stringify(message.error)}`)
        if (!message.result || typeof message.result !== 'object') throw new Error('wrapvm-isolate: missing CDP result')
        finish(undefined, message.result)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** One bounded subprocess run through the configured container backend. */
export class WrapvmIsolateService extends TypertRemoteService {
  static inject = ['subprocess', 'tools']

  static Config = z.object({
    backend: z.string().default('docker'),
    metricsCadenceMs: z.number().default(5000),
    metricsStalenessMs: z.number().default(15000),
  })

  private readonly hostLifetime = new AbortController()
  private readonly hostEpoch = randomUUID()
  private manager: EnvironmentManager | undefined
  private backend: DockerEnvironmentBackend | undefined
  private bindings: BindingRegistry | undefined
  private readonly leases = new ExecutionLeaseRegistry()
  private managerReady: Promise<void> | undefined
  private revision = 0
  private readonly listeners = new Set<() => void>()
  private inventory: Inventory | undefined
  private sampler: ResourceSampler | undefined
  private resourceLifetime: AbortController | undefined

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'wrapvmIsolate')
    this.registerTools(ctx)
    ctx.effect(() => () => this.hostLifetime.abort(), 'wrapvm.hostLifetime')
    ctx.inject(['storageDomain'], async inner => {
      let disposed = false
      const lifetime = new AbortController()
      let close: (() => Promise<void>) | undefined
      let closeBindings: (() => Promise<void>) | undefined
      inner.effect(() => async () => {
        disposed = true
        lifetime.abort()
        if (this.resourceLifetime === lifetime) {
          this.sampler?.dispose()
          this.sampler = undefined
          this.inventory = undefined
          this.manager = undefined
          this.managerReady = undefined
          this.backend = undefined
          this.bindings = undefined
          this.resourceLifetime = undefined
        }
        if (closeBindings !== undefined) await closeBindings()
        if (close !== undefined) await close()
      }, 'wrapvm.inventory')
      const domain = await inner.storageDomain.open(defineDomain(wrapvmInventoryDomainSpec))
      close = () => domain.close()
      if (disposed) { await close(); return }
      try {
        const inventory = await new Inventory(new DomainInventoryStore(domain.table('snapshots'))).initialize()
        if (disposed) { await close(); return }
        const bindingDomain = await inner.storageDomain.open(defineDomain({
          name: 'wrapvm_bindings', version: 1, layout: 'per-record',
          tables: { events: { valueSchema: validate.array(validate.discriminatedUnion('type', [
            validate.object({ type: validate.literal('wrapvm/environment-bound'), sessionKey: validate.string(), environmentId: validate.string(), generation: validate.number(), timestamp: validate.number(), shared: validate.boolean().optional() }),
            validate.object({ type: validate.literal('wrapvm/environment-unbound'), sessionKey: validate.string(), environmentId: validate.string(), timestamp: validate.number() }),
          ])) } },
        } as const))
        closeBindings = () => bindingDomain.close()
        const table = bindingDomain.table('events')
        const events: BindingEvent[] = (table.get('current') ?? []).map(event => event.type === 'wrapvm/environment-bound' ? { type: event.type, sessionKey: event.sessionKey, environmentId: asEnvironmentId(event.environmentId), generation: event.generation, timestamp: event.timestamp, ...(event.shared === undefined ? {} : { shared: event.shared }) } : { ...event, environmentId: asEnvironmentId(event.environmentId) })
        const bindings = new BindingRegistry({ emit: async event => {
          events.push(event)
          try { await table.put('current', events) } catch (error) { events.pop(); throw error }
        } }, () => Date.now(), () => {
          this.revision++
          for (const listener of this.listeners) listener()
        })
        bindings.restore(events)
        bindings.markComplete()
        const mountPolicy = makeFsMountPolicyContext({ approvedRoots: [] })
        const backend = new DockerEnvironmentBackend(
          async (argv, signal) => await this.run(argv, { signal }),
          { ...defaultDockerBackendConfig, binary: this.config.backend },
          mountPolicy,
          inventory,
        )
        const source = createDockerStatsSource(
          (ids, signal) => backend.stats(ids, signal),
          (id, signal) => backend.writableLayerSize(id, signal),
          id => inventory.get(id)?.containerId,
        )
        const sampler = new ResourceSampler(source, { cadenceMs: this.config.metricsCadenceMs, stalenessMs: this.config.metricsStalenessMs })
        const manager = new EnvironmentManager({ inventory, driver: backend, bindings, mountPolicy,
          budget: { totalCpuMillis: cpus().length * 1000, totalMemoryBytes: totalmem() }, executions: this.leases })
        this.inventory = inventory
        this.backend = backend
        this.bindings = bindings
        this.manager = manager
        this.sampler = sampler
        this.resourceLifetime = lifetime
      } catch (error) {
        await close()
        throw error
      }
    })
  }

  private async run(argv: readonly string[], options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal | undefined } = {}): Promise<{
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }> {
    const timeoutMs = resolveTimeout(options.timeoutMs)
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    signal.throwIfAborted()
    const proc = this.ctx.subprocess.spawn({
      argv: [...argv],
      cwd: options.cwd ?? process.cwd(),
      graceMs: 1_000,
      signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4 << 20 },
        stderr: { maxBytes: 4 << 20 },
      },
    })
    const outcome = await proc.done
    signal.throwIfAborted()
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: proc.collected.stdout?.readFrom(0).text ?? '',
      stderr: proc.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new Error('wrapvm-isolate: authenticated owner required')
  }

  private async managed(): Promise<{ manager: EnvironmentManager; backend: DockerEnvironmentBackend; bindings: BindingRegistry }> {
    const { manager, backend, bindings } = this
    if (!manager || !backend || !bindings) throw new Error('wrapvm-isolate: environment inventory is unavailable')
    if (!this.managerReady) this.managerReady = manager.initialize(this.hostLifetime.signal).catch(error => { this.managerReady = undefined; throw error })
    await this.managerReady
    return { manager, backend, bindings }
  }

  private operation(op: EnvironmentOperation): VmOperationView {
    return { id: op.id, environmentId: op.environmentId, kind: op.kind, state: op.state, error: op.error ?? null,
      errorCode: op.errorCode ?? null, requestedAt: op.requestedAt ?? null, settledAt: op.settledAt ?? null }
  }

  private policy(sessionKey: string): VmPolicy {
    const binding = this.bindings?.binding(sessionKey)
    return { sessionKey, mode: 'normal', generation: binding?.generation ?? 0, stage: 'idle', environmentId: binding?.environmentId ?? null, reason: null }
  }

  @Remote
  async v02Snapshot(sessionKey: string | null): Promise<VmInventorySnapshot> {
    this.owner()
    const { manager, backend, bindings } = await this.managed()
    const environments = await Promise.all((await manager.list(this.hostLifetime.signal)).map(async record => {
      const acquired = await backend.captureTarget(record.id, this.hostLifetime.signal)
      const health = acquired.kind === 'captured' ? await backend.probe(acquired.target, this.hostLifetime.signal) : null
      const availability = (v: { kind: 'available' | 'unavailable' } | { kind: 'unknown'; reason: string }) =>
        v.kind === 'unknown' ? v : { kind: v.kind, reason: null }
      const observed = health === null ? null : { phase: health.phase, shell: availability(health.shell), browser: availability(health.browser),
        desktop: availability(health.desktop), hostControlPlane: availability(health.hostControlPlane), observedAt: health.observedAt ?? null }
      const sample = this.sampler?.latest(record.id)
      return { id: record.id, displayName: record.displayName ?? record.id, backend: record.backend, ownership: record.ownership,
        image: record.image, digest: record.digest, createdAt: record.createdAt, mounts: [...record.mounts],
        limits: { cpuMillis: record.limits.cpuMillis, memoryBytes: record.limits.memoryBytes, diskBytes: record.limits.diskBytes ?? null },
        internetAccess: record.internetAccess, desiredPhase: record.desiredPhase ?? null, observed,
        resources: sample === undefined ? null : { ...sample, stale: sample.stale ?? false },
        bindings: bindings.usersOf(record.id).flatMap(key => { const b = bindings.binding(key); return b ? [b] : [] }), bindingsComplete: true,
        operations: manager.operationsFor(record.id).map(op => this.operation(op)), uncertainty: manager.uncertainty(record.id)?.error ?? null }
    }))
    return { environments, policy: sessionKey === null ? null : this.policy(sessionKey), binding: sessionKey === null ? null : bindings.binding(sessionKey) ?? null, bindingComplete: true }
  }

  @Remote
  async v02Create(input: { displayName: string; image: string; limits: { cpuMillis: number; memoryBytes: number; diskBytes: number | null }; internetAccess: boolean; mounts: { hostPath: string; guestPath: string; access: 'read-only' | 'read-write' }[] }, key: string): Promise<VmOperationView> {
    this.owner()
    const { manager, backend } = await this.managed()
    // Each submitted host mount is an explicit choice by the owner.
    backend.approveMounts(input.mounts)
    const limits = this.limits(input.limits)
    return this.operation(await manager.create({ ...input, limits }, { idempotencyKey: key }))
  }

  private limits(value: { cpuMillis: number; memoryBytes: number; diskBytes: number | null }): EnvironmentLimits {
    return { cpuMillis: value.cpuMillis, memoryBytes: value.memoryBytes, ...(value.diskBytes === null ? {} : { diskBytes: value.diskBytes }) }
  }

  @Remote
  async v02Start(id: string, key: string): Promise<VmOperationView> { this.owner(); return this.operation(await (await this.managed()).manager.start(asEnvironmentId(id), { idempotencyKey: key })) }
  @Remote
  async v02Stop(id: string, key: string): Promise<VmOperationView> { this.owner(); return this.operation(await (await this.managed()).manager.stop(asEnvironmentId(id), { idempotencyKey: key })) }
  @Remote
  async v02Pause(id: string, key: string): Promise<VmOperationView> { this.owner(); return this.operation(await (await this.managed()).manager.pause(asEnvironmentId(id), { idempotencyKey: key })) }
  @Remote
  async v02Resume(id: string, key: string): Promise<VmOperationView> { this.owner(); return this.operation(await (await this.managed()).manager.resume(asEnvironmentId(id), { idempotencyKey: key })) }
  @Remote
  async v02UpdateLimits(id: string, limits: { cpuMillis: number; memoryBytes: number; diskBytes: number | null }, key: string): Promise<VmOperationView> { this.owner(); return this.operation(await (await this.managed()).manager.updateLimits(asEnvironmentId(id), this.limits(limits), { idempotencyKey: key })) }
  @Remote
  async v02PreviewRemoval(id: string, deleteVolumes: boolean): Promise<VmRemovalPreview> {
    this.owner(); const preview = await (await this.managed()).manager.previewRemoval(asEnvironmentId(id), deleteVolumes)
    return { ...preview, displayName: preview.displayName ?? null, hostMounts: [...preview.hostMounts] }
  }
  @Remote
  async v02ConfirmRemoval(id: string, token: string, deleteVolumes: boolean, key: string): Promise<VmOperationView> { this.owner(); return this.operation(await (await this.managed()).manager.remove(asEnvironmentId(id), token, deleteVolumes, { idempotencyKey: key })) }
  @Remote
  async v02Bind(session: string, id: string, _key: string): Promise<VmOperationView> {
    this.owner(); const { manager, bindings } = await this.managed(); const env = asEnvironmentId(id)
    if (!manager.get(env)) throw new Error('wrapvm-isolate: unknown environment')
    await bindings.bind(session, env, (bindings.binding(session)?.generation ?? 0) + 1, { allowShared: true })
    return this.operation({ id: randomUUID(), environmentId: env, kind: 'bind', state: 'completed', settledAt: Date.now() })
  }
  @Remote
  async v02Unbind(session: string, _key: string): Promise<VmOperationView> {
    this.owner(); const { bindings } = await this.managed(); const binding = bindings.binding(session)
    if (!binding) throw new Error('wrapvm-isolate: no environment selected')
    await bindings.unbind(session)
    return this.operation({ id: randomUUID(), environmentId: binding.environmentId, kind: 'unbind', state: 'completed', settledAt: Date.now() })
  }

  @Remote({ mode: 'stream' })
  async *v02WatchSession(sessionKey: string, signal: AbortSignal): AsyncIterable<VmSessionView> {
    this.owner(); await this.managed()
    const ended = AbortSignal.any([signal, this.hostLifetime.signal])
    let wake = Promise.withResolvers<void>()
    const notify = () => wake.resolve()
    this.listeners.add(notify); ended.addEventListener('abort', notify, { once: true })
    try {
      while (!ended.aborted) {
        yield { epoch: this.hostEpoch, revision: this.revision, policy: this.policy(sessionKey), binding: this.bindings?.binding(sessionKey) ?? null, bindingComplete: true }
        await wake.promise; wake = Promise.withResolvers<void>()
      }
    } finally { this.listeners.delete(notify); ended.removeEventListener('abort', notify) }
  }

  @Remote
  async v02ViewerUrl(sessionKey: string, epoch: string, revision: number): Promise<VmViewerLink | null> {
    this.owner(); if (epoch !== this.hostEpoch || revision !== this.revision) throw new Error('wrapvm-isolate: session selection changed')
    await this.managed()
    if (!this.bindings?.binding(sessionKey)) return null
    return await this.withTarget(sessionKey, 'viewer', async target => {
      const origin = `http://127.0.0.1:${target.ports.viewerPort}`
      const result = await this.run([this.config.backend, 'exec', target.containerId, GUEST_ENTRYPOINT, 'sh', '-lc', 'exec "$@"', 'wrapvm-viewer', 'wrap-desktop', 'url', origin], { timeoutMs: 10000 })
      if (result.exitCode !== 0) throw new Error('wrapvm-isolate: could not read viewer link')
      const url = new URL(result.stdout.trim())
      if (url.origin !== origin || url.username || url.password) throw new Error('wrapvm-isolate: invalid viewer link')
      if (epoch !== this.hostEpoch || revision !== this.revision) throw new Error('wrapvm-isolate: session selection changed')
      return { url: url.href, expiresAt: null, epoch, revision }
    })
  }

  private async withTarget<T>(session: string, name: string, run: (target: EnvironmentTarget) => Promise<T>, requireEndpoints = true): Promise<T> {
    const { manager, backend, bindings } = await this.managed()
    const selected = bindings.binding(session)
    if (!selected) throw new Error('wrapvm-isolate: select a VM environment for this conversation')
    const release = await this.leases.acquireExecution(selected.environmentId, name)
    try {
      if (bindings.binding(session)?.generation !== selected.generation) throw new Error('wrapvm-isolate: environment selection changed')
      if (manager.uncertainty(selected.environmentId)) throw new Error('wrapvm-isolate: environment has an unknown operation outcome')
      const acquired = await backend.captureTarget(selected.environmentId, this.hostLifetime.signal)
      if (acquired.kind !== 'captured') throw new Error(`wrapvm-isolate: environment target ${acquired.kind}`)
      if (requireEndpoints && (acquired.target.ports.viewerPort === 0 || acquired.target.ports.cdpPort === 0)) throw new Error('wrapvm-isolate: environment is not running')
      if (manager.get(selected.environmentId)?.containerId !== acquired.target.containerId) throw new Error('wrapvm-isolate: container differs from inventory')
      const checked = await backend.verifyTarget(acquired.target, this.hostLifetime.signal)
      if (checked.container.kind !== 'owned') throw new Error('wrapvm-isolate: container ownership could not be verified')
      return await run(acquired.target)
    } finally { release() }
  }

  /** Watch shared resource samples for managed environments until cancellation. */
  @Remote({ mode: 'stream' })
  async* v02WatchResources(environmentIds: string[], signal: AbortSignal): AsyncIterable<VmResourceUpdate> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new Error('wrapvm-isolate: authenticated owner required')
    const inventory = this.inventory
    const sampler = this.sampler
    const resourceLifetime = this.resourceLifetime
    if (inventory === undefined || sampler === undefined || resourceLifetime === undefined) throw new Error('wrapvm-isolate: environment inventory is unavailable')
    const ids = [...new Set(environmentIds.map(asEnvironmentId))]
    for (const id of ids) if (inventory.get(id) === undefined) throw new Error(`wrapvm-isolate: unknown environment ${id}`)
    const ended = AbortSignal.any([signal, this.hostLifetime.signal, resourceLifetime.signal])
    const pending = new Map<string, VmResourceUpdate>()
    let wake = Promise.withResolvers<void>()
    const notify = (): void => wake.resolve()
    ended.addEventListener('abort', notify, { once: true })
    const disposers: (() => void)[] = []
    try {
      for (const id of ids) disposers.push(sampler.subscribe(id, sample => {
        pending.set(id, { environmentId: id, resources: { ...sample, stale: sample.stale ?? false } })
        notify()
      }))
      while (!ended.aborted) {
        if (pending.size === 0) await wake.promise
        if (ended.aborted) break
        const updates = [...pending.values()]
        pending.clear()
        wake = Promise.withResolvers<void>()
        for (const update of updates) yield update
      }
    } finally {
      ended.removeEventListener('abort', notify)
      for (const dispose of disposers) dispose()
    }
  }

  /** Run one command as the image's configured user in its login environment. */
  async exec(target: EnvironmentTarget, args: { command: string; workdir?: string; timeoutMs?: number }, signal?: AbortSignal): Promise<ExecResult> {
    const timeoutMs = resolveTimeout(args.timeoutMs)
    const workdir = args.workdir ?? VM_WORKSPACE
    if (!workdir.startsWith('/')) throw new Error('wrapvm-isolate: workdir must be an absolute guest path')
    const result = await this.run(
      [this.config.backend, 'exec', '-w', workdir, target.containerId, GUEST_ENTRYPOINT, 'timeout', '--kill-after=1s', `${timeoutMs / 1000}s`, 'sh', '-lc', args.command],
      { timeoutMs: Math.min(2_147_483_647, timeoutMs + 2_000), signal },
    )
    return {
      output: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    }
  }

  /** Run `agent-desktop` as the image's user with its desktop session environment. */
  async desktop(target: EnvironmentTarget, args: { argv: readonly string[]; timeoutMs?: number }, signal?: AbortSignal): Promise<ExecResult> {
    const timeoutMs = resolveTimeout(args.timeoutMs)
    const result = await this.run(
      [this.config.backend, 'exec', target.containerId, GUEST_ENTRYPOINT, 'timeout', '--kill-after=1s', `${timeoutMs / 1000}s`, 'sh', '-lc', 'exec "$@"', 'wrapvm-desktop', 'agent-desktop', ...args.argv],
      { timeoutMs: Math.min(2_147_483_647, timeoutMs + 2_000), signal },
    )
    return {
      output: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    }
  }

  /** List CDP DevTools targets of the running VM. */
  async cdpTargets(target: EnvironmentTarget, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const result = await this.run(
      [this.config.backend, 'exec', target.containerId, 'curl', '-fsS', `http://127.0.0.1:9222/json/list`],
      { timeoutMs: 10_000, signal },
    )
    if (result.exitCode !== 0) throw new Error(`wrapvm-isolate: CDP list failed\n${result.stderr}`)
    return validate.array(validate.object({ id: validate.string(), title: validate.string(), url: validate.string() })).parse(JSON.parse(result.stdout))
  }

  /** Open one CDP target on a fresh page. */
  async cdpOpen(target: EnvironmentTarget, url: string, signal?: AbortSignal): Promise<{ id: string }> {
    const result = await this.run(
      [this.config.backend, 'exec', target.containerId, 'curl', '-fsS', '-X', 'PUT', `http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`],
      { timeoutMs: 10_000, signal },
    )
    if (result.exitCode !== 0) throw new Error(`wrapvm-isolate: CDP open failed\n${result.stderr}`)
    return validate.object({ id: validate.string() }).parse(JSON.parse(result.stdout))
  }

  /** Close one CDP target. */
  async cdpClose(target: EnvironmentTarget, targetId: string, signal?: AbortSignal): Promise<{ id: string }> {
    const result = await this.run(
      [this.config.backend, 'exec', target.containerId, 'curl', '-fsS', '-X', 'PUT', `http://127.0.0.1:9222/json/close/${encodeURIComponent(targetId)}`],
      { timeoutMs: 10_000, signal },
    )
    if (result.exitCode !== 0) throw new Error(`wrapvm-isolate: CDP close failed\n${result.stderr}`)
    return { id: targetId }
  }

  /** Evaluate one JS expression in one CDP target over WebSocket. */
  async cdpEval(target: EnvironmentTarget, targetId: string, expression: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    resolveTimeout(timeoutMs)
    const result = await cdpRequest(
      `ws://127.0.0.1:${target.ports.cdpPort}/devtools/page/${encodeURIComponent(targetId)}`,
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs, signal,
    )
    if (result.exceptionDetails) throw new Error(`wrapvm-isolate: JavaScript failed: ${JSON.stringify(result.exceptionDetails)}`)
    const value = result.result
    return value && typeof value === 'object' && 'value' in value ? value.value : undefined
  }

  private async cdpNavigate(target: EnvironmentTarget, targetId: string, url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    resolveTimeout(timeoutMs)
    const result = await cdpRequest(
      `ws://127.0.0.1:${target.ports.cdpPort}/devtools/page/${encodeURIComponent(targetId)}`,
      'Page.navigate', { url }, timeoutMs, signal,
    )
    if (result.errorText) throw new Error(`wrapvm-isolate: navigation failed: ${String(result.errorText)}`)
  }

  private sessionKey(execution: ToolRunContext): string {
    const session = execution.agent?.session.id
    if (!session) throw new Error('wrapvm-isolate: tool call has no conversation')
    return session
  }

  private registerTools(ctx: Context): void {
    const tools = ctx.tools
    if (tools === undefined) throw new Error('wrapvm-isolate: ctx.tools is not mounted')

    tools.register(defineTool({
      name: 'load_vm_skill',
      description: 'Load guidance distributed with the Wrapvm bundle by its exact skill name.',
      parameters: {
        skill: { type: 'string', enum: vmSkillNames, required: true, description: 'Bundled VM skill name.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: object, value: string) => [{ type: 'text', text: value }],
      },
      execute: async (args: { skill: string }) => readVmSkill(args.skill),
      presentCall: (args: { skill: string }) => ({ card: 'generic', title: `Load ${args.skill}`, kind: 'read' }),
    }))

    tools.register(defineTool({
      name: 'vm_status',
      description: 'Status snapshot of the isolated wrapvm desktop VM: container state, ports, image and workspace mount. The VM must be running before vm_shell, vm_browser or vm_desktop calls.',
      parameters: {},
      output: {
        schema: STATUS_SCHEMA,
        render: (_args: object, value: Omit<VmStatus, 'viewerUrl'>) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: async (_args: object, execution: ToolRunContext) => {
        const session = this.sessionKey(execution)
        return await this.withTarget(session, 'vm_status', async target => {
          const { manager, backend } = await this.managed()
          const record = manager.get(target.environmentId)
          if (!record) throw new Error('wrapvm-isolate: environment no longer exists')
          const health = await backend.probe(target, execution.signal)
          return { containerName: target.containerName, image: record.image, state: health.phase, running: health.phase === 'running', viewerPort: target.ports.viewerPort, cdpPort: target.ports.cdpPort, workspaceDir: '/home/user/workspace' }
        }, false)
      },
      presentCall: () => ({ card: 'generic', title: 'VM status', kind: 'read' }),
    }))

    tools.register(defineTool({
      name: 'vm_shell',
      description: 'Run a shell command inside the isolated wrapvm desktop VM as its configured desktop user. Each call runs in a fresh login shell inside the container; pass `workdir` as an absolute path inside the VM (default /home/user/workspace). Each output stream retains at most 4 MiB of its tail. Provide `description` before `command` in the arguments. Before any delete or move, verify the resolved path is the intended one.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command to run inside the VM.' },
        description: { type: 'string', required: true, description: 'Short description shown in the UI.' },
        workdir: { type: 'string', description: 'Absolute working directory inside the VM; defaults to /home/user/workspace.' },
        timeoutMs: { type: 'number', description: 'Command timeout in milliseconds; defaults to 120000.' },
      },
      output: {
        schema: EXEC_SCHEMA,
        render: (_args: object, value: ExecResult) => [{
          type: 'text',
          text: [value.output, value.stderr, `[exit code: ${value.exitCode}]`].filter(Boolean).join('\n'),
        }],
      },
      execute: async (args: { command: string; workdir?: string; timeoutMs?: number }, execution: ToolRunContext) => await this.withTarget(this.sessionKey(execution), 'vm_shell', target => this.exec(target, args, execution.signal)),
      presentCall: (args: { command: string; description: string; workdir?: string }) => ({
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
      }),
      presentResult: (args: { command: string; description: string; workdir?: string }, result: { content: ContentBlock[] }) => {
        const block = result.content.length === 1 ? result.content[0] : undefined
        if (block === undefined || block.type !== 'text') return undefined
        return {
          card: 'terminal',
          title: args.command,
          description: args.description,
          ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
        }
      },
    }))

    tools.register(defineTool({
      name: 'vm_browser',
      description: 'Drive the Chrome inside the isolated wrapvm desktop VM over CDP. Actions: open a page, list tabs, navigate, evaluate JavaScript, read page content, close a tab. `targetId` comes from vm_browser tabs. The VM must be running first.',
      parameters: {
        action: { type: 'string', enum: ['open', 'tabs', 'navigate', 'eval', 'content', 'close'], required: true, description: 'Browser action.' },
        url: { type: 'string', description: 'Target URL for open or navigate.' },
        targetId: { type: 'string', description: 'CDP target id; required for navigate, eval, content and close.' },
        expression: { type: 'string', description: 'JS expression for eval; content reads document.documentElement.outerHTML.' },
        timeoutMs: { type: 'number', description: 'Operation timeout in milliseconds; defaults to 120000.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            target: { type: 'string' },
            value: { type: 'string' },
            targets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args: object, value: { action: string; target?: string; value?: string; targets?: Record<string, unknown>[] }) => [{
          type: 'text',
          text: value.value !== undefined ? String(value.value)
            : value.targets !== undefined ? JSON.stringify(value.targets, undefined, 2)
              : value.target !== undefined ? value.target : value.action,
        }],
      },
      execute: async (args: { action: string; url?: string; targetId?: string; expression?: string; timeoutMs?: number }, execution: ToolRunContext) => {
        const signal = execution.signal
        signal.throwIfAborted()
        return await this.withTarget(this.sessionKey(execution), 'vm_browser', async target => {
        switch (args.action) {
          case 'open': {
            if (args.url === undefined) throw new Error('vm_browser: action open requires url')
            const opened = await this.cdpOpen(target, args.url, signal)
            return { action: 'open', target: opened.id }
          }
          case 'tabs': {
            const targets = await this.cdpTargets(target, signal)
            return { action: 'tabs', targets: targets.map((target) => ({ id: String(target.id), title: String(target.title), url: String(target.url) })) }
          }
          case 'navigate': {
            if (args.targetId === undefined || args.url === undefined) throw new Error('vm_browser: action navigate requires targetId and url')
            await this.cdpNavigate(target, args.targetId, args.url, args.timeoutMs, signal)
            return { action: 'navigate', value: 'ok' }
          }
          case 'eval': {
            if (args.targetId === undefined || args.expression === undefined) throw new Error('vm_browser: action eval requires targetId and expression')
            const value = await this.cdpEval(target, args.targetId, args.expression, args.timeoutMs, signal)
            return { action: 'eval', value: value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value) }
          }
          case 'content': {
            if (args.targetId === undefined) throw new Error('vm_browser: action content requires targetId')
            const value = await this.cdpEval(target, args.targetId, 'document.documentElement.outerHTML', args.timeoutMs, signal)
            return { action: 'content', value: value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value) }
          }
          case 'close': {
            if (args.targetId === undefined) throw new Error('vm_browser: action close requires targetId')
            await this.cdpClose(target, args.targetId, signal)
            return { action: 'close' }
          }
          default: throw new Error(`vm_browser: unknown action ${args.action}`)
        }
        })
      },
      presentCall: (args: { action: string; url?: string; expression?: string; targetId?: string }) => ({
        card: 'generic',
        title: `vm_browser ${args.action}`,
        kind: 'execute',
        rawInput: args.url ?? args.expression ?? args.targetId ?? '',
        content: [{ type: 'text', text: args.url ?? args.expression ?? args.targetId ?? '' }],
      }),
    }))

    tools.register(defineTool({
      name: 'vm_desktop',
      description: 'Run one `agent-desktop` argv inside the isolated wrapvm desktop VM (passthrough `docker exec <container> agent-desktop ...argv`). The VM must be running first.',
      parameters: {
        argv: { type: 'array', items: { type: 'string' }, required: true, description: 'Argument vector passed to agent-desktop inside the VM.' },
        timeoutMs: { type: 'number', description: 'Operation timeout in milliseconds; defaults to 120000.' },
      },
      output: {
        schema: EXEC_SCHEMA,
        render: (_args: object, value: ExecResult) => [{
          type: 'text',
          text: [value.output, value.stderr, `[exit code: ${value.exitCode}]`].filter(Boolean).join('\n'),
        }],
      },
      execute: async (args: { argv: readonly string[]; timeoutMs?: number }, execution: ToolRunContext) => await this.withTarget(this.sessionKey(execution), 'vm_desktop', target => this.desktop(target, args, execution.signal)),
      presentCall: (args: { argv: readonly string[] }) => ({
        card: 'generic',
        title: `agent-desktop ${args.argv.join(' ')}`,
        kind: 'execute',
        rawInput: args.argv.join(' '),
        content: [{ type: 'text', text: args.argv.join(' ') }],
      }),
    }))
  }
}

export default WrapvmIsolateService
