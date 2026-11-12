import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

it('blocks unattributed and same-owner processes until the managed range exits', async () => {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const runtime = ctx.subprocess
  const owner = runtime.createSafetyOwner()
  const other = runtime.createSafetyOwner()
  const control = runtime.createSafetyControl()
  const base: SubprocessSpawnSpec = { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 100 }
  const unknown = runtime.spawn(base)
  const owned = runtime.spawn({ ...base, safetyOwner: owner })
  const lease = runtime.closeSafetyAdmission(owner)
  expect(lease.contributor.inFlight()).toBe(2)
  expect(() => runtime.spawn(base)).toThrow('admission closed')
  expect(() => runtime.spawn({ ...base, safetyOwner: owner })).toThrow('admission closed')
  const otherWork = runtime.spawn({ ...base, safetyOwner: other })
  const controlWork = runtime.spawn({ ...base, safetyOwner: control })
  expect(lease.contributor.inFlight()).toBe(2)
  const waiting = lease.contributor.waitIdle(AbortSignal.timeout(5000))
  owned.terminate()
  unknown.terminate()
  await waiting
  expect(lease.contributor.inFlight()).toBe(0)
  lease.dispose()
  otherWork.terminate()
  controlWork.terminate()
  await Promise.all([otherWork.waitForExit(), controlWork.waitForExit()])
  await ctx.fiber.dispose()
})
