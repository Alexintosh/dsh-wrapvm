import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SafetyPolicyRecord } from '@deepseek-ai/dsh-tools'
import { SafetyRuntime } from '../../../core/tools/src/safety-latch.ts'
import { CoreFenceBridge } from '../src/core-fence.ts'

it('fences commits to the real latch attempt, session and generation', async () => {
  const core = new SafetyRuntime()
  const saved: SafetyPolicyRecord[] = []
  core.attachStore({ load: () => undefined, save: async record => { saved.push(record) }, clear: async () => {} })
  const bridge = new CoreFenceBridge(core)
  const abort = new AbortController()
  const old = { attemptId: Symbol('first'), signal: abort.signal }
  const next = { attemptId: Symbol('recovery'), signal: new AbortController().signal }
  const record = { sessionKey: 'one', generation: 1, mode: 'activating' as const, stage: 'closing-admission' as const }
  await bridge.arm(record, old)
  await bridge.arm(record, next)
  await expect(bridge.commit('one', 1, 'env-one', old)).rejects.toThrow('does not own the live attempt')
  expect(() => bridge.commit('other', 1, 'env-one', next)).toThrow('does not match')
  expect(() => bridge.commit('one', 2, 'env-one', next)).toThrow('does not match')
  await bridge.commit('one', 1, 'env-one', next)
  expect(core.mode(SessionId('one'))).toBe('protected')
  expect(saved.at(-1)).toMatchObject({ sessionKey: 'one', generation: 1, environmentId: 'env-one', mode: 'protected' })
  bridge.dispose()
})

it('passes the controller attempt through arm and commit on the real latch', async () => {
  const { VmActivationController } = await import('../src/activation.ts')
  const core = new SafetyRuntime()
  const saved: SafetyPolicyRecord[] = []
  core.attachStore({ load: () => undefined, save: async record => { saved.push(record) }, clear: async () => {} })
  const bridge = new CoreFenceBridge(core)
  const controller = new VmActivationController({
    arm: (record, fence) => bridge.arm(record, fence),
    commit: (sessionKey, generation, environmentId, fence) => bridge.commit(sessionKey, generation, environmentId, fence),
    persistIntent: async () => {},
    awaitQuiescence: async () => {},
    bindEnvironment: async () => 'env-one',
    verifyEnvironment: async () => {},
    quiescenceTimeoutMs: 1000,
    now: () => 1,
  })
  const result = await controller.request('one', 'button').done
  expect(result.mode).toBe('protected')
  expect(core.mode(SessionId('one'))).toBe('protected')
  expect(saved.map(record => record.mode)).toEqual(['activating', 'protected'])
  controller.dispose()
  bridge.dispose()
})
