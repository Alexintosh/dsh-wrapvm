/**
 * Binding projection and shared telemetry sampler tests: durable-event fold,
 * active-user conflicts, replay restore, subscriber sharing, staleness, and
 * disposal.
 */
import { describe, expect, it } from 'vitest'
import { BindingRegistry, MemoryBindingEventSink, type BindingEvent, type BindingEventSink } from '../src/binding.ts'
import { ResourceSampler, type StatsMeasurement, type StatsSource } from '../src/telemetry.ts'
import { env1, env2 } from './fixtures/env-fixtures.ts'

describe('binding registry', () => {
  it('projects a bind into a binding with history', async () => {
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    bindings.markComplete()
    await bindings.bind('session-a', env1, 3)
    const binding = bindings.binding('session-a')!
    expect(binding.environmentId).toBe(env1)
    expect(binding.generation).toBe(3)
    expect(binding.history).toEqual([env1])
  })

  it('appends history on rebinding and drops the old active user', async () => {
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    bindings.markComplete()
    await bindings.bind('session-a', env1, 1)
    await bindings.bind('session-a', env2, 2)
    expect(bindings.binding('session-a')?.history).toEqual([env1, env2])
    expect(bindings.usersOf(env1)).toEqual([])
    expect(bindings.usersOf(env2)).toEqual(['session-a'])
  })

  it('refuses a second conversation without explicit sharing', async () => {
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    bindings.markComplete()
    await bindings.bind('session-a', env1, 1)
    await expect(bindings.bind('session-b', env1, 1)).rejects.toThrow(/already used by session-a/)
    expect(bindings.binding('session-b')).toBeUndefined()
    await bindings.bind('session-b', env1, 1, { allowShared: true })
    expect(bindings.usersOf(env1).sort()).toEqual(['session-a', 'session-b'])
  })

  it('is idempotent for a repeated bind under the same generation', async () => {
    const sink = new MemoryBindingEventSink()
    const bindings = new BindingRegistry(sink)
    bindings.markComplete()
    await bindings.bind('session-a', env1, 1)
    await bindings.bind('session-a', env1, 1)
    expect(sink.events).toHaveLength(1)
  })

  it('leaves the projection unchanged when durable emission fails', async () => {
    const failing: BindingEventSink = { emit: () => Promise.reject(new Error('session log unavailable')) }
    const bindings = new BindingRegistry(failing)
    bindings.markComplete()
    await expect(bindings.bind('session-a', env1, 1)).rejects.toThrow(/session log unavailable/)
    expect(bindings.binding('session-a')).toBeUndefined()
  })

  it('unbinds and replays durable events on restore', () => {
    const events: BindingEvent[] = [
      { type: 'wrapvm/environment-bound', sessionKey: 'session-a', environmentId: env1, generation: 1, timestamp: 1 },
      { type: 'wrapvm/environment-bound', sessionKey: 'session-b', environmentId: env1, generation: 1, timestamp: 2, shared: true },
      { type: 'wrapvm/environment-unbound', sessionKey: 'session-b', environmentId: env1, timestamp: 3 },
    ]
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    bindings.restore(events)
    bindings.markComplete()
    expect(bindings.binding('session-a')?.environmentId).toBe(env1)
    expect(bindings.binding('session-b')).toBeUndefined()
    expect(bindings.usersOf(env1)).toEqual(['session-a'])
  })

  it('fails closed when replayed events would silently add a second user', () => {
    // A durable log where a SECOND conversation joins the same environment
    // without the explicit shared marker is contradictory (it could only come
    // from a pre-fix race or corruption): restore must refuse, never silently
    // grow the active-user set.
    const events: BindingEvent[] = [
      { type: 'wrapvm/environment-bound', sessionKey: 'session-a', environmentId: env1, generation: 1, timestamp: 1 },
      { type: 'wrapvm/environment-bound', sessionKey: 'session-b', environmentId: env1, generation: 1, timestamp: 2 },
    ]
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    expect(() => bindings.restore(events)).toThrow(/conflicting binding events/)
    expect(() => bindings.usersOf(env1)).toThrow(/incomplete/)
  })

  it('replays duplicate events idempotently', () => {
    const events: BindingEvent[] = [
      { type: 'wrapvm/environment-bound', sessionKey: 'session-a', environmentId: env1, generation: 1, timestamp: 1 },
      { type: 'wrapvm/environment-bound', sessionKey: 'session-a', environmentId: env1, generation: 1, timestamp: 1 },
    ]
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    bindings.restore(events)
    bindings.markComplete()
    expect(bindings.usersOf(env1)).toEqual(['session-a'])
    expect(bindings.binding('session-a')?.history).toEqual([env1])
  })

  it('unbind reports absence', async () => {
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    bindings.markComplete()
    expect(await bindings.unbind('nobody')).toBe(false)
  })
})

/** Controllable sampler harness: manual cadence ticks and scripted measurements. */
function makeSampler(measure: (ids: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, StatsMeasurement>>, overrides: { now?: () => number; stalenessMs?: number } = {}) {
  let tick: (() => void) | undefined
  let clock = 1000
  const calls: readonly string[][] = []
  const source: StatsSource = {
    async measure(ids, signal) {
      calls.push([...ids])
      return await measure(ids, signal)
    },
  }
  const sampler = new ResourceSampler(source, {
    cadenceMs: 50,
    stalenessMs: overrides.stalenessMs ?? 200,
    now: overrides.now ?? (() => clock),
    delay: ms => new Promise<void>((resolve, reject) => {
      tick = () => {
        clock += ms
        resolve()
      }
      // Abort wiring is exercised through dispose in the tests below.
    }),
  })
  return { sampler, calls, advance: () => { tick?.(); tick = undefined }, setClock: (value: number) => { clock = value } }
}

const measurement = (overrides: Partial<StatsMeasurement> = {}): StatsMeasurement => ({
  memoryUsedBytes: 2 ** 30,
  memoryLimitBytes: 4 * 2 ** 30,
  cpuPercent: 12.5,
  writableLayerBytes: 20 * 2 ** 20,
  volumeUsedBytes: null,
  ...overrides,
})

describe('resource sampler', () => {
  it('does not poll while nobody subscribes', async () => {
    const { sampler, calls } = makeSampler(async () => new Map())
    expect(calls).toHaveLength(0)
    sampler.dispose()
  })

  it('shares one batch across subscribers of different environments', async () => {
    const measurements = new Map<string, StatsMeasurement>([[env1, measurement()], [env2, measurement()]])
    const { sampler, calls, advance } = makeSampler(async () => measurements)
    const seen1: number[] = []
    const seen2: number[] = []
    const off1 = sampler.subscribe(env1, sample => seen1.push(sample.cpuPercent ?? -1))
    await sampler.drained()
    const off2 = sampler.subscribe(env2, sample => seen2.push(sample.cpuPercent ?? -1))
    advance()
    while (sampler.polls < 2) await Promise.resolve()
    await sampler.drained()
    expect(calls).toEqual([[env1], [env1, env2]])
    expect(seen1).toEqual([12.5, 12.5])
    expect(seen2).toEqual([12.5])
    off1()
    off2()
    sampler.dispose()
  })

  it('stops polling when the last subscriber leaves', async () => {
    const { sampler, calls } = makeSampler(async () => new Map())
    const off = sampler.subscribe(env1, () => {})
    await sampler.drained()
    expect(sampler.subscriberCount).toBe(1)
    off()
    expect(sampler.subscriberCount).toBe(0)
    // A second poll would require the cadence to fire; after unsubscribe the
    // loop aborts, so no further measurement happens.
    expect(calls).toHaveLength(1)
    sampler.dispose()
  })

  it('produces nulls, never zeros, when the source fails', async () => {
    const { sampler } = makeSampler(async () => {
      throw new Error('engine busy')
    })
    const samples: (number | null)[] = []
    const off = sampler.subscribe(env1, sample => samples.push(sample.memoryUsedBytes))
    await sampler.drained()
    expect(samples).toEqual([null])
    const latest = sampler.latest(env1)!
    expect(latest.memoryUsedBytes).toBeNull()
    expect(latest.stale).toBe(true)
    expect(latest.takenAt).toBe(1000)
    off()
    sampler.dispose()
  })

  it('keeps one batch bounded: a slow source is not re-entered concurrently', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const { sampler } = makeSampler(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return new Map()
    })
    const off = sampler.subscribe(env1, () => {})
    await sampler.drained()
    expect(maxInFlight).toBe(1)
    off()
    sampler.dispose()
  })

  it('flags stale cached samples for late subscribers', async () => {
    const measurements = new Map<string, StatsMeasurement>([[env1, measurement()]])
    const { sampler, advance, setClock } = makeSampler(async () => measurements)
    const off = sampler.subscribe(env1, () => {})
    await sampler.drained()
    // Move well past the staleness bound, then subscribe a second view.
    setClock(5000)
    const late: { stale?: boolean }[] = []
    const off2 = sampler.subscribe(env1, sample => late.push(sample))
    expect(late[0]?.stale).toBe(true)
    expect(sampler.latest(env1)?.stale).toBe(true)
    advance()
    off()
    off2()
    sampler.dispose()
  })

  it('refuses use after disposal', () => {
    const { sampler } = makeSampler(async () => new Map())
    sampler.dispose()
    expect(() => sampler.subscribe(env1, () => {})).toThrow(/disposed/)
  })

  it('validates its options', () => {
    const source: StatsSource = { measure: async () => new Map() }
    expect(() => new ResourceSampler(source, { cadenceMs: 0, stalenessMs: 100 })).toThrow(/cadence/)
    expect(() => new ResourceSampler(source, { cadenceMs: 100, stalenessMs: 50 })).toThrow(/staleness/)
  })
})
describe('binding completeness', () => {
  it('refuses absence claims and binds until every Session has been restored', async () => {
    const bindings = new BindingRegistry(new MemoryBindingEventSink())
    expect(() => bindings.usersOf(env1)).toThrow(/incomplete/)
    await expect(bindings.bind('new', env1, 1)).rejects.toThrow(/incomplete/)
    bindings.restore([{ type: 'wrapvm/environment-bound', sessionKey: 'unloaded', environmentId: env1, generation: 1, timestamp: 1 }])
    bindings.markComplete()
    await expect(bindings.bind('new', env1, 1)).rejects.toThrow(/already used/)
    bindings.invalidateCompleteness()
    expect(() => bindings.binding('unloaded')).toThrow(/incomplete/)
  })
})

describe('binding completeness invalidation', () => {
  it('drains an admitted durable event before resetting and replaying', async () => {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const hold = new Promise<void>(resolve => { finish = resolve })
    const sink: BindingEventSink = { emit: async () => { started(); await hold } }
    const bindings = new BindingRegistry(sink)
    bindings.markComplete()
    const pending = bindings.bind('old', env1, 1)
    await entered
    bindings.invalidateCompleteness()
    expect(() => bindings.resetForRestore()).toThrow(/drain/)
    finish()
    await pending
    await bindings.drained()
    bindings.resetForRestore()
    bindings.restore([{ type: 'wrapvm/environment-bound', sessionKey: 'restored', environmentId: env2, generation: 1, timestamp: 1 }])
    bindings.markComplete()
    expect(bindings.binding('old')).toBeUndefined()
    expect(bindings.usersOf(env2)).toEqual(['restored'])
  })
})
