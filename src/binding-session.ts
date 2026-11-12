/** Session-backed binding events and replay state. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { asEnvironmentId } from './environments.ts'
import type { BindingEvent, BindingEventSink } from './binding.ts'
import type {} from './session-events.ts'

const boundSchema = z.object({
  type: z.literal('wrapvm/environment-bound'), sessionKey: z.string().min(1), environmentId: z.string().min(3),
  generation: z.number().int().positive().safe(), timestamp: z.number().finite(), shared: z.boolean().optional(), seq: z.number().int().nonnegative().safe(),
}).strict()
const unboundSchema = z.object({
  type: z.literal('wrapvm/environment-unbound'), sessionKey: z.string().min(1), environmentId: z.string().min(3),
  timestamp: z.number().finite(), seq: z.number().int().nonnegative().safe(),
}).strict()
const eventSchema = z.discriminatedUnion('type', [boundSchema, unboundSchema])
const stateSchema = z.object({ sessionKey: z.string(), inherited: z.number().int().nonnegative(), events: z.array(eventSchema), invalid: z.boolean() })
type BindingState = z.infer<typeof stateSchema>
type StoredBindingEvent = z.infer<typeof eventSchema>

/** Replays only this Session's own binding events; inherited bindings do not grant ownership. */
export const bindingSessionProjection = {
  key: 'wrapvmBindingEvents',
  stateVersion: 1,
  stateSchema,
  init: (header, inherited) => ({ sessionKey: header.id, inherited, events: [], invalid: false }),
  apply(state, event) {
    if (event.type !== 'wrapvm/environment-bound' && event.type !== 'wrapvm/environment-unbound') return state
    if (event.seq < state.inherited || state.invalid) return state
    const parsed = eventSchema.safeParse({ ...event.data, type: event.type, seq: event.seq })
    if (!parsed.success || parsed.data.sessionKey !== state.sessionKey) return { ...state, invalid: true }
    try { asEnvironmentId(parsed.data.environmentId) } catch { return { ...state, invalid: true } }
    const previous = state.events.at(-1)
    if (parsed.data.type === 'wrapvm/environment-unbound' &&
      (previous?.type !== 'wrapvm/environment-bound' || previous.environmentId !== parsed.data.environmentId)) return { ...state, invalid: true }
    return { ...state, events: [...state.events, parsed.data] }
  },
} satisfies ProjectionDefinition<'wrapvmBindingEvents', BindingState>

function sameRequest(stored: StoredBindingEvent, event: BindingEvent): boolean {
  if (stored.type !== event.type || stored.sessionKey !== event.sessionKey || stored.environmentId !== event.environmentId) return false
  if (stored.type === 'wrapvm/environment-bound' && event.type === 'wrapvm/environment-bound') {
    return stored.generation === event.generation && (stored.shared === true) === (event.shared === true)
  }
  return stored.type === 'wrapvm/environment-unbound' && event.type === 'wrapvm/environment-unbound'
}

/** One service-owned sink serializes writes for each Session. */
export class SessionBindingSink implements BindingEventSink {
  private readonly queues = new Map<string, Promise<void>>()
  constructor(private readonly ctx: Context, private readonly projection: ProjectionHandle<BindingState>) {}

  /** Persist the event or checkpoint the matching prior event after an ambiguous write. */
  async emit(event: BindingEvent): Promise<void> {
    const previous = this.queues.get(event.sessionKey) ?? Promise.resolve()
    const write = previous.then(async () => {
      const session = this.ctx.sessions.get(SessionId(event.sessionKey))
      const durability = this.ctx.get('sessionDurability')
      if (session === undefined || durability === undefined) throw new Error('wrapvm-isolate: live session and durable writer are required for binding')
      const state = this.projection.stateOf(session)
      if (state.invalid) throw new Error('wrapvm-isolate: invalid binding event history')
      const last = state.events.at(-1)
      if (last !== undefined && sameRequest(last, event)) {
        await durability.checkpoint(session, SessionSeq(last.seq))
        return
      }
      eventSchema.parse({ ...event, seq: session.seq })
      asEnvironmentId(event.environmentId)
      if (event.type === 'wrapvm/environment-unbound' &&
        (last?.type !== 'wrapvm/environment-bound' || last.environmentId !== event.environmentId)) {
        throw new Error('wrapvm-isolate: binding event has invalid ordering')
      }
      const data = { sessionKey: event.sessionKey, environmentId: event.environmentId, timestamp: event.timestamp }
      const appended = event.type === 'wrapvm/environment-bound'
        ? session.append('wrapvm/environment-bound', { ...data, generation: event.generation, ...(event.shared === true ? { shared: true } : {}) })
        : session.append('wrapvm/environment-unbound', data)
      await durability.checkpoint(session, appended.seq)
    })
    const settled = write.then(() => {}, () => {})
    this.queues.set(event.sessionKey, settled)
    try { await write } finally { if (this.queues.get(event.sessionKey) === settled) this.queues.delete(event.sessionKey) }
  }

  /** Read this Session's own validated binding events for authoritative catalog replay. */
  eventsFor(session: Parameters<ProjectionHandle<BindingState>['stateOf']>[0]): readonly BindingEvent[] {
    const state = this.projection.stateOf(session)
    if (state.invalid) throw new Error('wrapvm-isolate: invalid binding event history')
    return state.events.map(event => event.type === 'wrapvm/environment-bound'
      ? { type: event.type, sessionKey: event.sessionKey, environmentId: asEnvironmentId(event.environmentId), generation: event.generation,
          timestamp: event.timestamp, ...(event.shared === true ? { shared: true } : {}) }
      : { type: event.type, sessionKey: event.sessionKey, environmentId: asEnvironmentId(event.environmentId), timestamp: event.timestamp })
  }
}
