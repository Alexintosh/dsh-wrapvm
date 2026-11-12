/** Maps controller attempts to the core latch's durable transition fences. */
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SafetyTransitionFence, ToolSafetyLatch } from '@deepseek-ai/dsh-tools'
import type { ActivationAttemptFence } from './activation.ts'
import type { PolicyRecord } from './policy.ts'

/** One instance belongs to the service that owns the activation controller. */
export class CoreFenceBridge {
  private readonly attempts = new Map<symbol, { fence: SafetyTransitionFence; sessionKey: string; generation: number }>()

  constructor(private readonly latch: ToolSafetyLatch) {}

  /** Close admission synchronously and persist the activating policy. */
  arm(record: PolicyRecord, attempt: ActivationAttemptFence): Promise<void> {
    if (record.mode !== 'activating') throw new Error('wrapvm-isolate: arm requires activating mode')
    if (this.attempts.has(attempt.attemptId)) throw new Error('wrapvm-isolate: activation attempt already armed')
    const fence: SafetyTransitionFence = { attemptId: randomUUID(), signal: attempt.signal }
    this.attempts.set(attempt.attemptId, { fence, sessionKey: record.sessionKey, generation: record.generation })
    return this.latch.arm({ ...record, sessionKey: SessionId(record.sessionKey) }, fence).catch(error => {
      this.attempts.delete(attempt.attemptId)
      throw error
    })
  }

  /** Commit only against the same core attempt installed by arm. */
  commit(sessionKey: string, generation: number, environmentId: string, attempt: ActivationAttemptFence): Promise<void> {
    if (environmentId.length === 0) throw new Error('wrapvm-isolate: commit requires an environment')
    const armed = this.attempts.get(attempt.attemptId)
    if (armed === undefined || armed.fence.signal !== attempt.signal || armed.sessionKey !== sessionKey || armed.generation !== generation) {
      throw new Error('wrapvm-isolate: activation attempt does not match its armed session and generation')
    }
    return this.latch.commit({ sessionKey: SessionId(sessionKey), generation, environmentId, mode: 'protected', stage: 'idle' }, armed.fence)
      .finally(() => { this.attempts.delete(attempt.attemptId) })
  }

  /** Drop process-local attempt identities when their owning controller is disposed. */
  dispose(): void {
    this.attempts.clear()
  }
}
