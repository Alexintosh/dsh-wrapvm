import { expect, it } from 'vitest'
import { VmActivationController } from '../src/activation.ts'
import type { ActivationAttemptFence, ActivationIntent, ActivationPorts } from '../src/activation.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type Stage = 'arm' | 'intent' | 'quiescence' | 'bind' | 'verify' | 'commit'

function setup(stage: Stage) {
  const entered = deferred<void>()
  const release = deferred<void>()
  const intents: ActivationIntent[] = []
  const fences: ActivationAttemptFence[] = []
  const applied: string[] = []
  let block = true
  const gate = async (name: Stage, session: string): Promise<void> => {
    if (block && name === stage && session === 's1') {
      entered.resolve()
      await release.promise
    }
  }
  const ports: ActivationPorts = {
    arm: async (record, fence) => { fences.push(fence); await gate('arm', record.sessionKey) },
    persistIntent: async intent => { intents.push(intent); await gate('intent', intent.sessionKey) },
    awaitQuiescence: async session => gate('quiescence', session),
    bindEnvironment: async session => { await gate('bind', session); return `env-${session}` },
    verifyEnvironment: async environment => gate('verify', environment.slice(4)),
    commit: async (session, _generation, _environment, fence) => {
      await gate('commit', session)
      if (!fence.signal.aborted) applied.push(session)
    },
    quiescenceTimeoutMs: 5000,
    now: () => 123,
  }
  return { controller: new VmActivationController(ports), entered, release, fences, intents, applied, unblockNew: () => { block = false } }
}

for (const stage of ['arm', 'intent', 'quiescence', 'bind', 'verify', 'commit'] as const) {
  it(`cancels an attempt hung at ${stage}, fences late completion and recovers with a fresh fence`, async () => {
    const h = setup(stage)
    const first = h.controller.request('s1', 'command')
    const other = h.controller.request('s2', 'button')
    await h.entered.promise
    expect(h.controller.cancelAttempt(first, 'invocation cancelled')).toBe(true)
    const result = await first.done
    expect(result).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
    expect(h.fences[0]!.signal.aborted).toBe(true)
    expect(h.controller.mode('s1')).toBe('protected-unavailable')
    expect(await other.done).toMatchObject({ mode: 'protected' })
    h.unblockNew()
    const second = h.controller.recover('s1', 'command')
    expect(second).not.toBe(first)
    expect(second.generation).toBe(first.generation)
    expect(h.fences.at(-1)!.attemptId).not.toBe(h.fences[0]!.attemptId)
    expect(h.fences.at(-1)!.signal.aborted).toBe(false)
    expect(h.controller.cancelAttempt(first, 'stale abort')).toBe(false)
    expect(h.controller.request('s1', 'button')).toBe(second)
    expect(await second.done).toMatchObject({ mode: 'protected' })
    h.release.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.controller.mode('s1')).toBe('protected')
    expect(h.applied.filter(session => session === 's1')).toEqual(['s1'])
    const s1Intents = h.intents.filter(intent => intent.sessionKey === 's1')
    if (stage === 'intent' || stage === 'arm') expect(s1Intents).toEqual([s1Intents[0], s1Intents[0]])
    else expect(s1Intents).toHaveLength(1)
    h.controller.dispose()
  })
}

it('cancels only the shared matching attempt, and dispose cancels the rest', async () => {
  const h = setup('bind')
  const first = h.controller.request('s1', 'command')
  expect(h.controller.request('s1', 'button')).toBe(first)
  await h.entered.promise
  expect(h.controller.cancelAttempt({ ...first })).toBe(false)
  expect(h.controller.cancelAttempt(first)).toBe(true)
  expect(h.controller.cancelAttempt(first)).toBe(false)
  expect(await first.done).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
  h.controller.dispose()
  h.release.resolve()
})

it('dispose cancels all concurrent sessions while their binds remain pending', async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  let bindCount = 0
  const ports: ActivationPorts = {
    arm: async () => {}, persistIntent: async () => {}, awaitQuiescence: async () => {},
    bindEnvironment: async session => {
      bindCount += 1
      if (bindCount === 2) entered.resolve()
      await release.promise
      return session
    },
    verifyEnvironment: async () => {}, commit: async () => { throw new Error('must not commit') },
    quiescenceTimeoutMs: 5000, now: () => 0,
  }
  const controller = new VmActivationController(ports)
  const a = controller.request('a', 'command')
  const b = controller.request('b', 'command')
  await entered.promise
  controller.dispose()
  expect(await Promise.all([a.done, b.done])).toEqual([
    expect.objectContaining({ stage: 'blocked' }), expect.objectContaining({ stage: 'blocked' }),
  ])
  release.resolve()
})

it('a delayed commit from the cancelled attempt is rejected by the real core latch after recovery', async () => {
  const { SafetyRuntime } = await import('../../../core/tools/src/safety-latch.ts')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const runtime = new SafetyRuntime(() => {})
  const writes: string[] = []
  runtime.attachStore({
    load: () => undefined,
    save: async record => { writes.push(`${record.mode}:${record.environmentId ?? ''}`) },
    clear: async () => {},
  })
  const entered = deferred<void>()
  const gate = deferred<void>()
  const ids = new Map<symbol, string>()
  let count = 0
  const coreFence = (fence: ActivationAttemptFence) => {
    let id = ids.get(fence.attemptId)
    if (id === undefined) { id = `attempt-${++count}`; ids.set(fence.attemptId, id) }
    return { attemptId: id, signal: fence.signal }
  }
  let commits = 0
  const ports: ActivationPorts = {
    arm: (record, fence) => runtime.arm({ ...record, sessionKey: SessionId(record.sessionKey) }, coreFence(fence)),
    persistIntent: async () => {}, awaitQuiescence: async () => {},
    bindEnvironment: async () => 'guest', verifyEnvironment: async () => {},
    commit: async (session, generation, environmentId, fence) => {
      commits += 1
      if (commits === 1) { entered.resolve(); await gate.promise }
      await runtime.commit({ sessionKey: SessionId(session), generation, mode: 'protected', stage: 'idle', environmentId }, coreFence(fence))
    },
    quiescenceTimeoutMs: 5000, now: () => 0,
  }
  const controller = new VmActivationController(ports)
  const old = controller.request('core-session', 'command')
  await entered.promise
  expect(controller.cancelAttempt(old)).toBe(true)
  expect(await old.done).toMatchObject({ stage: 'blocked' })
  expect(runtime.mode(SessionId('core-session'))).toBe('activating')
  const fresh = controller.recover('core-session', 'button')
  expect(await fresh.done).toMatchObject({ mode: 'protected' })
  gate.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(writes.filter(write => write === 'protected:guest')).toHaveLength(1)
  expect(runtime.mode(SessionId('core-session'))).toBe('protected')
  controller.dispose()
})
