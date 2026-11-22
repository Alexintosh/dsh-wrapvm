/** Session-scoped provisioning, durable retries and workspace identity. No Remote impersonation. */
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import type { EnvironmentCreateInput, EnvironmentDescriptor, EnvironmentId, EnvironmentOperation } from './environments.ts'
import { asEnvironmentId } from './environments.ts'
import type { BindingRegistry } from './binding.ts'
import { snapshotProject, type WorkspaceSnapshot } from './workspace-copy.ts'

export const preparationSchema = z.object({
  id: z.string().uuid(), session: z.string(), sourceRoot: z.string().nullable(),
  mode: z.enum(['copy', 'empty', 'bind-readonly', 'bind-readwrite']),
  environmentId: z.string().nullable(), containerId: z.string().nullable(),
  guestPath: z.string(), phase: z.enum(['preparing', 'ready']),
  input: z.object({ displayName: z.string(), image: z.string(), internetAccess: z.boolean(), limits: z.object({ cpuMillis: z.number(), memoryBytes: z.number() }), mounts: z.array(z.object({ hostPath: z.string(), guestPath: z.string(), access: z.enum(['read-only', 'read-write']) })) }),
  files: z.array(z.object({ path: z.string(), hash: z.string(), size: z.number(), executable: z.boolean() })),
  snapshot: z.string(), excluded: z.array(z.string()), excludedCount: z.number(),
})
export type Preparation = z.infer<typeof preparationSchema>
export type WorkspaceMode = Preparation['mode']
export interface PreparationStore { get(key: string): Preparation | undefined; put(key: string, value: Preparation): Promise<void> }
export interface PreparationPorts {
  store: PreparationStore
  bindings: BindingRegistry
  defaults: { image: string; cpuMillis: number; memoryBytes: number; internetAccess: boolean }
  get(id: EnvironmentId): EnvironmentDescriptor | undefined
  create(input: EnvironmentCreateInput, key: string, signal: AbortSignal): Promise<EnvironmentOperation>
  running(id: EnvironmentId, signal: AbortSignal): Promise<string>
  install(record: Preparation, initial: WorkspaceSnapshot | undefined, signal: AbortSignal): Promise<void>
  approveMount(root: string, mode: WorkspaceMode, signal: AbortSignal): Promise<void>
}

/** Shared with GUI bind/unbind so a late prepare cannot overwrite a newer user selection. */
export class SessionOperations {
  private readonly pending = new Map<string, Promise<unknown>>()
  async run<T>(session: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(session) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.pending.set(session, next)
    try { return await next } finally { if (this.pending.get(session) === next) this.pending.delete(session) }
  }
}
export function preparationKey(session: string, root: string | null, mode: WorkspaceMode, environmentId?: string): string {
  return createHash('sha256').update(JSON.stringify([session, root, mode, environmentId ?? null])).digest('hex')
}
export const snapshotIdentity = (files: Preparation['files']): string => createHash('sha256').update(JSON.stringify(files)).digest('hex')

/** Caller holds the session operation queue. Persist intent BEFORE any Docker effects. */
export async function prepareEnvironment(ports: PreparationPorts, session: string, root: string | null, requested: { environmentId?: string; workspaceMode?: WorkspaceMode }, signal: AbortSignal): Promise<Preparation> {
  signal.throwIfAborted()
  const mode = requested.workspaceMode ?? (root === null ? 'empty' : 'copy')
  if (mode.startsWith('bind-') && root === null) throw new Error('vm_prepare: no session project to share')
  const binding = ports.bindings.binding(session)
  const baseKey = preparationKey(session, root, mode)
  const base = ports.store.get(baseKey)
  const selected = requested.environmentId ?? binding?.environmentId
  const selectedKey = selected ? preparationKey(session, root, mode, selected) : undefined
  const key = selectedKey && ports.store.get(selectedKey) ? selectedKey
    : selected && base?.environmentId === selected ? baseKey
    : selected && (requested.environmentId || base) ? selectedKey! : baseKey
  let record = ports.store.get(key)
  if (record && requested.environmentId && requested.environmentId !== record.environmentId) {
    throw new Error('vm_prepare: this workspace already has a prepared environment; use it or change the session project')
  }
  if (record && (record.session !== session || record.sourceRoot !== root || record.mode !== mode || record.guestPath !== `/home/user/workspace/projects/${record.id}` || record.snapshot !== snapshotIdentity(record.files))) throw new Error('vm_prepare: stored preparation does not match this session/project')
  let initial: WorkspaceSnapshot | undefined
  if (!record) {
    initial = await snapshotProject(mode === 'copy' ? root : null, signal)
    const id = randomUUID()
    const selected = requested.environmentId ?? binding?.environmentId ?? null
    if (selected && !ports.get(asEnvironmentId(selected))) throw new Error('vm_prepare: selected environment is missing; no replacement was created')
    // Existing environments cannot acquire new bind mounts. Do not pretend that they did.
    if (selected && mode.startsWith('bind-')) throw new Error('vm_prepare: bind mounts require a new environment; use copy mode with the selected environment')
    record = { id, session, sourceRoot: root, mode, environmentId: selected, containerId: null,
      guestPath: `/home/user/workspace/projects/${id}`, phase: 'preparing',
      input: { displayName: root ? basename(root) : 'Agent workspace', image: ports.defaults.image,
        limits: { cpuMillis: ports.defaults.cpuMillis, memoryBytes: ports.defaults.memoryBytes }, internetAccess: ports.defaults.internetAccess,
        mounts: mode.startsWith('bind-') && root ? [{ hostPath: root, guestPath: `/home/user/workspace/projects/${id}`, access: mode === 'bind-readwrite' ? 'read-write' : 'read-only' }] : [] },
      files: initial.files.map(({ data: _data, ...f }) => f), snapshot: snapshotIdentity(initial.files.map(({ data: _data, ...f }) => f)),
      excluded: initial.excluded, excludedCount: initial.excludedCount }
    await ports.store.put(key, record)
  }
  if (record.mode.startsWith('bind-') && record.environmentId === null) await ports.approveMount(record.sourceRoot!, record.mode, signal)
  signal.throwIfAborted()
  if (record.environmentId === null) {
    const op = await ports.create(record.input, `prepare:${record.id}`, signal)
    if (op.state !== 'completed') throw new Error(`vm_prepare: ${op.errorCode ?? op.state}: ${op.error ?? 'environment preparation did not complete'}`)
    record = { ...record, environmentId: op.environmentId }
    await ports.store.put(key, record)
  }
  if (!record.environmentId) throw new Error('vm_prepare: missing committed environment identity')
  const environmentId = asEnvironmentId(record.environmentId)
  const descriptor = ports.get(environmentId)
  if (!descriptor) throw new Error('vm_prepare: prepared environment was removed; no replacement was created')
  if (record.containerId && descriptor.containerId !== record.containerId) throw new Error('vm_prepare: container identity changed')
  const containerId = await ports.running(environmentId, signal)
  if (!record.containerId) { record = { ...record, containerId }; await ports.store.put(key, record) }
  await ports.install(record, initial, signal)
  if (record.phase !== 'ready') {
    signal.throwIfAborted()
    record = { ...record, phase: 'ready' }
    await ports.store.put(key, record)
  }
  signal.throwIfAborted()
  const current = ports.bindings.binding(session)
  if (current?.environmentId !== environmentId) await ports.bindings.bind(session, environmentId, (current?.generation ?? 0) + 1, { allowShared: requested.environmentId !== undefined })
  return record
}
