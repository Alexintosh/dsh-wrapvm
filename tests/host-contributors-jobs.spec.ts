import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SafetyRuntime } from '../../../core/tools/src/safety-latch.ts'

it('fences reentrant starter and waits for its real settlement', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('test')
  const session = SessionId('safety-jobs')
  const latch = new SafetyRuntime()
  const done = Promise.withResolvers<{ status: 'completed' }>()
  let lease: ReturnType<typeof ctx.jobs.closeSafetyAdmission> | undefined
  let wait: Promise<void> | undefined
  ctx.jobs.start({ kind: 'bash', label: 'starting', run: () => {
    lease = ctx.jobs.closeSafetyAdmission(session)
    latch.registerQuiescenceContributor(session, 'jobs', lease.contributor)
    wait = latch.awaitQuiescence(session, new AbortController().signal, 1000, ['jobs'])
    expect(lease.contributor.inFlight()).toBe(1)
    expect(() => ctx.jobs.start({ kind: 'bash', label: 'blocked', run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }) })).toThrow('admission closed')
    return { cancel() {}, done: done.promise }
  } })
  expect(lease?.contributor.inFlight()).toBe(1)
  let settled = false
  void wait?.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  done.resolve({ status: 'completed' })
  await wait
  expect(settled).toBe(true)
  lease?.dispose()
  await ctx.fiber.dispose()
})
