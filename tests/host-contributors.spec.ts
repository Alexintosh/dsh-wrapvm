import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { QuiescenceContributor } from '@deepseek-ai/dsh-tools'
import { SafetyRuntime } from '../../../core/tools/src/safety-latch.ts'
import { HOST_CONTRIBUTOR_IDS, HostContributorMountError, mountHostContributors, type HostAdmissionOwner, type HostAdmissionOwners } from '../src/host-contributors.ts'

function owner() {
  let closed = false
  let active = 0
  const waiters = new Set<() => void>()
  const contributor: QuiescenceContributor = {
    inFlight: () => active,
    pendingNames: () => active ? ['work'] : [],
    waitIdle: async (signal) => {
      if (!active) return
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener('abort', aborted); resolve() }
        const aborted = () => { waiters.delete(done); reject(signal.reason) }
        if (signal.aborted) { aborted(); return }
        waiters.add(done)
        signal.addEventListener('abort', aborted, { once: true })
      })
    },
  }
  const gate: HostAdmissionOwner = {
    closeAdmission: () => {
      closed = true
      return { contributor, dispose: () => { closed = false } }
    },
  }
  return {
    gate,
    start: () => {
      if (closed) throw new Error('closed')
      active++
      return () => { active--; if (!active) { for (const done of waiters) done(); waiters.clear() } }
    },
  }
}

it('closes all gates synchronously and the real latch waits for admitted work', async () => {
  const latch = new SafetyRuntime()
  const session = SessionId('session-one')
  const jobs = owner(), schedule = owner(), subagents = owner(), subprocess = owner()
  const finishJob = jobs.start(), finishProcess = subprocess.start()
  const dispose = mountHostContributors(latch, session, { jobs: jobs.gate, schedule: schedule.gate, subagents: subagents.gate, subprocess: subprocess.gate })
  for (const item of [jobs, schedule, subagents, subprocess]) expect(item.start).toThrow('closed')
  let settled = false
  const waiting = latch.awaitQuiescence(session, new AbortController().signal, 1000, HOST_CONTRIBUTOR_IDS).then(() => { settled = true })
  finishJob()
  await Promise.resolve()
  expect(settled).toBe(false)
  finishProcess()
  await waiting
  expect(settled).toBe(true)
  dispose()
  dispose()
  const finish = jobs.start()
  finish()
  await expect(latch.awaitQuiescence(session, new AbortController().signal, 1000, HOST_CONTRIBUTOR_IDS)).rejects.toThrow('no quiescence contributor')
})

it('retains closed gates on partial failure and missing contributors fail closed', async () => {
  const latch = new SafetyRuntime()
  const session = SessionId('session-two')
  const jobs = owner(), schedule = owner(), subagents = owner(), subprocess = owner()
  const owners: HostAdmissionOwners = { jobs: jobs.gate, schedule: { closeAdmission: () => { throw new Error('unavailable') } }, subagents: subagents.gate, subprocess: subprocess.gate }
  let failure: HostContributorMountError | undefined
  try { mountHostContributors(latch, session, owners) } catch (error) {
    if (!(error instanceof HostContributorMountError)) throw error
    failure = error
  }
  expect(failure?.cause).toEqual(new Error('unavailable'))
  expect(jobs.start).toThrow('closed')
  await expect(latch.awaitQuiescence(session, new AbortController().signal, 1000, HOST_CONTRIBUTOR_IDS)).rejects.toThrow('schedule')
  failure?.dispose()
  const finish = jobs.start()
  finish()
})

it('rejects if a required contributor is withdrawn while work drains', async () => {
  const latch = new SafetyRuntime()
  const session = SessionId('session-three')
  const jobs = owner(), schedule = owner(), subagents = owner(), subprocess = owner()
  const finish = jobs.start()
  const dispose = mountHostContributors(latch, session, { jobs: jobs.gate, schedule: schedule.gate, subagents: subagents.gate, subprocess: subprocess.gate })
  const waiting = latch.awaitQuiescence(session, new AbortController().signal, 1000, HOST_CONTRIBUTOR_IDS)
  dispose()
  await expect(waiting).rejects.toThrow('withdrawn or replaced')
  finish()
})
