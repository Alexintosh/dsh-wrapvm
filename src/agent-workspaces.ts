/** Agent entry point: session-derived projects and shared manager operations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { BindingRegistry } from './binding.ts'
import type { EnvironmentManager, ExecutionLeaseRegistry } from './lifecycle.ts'
import type { DockerEnvironmentBackend } from './docker-backend.ts'
import { asEnvironmentId } from './environments.ts'
import { prepareEnvironment, snapshotIdentity, type Preparation, type PreparationStore, type WorkspaceMode } from './preparation.ts'
import { projectRoot, snapshotProject, filePath, exportReview, type WorkspacePayload } from './workspace-copy.ts'
import { GUEST_WORKSPACE_PROGRAM } from './guest-workspace.ts'
import { z } from 'zod'

export interface WorkspaceRuntime {
  manager: EnvironmentManager
  backend: DockerEnvironmentBackend
  bindings: BindingRegistry
  leases: ExecutionLeaseRegistry
  store: PreparationStore
  defaults: { image: string; cpuMillis: number; memoryBytes: number; internetAccess: boolean }
  current(session: string): Preparation | undefined
  select(record: Preparation): Promise<void>
  run(argv: readonly string[], options: { signal: AbortSignal; stdin?: string; maxBytes?: number }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>
  lifetime: AbortSignal
  binary: string
}
export function currentProject(ctx: Context, execution: ToolRunContext): string | null {
  const session = execution.agent?.session
  if (!session) throw new Error('vm_prepare: tool call has no conversation')
  const directory = ctx.get('workingDirectory')
  const effective = directory?.get(session)
  // Never copy the plugin's launch directory as a substitute for a project.
  return effective && (session.header.cwd || effective !== directory?.defaultDirectory) ? effective : session.header.cwd ?? null
}
export function workspaceInfo(record: Preparation | undefined) {
  return record ? { phase: record.phase, mode: record.mode, sourceRoot: record.sourceRoot, guestPath: record.guestPath, snapshot: record.snapshot, files: record.files.length, excluded: record.excluded, excludedCount: record.excludedCount } : null
}
async function targetOperation<T>(runtime: WorkspaceRuntime, record: Preparation, signal: AbortSignal, task: (id: string) => Promise<T>): Promise<T> {
  if (!record.environmentId || !record.containerId) throw new Error('vm_workspace: environment not prepared')
  const id = asEnvironmentId(record.environmentId)
  const release = await runtime.leases.acquireExecution(id, 'vm_workspace')
  try {
    signal.throwIfAborted()
    if (runtime.manager.uncertainty(id)) throw new Error('vm_workspace: environment outcome is unknown')
    const capture = await runtime.backend.captureTarget(id, signal)
    if (capture.kind !== 'captured' || capture.target.containerId !== record.containerId) throw new Error('vm_workspace: container identity changed')
    const verification = await runtime.backend.verifyTarget(capture.target, signal)
    if (verification.container.kind !== 'owned') throw new Error('vm_workspace: container ownership cannot be verified')
    return await task(capture.target.containerId)
  } finally { release() }
}
async function guest(runtime: WorkspaceRuntime, id: string, record: Preparation, action: string, data: object, signal: AbortSignal): Promise<unknown> {
  const result = await runtime.run([runtime.binary, 'exec', '-i', id, '/opt/wrap/bin/wrap-entrypoint', 'python3', '-c', GUEST_WORKSPACE_PROGRAM], {
    signal, maxBytes: 92 * 1024 * 1024, stdin: JSON.stringify({ action, root: record.guestPath, snapshot: record.snapshot, ...data }),
  })
  if (result.exitCode !== 0) throw new Error(`vm_workspace: guest ${action} failed: ${result.stderr.slice(-2000)}`)
  return JSON.parse(result.stdout)
}
export async function prepareForAgent(ctx: Context, runtime: WorkspaceRuntime, execution: ToolRunContext, args: { environmentId?: string; workspaceMode?: WorkspaceMode }) {
  const session = execution.agent?.session.id
  if (!session) throw new Error('vm_prepare: tool call has no conversation')
  const signal = AbortSignal.any([execution.signal, runtime.lifetime])
  const path = args.workspaceMode === 'empty' ? null : currentProject(ctx, execution)
  const root = path === null ? null : await projectRoot(path)
  if (!runtime.defaults.internetAccess && !runtime.current(session) && !runtime.bindings.binding(session)) throw new Error('vm_prepare: profile disallows internet; this desktop backend cannot create offline environments. No resources allocated.')
  let lifecycle = 'reused'
  const record = await prepareEnvironment({
    ...runtime,
    get: id => runtime.manager.get(id),
    create: async (input, key, ended) => {
      // Missing local images must not allocate a network/volume or trigger an implicit pull.
      const image = await runtime.run([runtime.binary, 'image', 'inspect', '--format', '{{.Id}}', input.image], { signal: ended })
      if (image.exitCode !== 0 || !image.stdout.trim()) throw new Error(`vm_prepare: configured image ${input.image} is not available locally; ask the user to install it or choose an installed image in plugin configuration`)
      lifecycle = 'created'
      return await runtime.manager.create(input, { idempotencyKey: key, signal: ended })
    },
    running: async (id, ended) => {
      if (runtime.manager.uncertainty(id)) throw new Error('vm_prepare: environment has an uncertain operation; inspect it before retrying')
      let target = await runtime.backend.captureTarget(id, ended)
      if (target.kind !== 'captured') throw new Error(`vm_prepare: environment ${target.kind}; no replacement created`)
      const health = await runtime.backend.probe(target.target, ended)
      if (health.phase === 'paused' || health.phase === 'stopped' || health.phase === 'created') {
        const resume = health.phase === 'paused'
        const op = await (resume ? runtime.manager.resume(id, { signal: ended }) : runtime.manager.start(id, { signal: ended }))
        if (op.state !== 'completed') throw new Error(`vm_prepare: ${op.error ?? op.state}`)
        lifecycle = resume ? 'resumed' : 'started'
        target = await runtime.backend.captureTarget(id, ended)
        if (target.kind !== 'captured') throw new Error('vm_prepare: target unavailable after start')
      }
      const ready = await runtime.backend.probe(target.target, ended)
      if (ready.phase !== 'running' || ready.shell.kind !== 'available') throw new Error('vm_prepare: guest is not ready; retry preparation once startup has completed')
      return target.target.containerId
    },
    approveMount: async (source, mode, ended) => {
      const approval = ctx.get('approval')
      if (!approval || !execution.agent) throw new Error('vm_prepare: explicit host mount approval is unavailable; use copy mode')
      const decision = await approval.request({ agent: execution.agent, toolName: 'vm_prepare', callId: execution.callId, signal: ended,
        reason: `Share exactly ${source} with this VM in ${mode === 'bind-readwrite' ? 'READ/WRITE (guest can change host files)' : 'read-only'} mode? This shares the full project, including files excluded from copy mode.` })
      if (decision !== 'allowed-once') throw new Error(`vm_prepare: host mount ${decision}`)
      runtime.backend.approveMounts([{ hostPath: source }])
    },
    install: async (item, initial, ended) => await targetOperation(runtime, item, ended, async id => {
      if (item.mode.startsWith('bind-')) {
        const result = await runtime.run([runtime.binary, 'exec', id, '/opt/wrap/bin/wrap-entrypoint', 'test', '-d', item.guestPath], { signal: ended })
        if (result.exitCode !== 0) throw new Error('vm_prepare: shared workspace unavailable')
        return
      }
      const probe = z.object({ ready: z.boolean() }).parse(await guest(runtime, id, item, 'probe', {}, ended))
      if (probe.ready) return // Existing guest edits are intentionally preserved.
      if (item.phase === 'ready') throw new Error('vm_prepare: prepared workspace disappeared; refusing to recreate it')
      const snapshot = initial ?? await snapshotProject(item.mode === 'copy' ? item.sourceRoot : null, ended)
      if (snapshotIdentity(snapshot.files.map(({ data: _data, ...f }) => f)) !== item.snapshot) throw new Error('vm_prepare: host files changed after interrupted preparation; original intent preserved, no overwrite performed')
      z.object({ ready: z.literal(true) }).parse(await guest(runtime, id, item, 'install', { files: snapshot.files }, ended))
    }),
  }, session, root, args, signal)
  await runtime.select(record)
  return { ready: true, environmentId: record.environmentId, action: lifecycle, internetAccess: runtime.manager.get(asEnvironmentId(record.environmentId!))?.internetAccess ?? false, workspace: workspaceInfo(record), next: 'Use vm_shell, vm_browser or vm_desktop. The viewer is optional.' }
}
export async function workspaceForAgent(ctx: Context, runtime: WorkspaceRuntime, execution: ToolRunContext, args: { action: string; paths?: string[] }) {
  const signal = AbortSignal.any([execution.signal, runtime.lifetime])
  signal.throwIfAborted()
  const session = execution.agent?.session.id
  if (!session) throw new Error('vm_workspace: tool call has no conversation')
  const record = runtime.current(session)
  if (!record || record.environmentId !== runtime.bindings.binding(session)?.environmentId) throw new Error('vm_workspace: call vm_prepare for the current project first')
  if (args.action === 'status') return { workspace: workspaceInfo(record) }
  if (record.phase !== 'ready' || record.mode !== 'copy' || !record.sourceRoot) throw new Error('vm_workspace: import/export requires a prepared project copy')
  const current = currentProject(ctx, execution)
  if (!current || await projectRoot(current) !== record.sourceRoot) throw new Error('vm_workspace: session project changed; call vm_prepare first')
  if (!args.paths?.length || args.paths.length > 100) throw new Error('vm_workspace: specify between 1 and 100 relative file paths')
  const paths = [...new Set(args.paths.map(filePath))]
  return await targetOperation(runtime, record, signal, async id => {
    if (args.action === 'import') {
      const snapshot = await snapshotProject(record.sourceRoot, signal, paths)
      return z.object({ imported: z.array(z.string()), unchanged: z.array(z.string()), conflicts: z.array(z.string()) }).parse(await guest(runtime, id, record, 'import', { files: snapshot.files }, signal))
    }
    if (args.action !== 'export') throw new Error('vm_workspace: unknown action')
    const result = z.object({ files: z.array(z.object({ path: z.string(), hash: z.string(), size: z.number(), executable: z.boolean(), data: z.string() })).max(100) }).parse(await guest(runtime, id, record, 'read', { paths }, signal))
    if (result.files.length !== paths.length || result.files.some((f, i) => f.path !== paths[i])) throw new Error('vm_workspace: guest returned unrequested paths')
    const review = await exportReview(record.sourceRoot!, result.files as WorkspacePayload[], record.files, signal)
    return { ...review, files: paths, appliedToOriginals: false, next: 'Review exported files; originals have not been overwritten.' }
  })
}
