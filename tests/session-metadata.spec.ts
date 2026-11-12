import { afterEach, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DurableActivationIntent, intentProjection } from '../src/session-metadata.ts'

let ctx: Context | undefined

afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

it('reuses the persisted intent after an ambiguous checkpoint and a new adapter', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  let attempts = 0
  const checkpointed: number[] = []
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, seq: SessionSeq): Promise<void> {
      checkpointed.push(seq)
      if (attempts++ === 0) throw new Error('ambiguous checkpoint')
    }
  }
  await ctx.plugin(Durability)
  const projection = await ctx.sessionProjections.register(intentProjection)
  const session = ctx.sessions.create(SessionId('metadata-test'))
  const intent = { sessionKey: session.id, generation: 1, source: 'command' as const, requestedAt: 100 }
  const first = new DurableActivationIntent(ctx, projection)
  await expect(first.persist(intent)).rejects.toThrow('ambiguous checkpoint')
  const replacement = new DurableActivationIntent(ctx, projection)
  await replacement.persist({ ...intent, source: 'button', requestedAt: 200 })
  expect(checkpointed).toEqual([checkpointed[0], checkpointed[0]])
  expect(projection.stateOf(session)).toMatchObject({ invalid: false, intent: { generation: 1, source: 'command', requestedAt: 100 } })
  await expect(replacement.persist({ ...intent, generation: 0 })).rejects.toThrow('stale')
  await projection.dispose()
})

it('requires an actual durability capability before appending', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  const projection = await ctx.sessionProjections.register(intentProjection)
  const session = ctx.sessions.create(SessionId('no-writer'))
  const writer = new DurableActivationIntent(ctx, projection)
  await expect(writer.persist({ sessionKey: session.id, generation: 1, source: 'command', requestedAt: 1 })).rejects.toThrow('durable writer')
  expect(projection.stateOf(session)).toEqual({ intent: null, release: null, invalid: false })
  await projection.dispose()
})

it('serializes release with intent and never emits release without a matching intent', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  const checkpoints: number[] = []
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, seq: SessionSeq): Promise<void> { checkpoints.push(seq) }
  }
  await ctx.plugin(Durability)
  const projection = await ctx.sessionProjections.register(intentProjection)
  const noIntent = ctx.sessions.create(SessionId('release-before-intent'))
  const withIntent = ctx.sessions.create(SessionId('release-after-intent'))
  const writer = new DurableActivationIntent(ctx, projection)
  await writer.release(noIntent.id, 1, async () => {}, () => true)
  expect(projection.stateOf(noIntent)).toEqual({ intent: null, release: null, invalid: false })
  await expect(writer.persist({ sessionKey: noIntent.id, generation: 1, source: 'command', requestedAt: 1 })).rejects.toThrow('released generation')
  const intent = { sessionKey: withIntent.id, generation: 1, source: 'button' as const, requestedAt: 2 }
  const pending = writer.persist(intent)
  const released = writer.release(withIntent.id, 1, async () => {}, () => true)
  await Promise.all([pending, released])
  expect(projection.stateOf(withIntent)).toMatchObject({ invalid: false, intent: { generation: 1 }, release: { generation: 1 } })
  expect(checkpoints).toHaveLength(3)
  await expect(writer.persist(intent)).rejects.toThrow('released generation')
  await projection.dispose()
})

it('does not write release metadata when core release is rejected', async () => {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, _seq: SessionSeq): Promise<void> {}
  }
  await ctx.plugin(Durability)
  const projection = await ctx.sessionProjections.register(intentProjection)
  const session = ctx.sessions.create(SessionId('release-rejected'))
  const writer = new DurableActivationIntent(ctx, projection)
  await writer.persist({ sessionKey: session.id, generation: 1, source: 'command', requestedAt: 1 })
  await expect(writer.release(session.id, 1, async () => { throw new Error('not authorized') }, () => false)).rejects.toThrow('not authorized')
  expect(projection.stateOf(session)).toMatchObject({ invalid: false, release: null })
  await projection.dispose()
})

it('retries an ambiguous metadata checkpoint without re-releasing the confirmed core latch', async () => {
  const { SafetyRuntime } = await import('../../../core/tools/src/safety-latch.ts')
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  let checkpoints = 0
  class Durability extends Service {
    constructor(inner: Context) { super(inner, 'sessionDurability') }
    async checkpoint(_session: Session, _seq: SessionSeq): Promise<void> {
      if (++checkpoints === 3) throw new Error('metadata checkpoint uncertain')
    }
  }
  await ctx.plugin(Durability)
  const projection = await ctx.sessionProjections.register(intentProjection)
  const session = ctx.sessions.create(SessionId('release-ambiguous'))
  const core = new SafetyRuntime()
  core.attachStore({ load: () => undefined, save: async () => {}, clear: async () => {} })
  core.setReleaseAuthorizer(() => true)
  await core.arm({ sessionKey: session.id, generation: 1, mode: 'activating', stage: 'closing-admission' }, { attemptId: 'attempt' })
  const writer = new DurableActivationIntent(ctx, projection)
  await writer.persist({ sessionKey: session.id, generation: 1, source: 'command', requestedAt: 1 })
  const released = () => {
    const snapshot = core.snapshot(session.id)
    return snapshot.record?.mode === 'normal' && snapshot.record.generation === 1 && snapshot.recoveryReason === undefined
  }
  const release = () => core.release(session.id, 1)
  await expect(writer.release(session.id, 1, release, released)).rejects.toThrow('metadata checkpoint uncertain')
  expect(released()).toBe(true)
  await writer.release(session.id, 1, release, released)
  expect(projection.stateOf(session)).toMatchObject({ invalid: false, release: { generation: 1 } })
  await projection.dispose()
})
