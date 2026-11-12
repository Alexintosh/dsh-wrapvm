import { afterEach, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { asEnvironmentId } from '../src/environments.ts'
import { bindingSessionProjection, SessionBindingSink } from '../src/binding-session.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

it('retries an ambiguous binding checkpoint without writing another event', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  const checkpoints: number[] = []
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, seq: SessionSeq): Promise<void> {
      checkpoints.push(seq)
      if (checkpoints.length === 1) throw new Error('ambiguous checkpoint')
    }
  }
  await ctx.plugin(Durability)
  const projection = await ctx.sessionProjections.register(bindingSessionProjection)
  const session = ctx.sessions.create(SessionId('bind-session'))
  const sink = new SessionBindingSink(ctx, projection)
  const request = { type: 'wrapvm/environment-bound' as const, sessionKey: session.id, environmentId: asEnvironmentId('env-1'), generation: 1, timestamp: 10 }
  await expect(sink.emit(request)).rejects.toThrow('ambiguous')
  await sink.emit({ ...request, timestamp: 20 })
  expect(checkpoints[0]).toBe(checkpoints[1])
  expect(sink.eventsFor(session)).toEqual([request])
  await sink.emit({ type: 'wrapvm/environment-unbound', sessionKey: session.id, environmentId: asEnvironmentId('env-1'), timestamp: 30 })
  expect(sink.eventsFor(session)).toHaveLength(2)
  await projection.dispose()
})

it('refuses invalid ordering before appending and does not invent a writer', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  const projection = await ctx.sessionProjections.register(bindingSessionProjection)
  const session = ctx.sessions.create(SessionId('binding-missing-writer'))
  const sink = new SessionBindingSink(ctx, projection)
  const unbind = { type: 'wrapvm/environment-unbound' as const, sessionKey: session.id, environmentId: asEnvironmentId('env-1'), timestamp: 10 }
  await expect(sink.emit(unbind)).rejects.toThrow('durable writer')
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, _seq: SessionSeq): Promise<void> {}
  }
  await ctx.plugin(Durability)
  await expect(sink.emit(unbind)).rejects.toThrow('invalid ordering')
  expect(sink.eventsFor(session)).toEqual([])
  await projection.dispose()
})


it('does not inherit environment ownership when a Session is forked', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, _seq: SessionSeq): Promise<void> {}
  }
  await ctx.plugin(Durability)
  const projection = await ctx.sessionProjections.register(bindingSessionProjection)
  const parent = ctx.sessions.create(SessionId('binding-parent'))
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session === parent) events.push(event) })
  const sink = new SessionBindingSink(ctx, projection)
  await sink.emit({ type: 'wrapvm/environment-bound', sessionKey: parent.id, environmentId: asEnvironmentId('env-1'), generation: 1, timestamp: 1 })
  const childId = SessionId('binding-child')
  const child = Session.create(childId, events, { ...parent.header, id: childId, isSeeded: true }, SessionLogOffset(events.length))
  expect(sink.eventsFor(child)).toEqual([])
  await projection.dispose()
})
