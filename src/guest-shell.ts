/** Guest shell execution against a captured, verified environment target. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSafetyLatch } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { EnvironmentBackendDriver, EnvironmentDescriptor, EnvironmentTarget } from './environments.ts'
import type { EnvironmentManager, ExecutionLedger } from './lifecycle.ts'
import type { ExecResult } from './types.ts'

/** Dependencies owned by the host service; eligibility must require the pinned provider and verified host isolation. */
export interface GuestShellPorts {
  readonly ctx: Context
  readonly manager: EnvironmentManager
  readonly backend: EnvironmentBackendDriver
  readonly leases: ExecutionLedger
  readonly safety: ToolSafetyLatch
  readonly binary: string
  readonly guestEntrypoint: string
  readonly defaultWorkdir: string
  readonly verifyEligibility: (descriptor: EnvironmentDescriptor, target: EnvironmentTarget, signal: AbortSignal) => Promise<void>
  /** A host-attested proof that guest work for this execution has stopped. */
  readonly verifyGuestQuiescence: (target: EnvironmentTarget, signal: AbortSignal) => Promise<boolean>
}

/** Executes one bounded command without retargeting after binding changes. */
export class GuestShell {
  constructor(private readonly ports: GuestShellPorts) {}

  /** Capture the binding under a lease, verify the target, and run the command in the guest. */
  async execute(sessionKey: string, args: { command: string; workdir?: string; timeoutMs: number }, signal: AbortSignal): Promise<ExecResult> {
    const { manager, leases, safety, backend, ctx } = this.ports
    signal.throwIfAborted()
    if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 2_147_481_647) throw new Error('vm_shell: invalid timeout')
    const workdir = args.workdir ?? this.ports.defaultWorkdir
    if (!workdir.startsWith('/')) throw new Error('vm_shell: workdir must be an absolute guest path')
    const initial = manager.binding(sessionKey)
    if (initial === undefined) throw new Error('vm_shell: no verified environment binding')
    const release = await leases.acquireExecution(initial.environmentId, 'vm_shell')
    let processOwnsLease = false
    try {
      signal.throwIfAborted()
      const current = manager.binding(sessionKey)
      if (current === undefined || current.environmentId !== initial.environmentId || current.generation !== initial.generation) throw new Error('vm_shell: binding changed while acquiring the environment')
      const descriptor = manager.get(current.environmentId)
      if (descriptor === undefined || manager.uncertainty(current.environmentId) !== undefined) throw new Error('vm_shell: environment state is unavailable or uncertain')
      if (backend.captureTarget === undefined || backend.verifyTarget === undefined) throw new Error('vm_shell: backend cannot verify the environment target')
      const captured = await backend.captureTarget(current.environmentId, signal)
      if (captured.kind !== 'captured') throw new Error(`vm_shell: environment target ${captured.kind}`)
      const target = Object.freeze({ ...captured.target, ports: Object.freeze({ ...captured.target.ports }) })
      const verified = await backend.verifyTarget(target, signal)
      if (Object.values(verified).some(resource => resource.kind !== 'owned')) throw new Error('vm_shell: environment ownership could not be verified')
      await this.ports.verifyEligibility(descriptor, target, signal)
      signal.throwIfAborted()
      const latest = manager.binding(sessionKey)
      const policy = safety.snapshot(SessionId(sessionKey))
      if (latest?.environmentId !== current.environmentId || latest.generation !== current.generation ||
        policy.record?.mode !== 'protected' || policy.record.generation !== current.generation ||
        policy.record.environmentId !== current.environmentId || !policy.providerAvailable) {
        throw new Error('vm_shell: protected binding changed or is unavailable')
      }
      const deadline = AbortSignal.timeout(args.timeoutMs + 2000)
      const processSignal = AbortSignal.any([signal, deadline])
      processSignal.throwIfAborted()
      const process = ctx.subprocess.spawn({
        argv: [this.ports.binary, 'exec', '-w', workdir, target.containerId, this.ports.guestEntrypoint,
          'timeout', '--kill-after=1s', `${args.timeoutMs / 1000}s`, 'sh', '-lc', args.command],
        cwd: processCwd(), graceMs: 1000, signal: processSignal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 << 20 }, stderr: { maxBytes: 4 << 20 } },
      })
      processOwnsLease = true
      // A local process exit alone does not establish that guest work is gone.
      void Promise.allSettled([process.done, process.waitForExit()]).then(async results => {
        const exit = results[1]
        if (exit?.status !== 'fulfilled' || exit.value !== true || processSignal.aborted) return
        if (await this.ports.verifyGuestQuiescence(target, processSignal)) release()
      }).catch(() => { /* Unverified work keeps the lease until explicit reconciliation. */ })
      const outcome = await process.done
      processSignal.throwIfAborted()
      return { output: process.collected.stdout?.readFrom(0).text ?? '', stderr: process.collected.stderr?.readFrom(0).text ?? '', exitCode: outcome.exitCode ?? 1 }
    } finally {
      if (!processOwnsLease) release()
    }
  }
}

function processCwd(): string { return process.cwd() }
