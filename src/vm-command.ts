/** Authenticated pre-turn `/use-vm` command. */
import type { Session } from '@deepseek-ai/dsh-session'
import type { VmActivationController } from './activation.ts'

/** The command registry face needed by this registration. */
export interface VmCommandRegistry {
  register(definition: {
    name: string
    description: string
    handler(invocation: { readonly ownerGateway: boolean; readonly agent: { readonly session: Session }; readonly rawInput: string; readonly signal: AbortSignal }): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }>
  }): () => void
}

/** Register the command against the service-owned activation controller. */
export function registerUseVmCommand(commands: VmCommandRegistry, activation: VmActivationController): () => void {
  return commands.register({
    name: 'use-vm',
    description: 'Activate protected VM mode for this conversation.',
    handler: async invocation => {
      if (!invocation.ownerGateway) return { kind: 'error', text: 'VM mode requires an authenticated owner action.' }
      if (invocation.rawInput.trim() !== '') return { kind: 'error', text: '/use-vm does not accept environment or configuration arguments.' }
      if (invocation.signal.aborted) return { kind: 'error', text: 'VM activation was cancelled.' }
      const handle = activation.request(invocation.agent.session.id, 'command')
      const cancel = (): void => { activation.cancelAttempt(handle, 'VM activation was cancelled') }
      invocation.signal.addEventListener('abort', cancel, { once: true })
      if (invocation.signal.aborted) cancel()
      try {
        const outcome = await handle.done
        if (invocation.signal.aborted) return { kind: 'error', text: 'VM activation was cancelled; the conversation remains blocked.' }
        if (outcome.mode !== 'protected') return { kind: 'error', text: outcome.reason ?? 'VM mode is unavailable; the conversation remains blocked.' }
        return { kind: 'success', text: 'VM mode is active.' }
      } finally {
        invocation.signal.removeEventListener('abort', cancel)
      }
    },
  })
}
