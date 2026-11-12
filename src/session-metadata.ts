/** Durable activation metadata; the core safety latch remains the policy authority. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ActivationIntent } from './activation.ts'
import type {} from './session-events.ts'

const intentSchema = z.object({
  generation: z.number().int().positive().safe(),
  source: z.enum(['command', 'button']),
  requestedAt: z.number().finite(),
  seq: z.number().int().nonnegative().safe(),
})
const releaseSchema = z.object({ generation: z.number().int().positive().safe(), seq: z.number().int().nonnegative().safe() })
const stateSchema = z.object({ intent: intentSchema.nullable(), release: releaseSchema.nullable(), invalid: z.boolean() })
type IntentState = z.infer<typeof stateSchema>

/** Tracks the last intent and its log position for durable idempotent retries. */
export const intentProjection = {
  key: 'wrapvmActivationIntent',
  stateVersion: 1,
  stateSchema,
  init: () => ({ intent: null, release: null, invalid: false }),
  apply(state, event) {
    if (event.type !== 'wrapvm/activation-requested' && event.type !== 'wrapvm/policy-released') return state
    if (state.invalid) return state
    if (event.type === 'wrapvm/policy-released') {
      const released = releaseSchema.safeParse({ ...event.data, seq: event.seq })
      if (!released.success || state.intent?.generation !== released.data.generation || state.release?.generation === released.data.generation) {
        return { ...state, invalid: true }
      }
      return { ...state, release: released.data }
    }
    const parsed = intentSchema.safeParse({ ...event.data, seq: event.seq })
    if (!parsed.success || (state.intent !== null && parsed.data.generation <= state.intent.generation)) {
      return { ...state, invalid: true }
    }
    return { intent: parsed.data, release: null, invalid: false }
  },
} satisfies ProjectionDefinition<'wrapvmActivationIntent', IntentState>

/** Writes intent metadata through the Session persistence-owned checkpoint. */
export class DurableActivationIntent {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly released = new Map<string, number>()

  constructor(private readonly ctx: Context, private readonly projection: ProjectionHandle<IntentState>) {}

  /** Persist one intent per session and generation; a retry reuses the original event. */
  async persist(intent: ActivationIntent): Promise<void> {
    await this.serialize(intent.sessionKey, async () => {
      const session = this.ctx.sessions.get(SessionId(intent.sessionKey))
      const durability = this.ctx.get('sessionDurability')
      if (session === undefined || durability === undefined) throw new Error('wrapvm-isolate: live session and durable writer are required')
      const state = this.projection.stateOf(session)
      if (state.invalid) throw new Error('wrapvm-isolate: activation intent history is invalid')
      const releasedGeneration = this.released.get(intent.sessionKey)
      if ((releasedGeneration !== undefined && releasedGeneration >= intent.generation) || state.release?.generation === intent.generation) throw new Error('wrapvm-isolate: activation intent belongs to a released generation')
      if (state.intent !== null && state.intent.generation > intent.generation) throw new Error('wrapvm-isolate: stale activation intent')
      if (state.intent?.generation === intent.generation) {
        await durability.checkpoint(session, SessionSeq(state.intent.seq))
        return
      }
      if (intent.source === 'model-tool') throw new Error('wrapvm-isolate: a model tool cannot initiate VM mode')
      intentSchema.parse({ generation: intent.generation, source: intent.source, requestedAt: intent.requestedAt, seq: 0 })
      const event = session.append('wrapvm/activation-requested', {
        generation: intent.generation, source: intent.source, requestedAt: intent.requestedAt,
      })
      await durability.checkpoint(session, event.seq)
    })
  }

  /**
   * Serialize an authenticated core release with intent metadata.
   * The caller verifies authentication before invoking this method. `coreReleased`
   * must read the latch, including its recovery reason; metadata never authorizes release. If no intent exists, no release event
   * is written. A failed metadata checkpoint is an unknown outcome.
   * @param sessionKey - the live conversation.
   * @param generation - generation being released.
   * @param releaseCore - authenticated core release operation.
   * @param coreReleased - reads the authoritative core state for this generation.
   */
  async release(sessionKey: string, generation: number, releaseCore: () => Promise<void>, coreReleased: () => boolean): Promise<void> {
    await this.serialize(sessionKey, async () => {
      const session = this.ctx.sessions.get(SessionId(sessionKey))
      const durability = this.ctx.get('sessionDurability')
      if (session === undefined || durability === undefined) throw new Error('wrapvm-isolate: live session and durable writer are required')
      const state = this.projection.stateOf(session)
      if (state.invalid) throw new Error('wrapvm-isolate: activation intent history is invalid')
      if (state.intent !== null && state.intent.generation > generation) throw new Error('wrapvm-isolate: stale release')
      const matching = state.intent?.generation === generation
      if (matching) await durability.checkpoint(session, SessionSeq(state.intent!.seq))
      if (!coreReleased()) await releaseCore()
      if (!coreReleased()) throw new Error('wrapvm-isolate: core release was not confirmed')
      this.released.set(sessionKey, generation)
      if (!matching) return
      if (state.release?.generation === generation) {
        await durability.checkpoint(session, SessionSeq(state.release.seq))
        return
      }
      const event = session.append('wrapvm/policy-released', { generation })
      await durability.checkpoint(session, event.seq)
    })
  }

  private async serialize(sessionKey: string, job: () => Promise<void>): Promise<void> {
    const prior = this.queues.get(sessionKey) ?? Promise.resolve()
    const current = prior.then(job, job)
    const settled = current.then(() => {}, () => {})
    this.queues.set(sessionKey, settled)
    try {
      await current
    } finally {
      if (this.queues.get(sessionKey) === settled) this.queues.delete(sessionKey)
    }
  }
}
