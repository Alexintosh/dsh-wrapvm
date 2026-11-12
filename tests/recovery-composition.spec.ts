/**
 * Composition tests: the REAL VmActivationController drives ports backed by a
 * simulated durable sink, and the durable records that sink writes are folded
 * by the REAL projectWrapvmPolicy. Controller state and durable replay must
 * agree after every recovery path — separate mocks that disagree with the
 * fold prove nothing.
 *
 * The sink models the adapter contract the controller relies on (see the JSDoc
 * on ActivationPorts):
 * - `arm` and `persistIntent` are idempotent per (sessionKey, generation):
 *   that pair is the stable request identity — one activation request per
 *   generation. A retry of an already-durable record resolves without a second
 *   append (a duplicate `activation-requested` at one generation is corrupt to
 *   the fold).
 * - `ambiguous` durability means the durable write LANDED but the barrier
 *   rejected: the controller cannot distinguish it from a failed write, must
 *   treat the barrier as not durable, and must re-attempt it on recovery.
 * - `arm` carries the attempt fence and registers `fence.attemptId` as the
 *   session's live attempt (core Safety API rev.2 `SafetyTransitionFence`).
 *   The SAME fence instance must flow from arm through commit; a commit whose
 *   attempt identity is not the live attempt is fenced out. The attempt
 *   identity is NOT the durable request identity: recovery retries carry a
 *   FRESH attempt identity while the durable request identity stays
 *   (sessionKey, generation).
 * - `commit` carries the core-side attempt fence: a commit whose attempt was
 *   cancelled or whose session was released at that generation is discarded.
 *
 * The fold authenticates durable ORDERING only. The authoritative user-identity
 * check for release lives in the core latch (Ownership A, `ReleaseAuthorizer`);
 * this plugin fold mirrors it and is not a second release authority.
 */
import { describe, expect, it } from 'vitest'
import { VmActivationController, type ActivationAttemptFence, type ActivationIntent, type ActivationPorts } from '../src/activation.ts'
import { degradeToUnavailable, projectWrapvmPolicy, type WrapvmSessionEvent } from '../src/projection.ts'
import type { PolicyRecord } from '../src/policy.ts'

/** Outcome of one durable barrier invocation at the sink. */
type BarrierOutcome = 'succeed' | 'reject' | 'ambiguous'

interface SinkOptions {
  /** Per-port outcome queues; each call consumes the next entry, defaulting to `succeed`. */
  arm?: BarrierOutcome[]
  persistIntent?: BarrierOutcome[]
  commit?: BarrierOutcome[]
  quiescence?: BarrierOutcome[]
  /** Hold the commit barrier pending until succeedCommit()/release() settles it. */
  gateCommit?: boolean
}

/** Drain microtasks and timers so pending port stages are reached. */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

class DurableSink {
  /** The durable Session-event log, in append order — exactly what the fold consumes. */
  readonly events: WrapvmSessionEvent[] = []
  /** The durable core-latch store: whole-value `activating` records keyed by generation. */
  readonly latch = new Map<number, PolicyRecord>()
  /** Every intent payload the controller passed to persistIntent, in call order. */
  readonly intents: ActivationIntent[] = []
  /** Every fence the controller passed to arm / commit, in call order. */
  readonly armFences: ActivationAttemptFence[] = []
  readonly commitFences: ActivationAttemptFence[] = []
  readonly calls = { arm: 0, persistIntent: 0, commit: 0, bind: 0, verify: 0 }
  /** Generation the core-authenticated release was applied at (0 = none). */
  releasedAt = 0
  controller: VmActivationController

  /** The core latch's live attempt identity: only `arm` installs it. */
  private liveAttempt: symbol | undefined
  private pendingCommit: { succeed: () => void; discard: () => void } | undefined
  private clock = 0

  constructor(private readonly options: SinkOptions = {}) {
    this.controller = this.freshController()
  }

  /** A brand-new controller over the SAME durable store (models a process restart). */
  freshController(): VmActivationController {
    return new VmActivationController(this.ports())
  }

  /** Adapter mirror of a core-authenticated release: durable event + fence for late commits. */
  release(generation: number): void {
    this.releasedAt = generation
    this.events.push({ type: 'wrapvm/policy-released', generation })
    this.pendingCommit?.discard()
  }

  succeedCommit(): void {
    this.pendingCommit?.succeed()
  }

  requestedEvents(): WrapvmSessionEvent[] {
    return this.events.filter(event => event.type === 'wrapvm/activation-requested')
  }

  private outcome(port: 'arm' | 'persistIntent' | 'commit' | 'quiescence'): BarrierOutcome {
    const queue = this.options[port]
    return queue !== undefined && queue.length > 0 ? queue.shift() as BarrierOutcome : 'succeed'
  }

  /** Apply one barrier outcome: the write lands on succeed/ambiguous; only succeed resolves. */
  private barrier(outcome: BarrierOutcome, write: () => void, message: string): Promise<void> {
    if (outcome === 'reject') return Promise.reject(new Error(message))
    write()
    if (outcome === 'ambiguous') return Promise.reject(new Error(`${message} (write landed but durability was not acknowledged)`))
    return Promise.resolve()
  }

  private ports(): ActivationPorts {
    return {
      arm: (record, fence) => {
        this.calls.arm++
        this.armFences.push(fence)
        // Core rev.2: arm registers the live attempt identity synchronously;
        // release/restore/restart clear it and only a fresh arm reinstalls it.
        this.liveAttempt = fence.attemptId
        // Idempotent per generation: re-installing the same activating record
        // against the durable latch store is a no-op on the durable side.
        if (this.latch.has(record.generation)) return Promise.resolve()
        return this.barrier(this.outcome('arm'), () => {
          this.latch.set(record.generation, { ...record })
        }, 'arm barrier failed')
      },
      persistIntent: intent => {
        this.calls.persistIntent++
        this.intents.push({ ...intent })
        // Adapter dedup keyed by the stable request identity (sessionKey,
        // generation): an already-durable intent resolves without a second
        // append, so an ambiguous or retried write never duplicates the event.
        if (this.requestedEvents().some(event => event.generation === intent.generation)) return Promise.resolve()
        return this.barrier(this.outcome('persistIntent'), () => {
          this.events.push({
            type: 'wrapvm/activation-requested',
            generation: intent.generation,
            source: intent.source as 'command' | 'button',
            requestedAt: intent.requestedAt,
          })
        }, 'intent barrier failed')
      },
      commit: (_sessionKey, generation, environmentId, fence: ActivationAttemptFence) => {
        this.calls.commit++
        this.commitFences.push(fence)
        // Core CAS: the commit fence must be the attempt identity the latest
        // arm installed — the SAME fence flows arm -> commit for one attempt.
        if (this.liveAttempt !== fence.attemptId) {
          return Promise.reject(new Error('commit fenced: the attempt identity is not the live attempt'))
        }
        // Core-side effect fence: cancelled attempts and generations voided by
        // an authenticated release are discarded, never appended.
        if (fence.signal.aborted || generation <= this.releasedAt) {
          return Promise.reject(new Error('commit discarded: the attempt is no longer current'))
        }
        if (this.events.some(event => event.type === 'wrapvm/policy-committed' && event.generation === generation)) {
          return Promise.reject(new Error('commit rejected: a commit already exists at this generation'))
        }
        const write = (): void => {
          this.events.push({ type: 'wrapvm/policy-committed', generation, environmentId })
        }
        const outcome = this.outcome('commit')
        if (this.options.gateCommit === true) {
          return new Promise<void>((resolve, reject) => {
            this.pendingCommit = {
              succeed: () => { this.barrier(outcome, write, 'commit barrier failed').then(resolve, reject) },
              discard: () => reject(new Error('commit discarded: the attempt is no longer current')),
            }
          })
        }
        return this.barrier(outcome, write, 'commit barrier failed')
      },
      bindEnvironment: () => {
        this.calls.bind++
        return Promise.resolve(`env-${this.calls.bind}`)
      },
      verifyEnvironment: () => {
        this.calls.verify++
        return Promise.resolve()
      },
      awaitQuiescence: () => this.barrier(this.outcome('quiescence'), () => {}, 'existing host work did not conclude verifiably'),
      quiescenceTimeoutMs: 5_000,
      now: () => (this.clock += 1),
    }
  }
}

describe('activation recovery composed with the durable fold', () => {
  // Regression (Sol review P1 #1): recovery after a quiescence timeout reused
  // the generation with a fabricated arm success AND re-persisted the intent,
  // so the durable replay became [requested@1, requested@1, committed@1] and
  // the fold failed closed to protected-unavailable while the controller said
  // protected. A proven-durable barrier must not be re-emitted.
  it('recovers a quiescence-timeout block without duplicating the durable intent; controller and replay agree', async () => {
    const s = new DurableSink({ quiescence: ['reject', 'succeed'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
    expect(s.controller.mode('s1')).toBe('protected-unavailable')

    const recovered = s.controller.recover('s1', 'button')
    expect((await recovered.done).mode).toBe('protected')
    expect(s.controller.mode('s1')).toBe('protected')
    // Recovery is a NEW attempt: it re-arms to install a fresh attempt
    // identity (core rev.2 fences commit against the live attempt), but the
    // durable request identity is unchanged — no second intent append.
    expect(s.calls.arm).toBe(2)
    expect(s.armFences[1]!.attemptId).not.toBe(s.armFences[0]!.attemptId)
    expect(s.commitFences[0]).toBe(s.armFences[1]) // the SAME fence flows arm -> commit
    expect(s.calls.persistIntent).toBe(1) // the proven-durable barrier is not re-emitted
    expect(s.requestedEvents()).toHaveLength(1)
    expect(s.events).toEqual([
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: expect.any(Number) },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
    ])
    // The real fold over the real sink log must agree with the controller.
    expect(projectWrapvmPolicy('s1', s.events).record).toEqual({
      sessionKey: 's1', mode: 'protected', generation: 1, stage: 'idle', environmentId: 'env-1',
    })
  })

  // Regression (Sol review P1 #1): when the INITIAL arm barrier rejected,
  // recovery passed Promise.resolve() as the arm barrier, so the failed
  // durable barrier was never retried (armCalls stayed 1) while the proven
  // intent was re-persisted (intentCalls grew to 2). Recovery must re-attempt
  // every failed/unknown durable barrier and skip only proven-durable ones.
  it('re-attempts a failed arm barrier on recovery and never re-persists a proven intent', async () => {
    const s = new DurableSink({ arm: ['reject', 'succeed'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /not durable/ })
    expect(s.calls.arm).toBe(1)
    expect(s.calls.bind).toBe(0)
    expect(s.calls.commit).toBe(0)

    const recovered = s.controller.recover('s1', 'button')
    expect((await recovered.done).mode).toBe('protected')
    expect(s.calls.arm).toBe(2) // the failed durable barrier IS re-attempted
    expect(s.armFences[1]!.attemptId).not.toBe(s.armFences[0]!.attemptId) // fresh attempt identity
    expect(s.commitFences[0]).toBe(s.armFences[1]) // the SAME fence flows arm -> commit
    expect(s.calls.persistIntent).toBe(1) // the proven barrier is not duplicated
    expect(s.calls.commit).toBe(1)
    expect(s.requestedEvents()).toHaveLength(1)
    expect(projectWrapvmPolicy('s1', s.events).record).toMatchObject({ mode: 'protected', generation: 1 })
  })

  it('retries a failed intent barrier with the identical request identity', async () => {
    const s = new DurableSink({ persistIntent: ['reject', 'succeed'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /not durable/ })
    expect(s.calls.arm).toBe(1)

    const recovered = s.controller.recover('s1', 'button')
    expect((await recovered.done).mode).toBe('protected')
    expect(s.calls.persistIntent).toBe(2) // the failed barrier IS re-attempted
    expect(s.calls.arm).toBe(2) // re-armed for the fresh attempt identity, durably idempotent
    expect(s.latch.size).toBe(1)
    // Stable request identity: the retry carries the same (sessionKey,
    // generation) AND the identical original payload, so the durable append is
    // idempotent even though the controller's clock has advanced.
    expect(s.intents).toHaveLength(2)
    expect(s.intents[1]).toEqual(s.intents[0])
    expect(s.requestedEvents()).toHaveLength(1)
    expect(projectWrapvmPolicy('s1', s.events).record).toMatchObject({ mode: 'protected', generation: 1 })
  })

  it('treats an ambiguous intent barrier as not durable, retries it, and the adapter dedup keeps the log clean', async () => {
    const s = new DurableSink({ persistIntent: ['ambiguous', 'succeed'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
    // The write landed despite the rejection: the log already holds the intent.
    expect(s.requestedEvents()).toHaveLength(1)

    const recovered = s.controller.recover('s1', 'button')
    expect((await recovered.done).mode).toBe('protected')
    expect(s.calls.persistIntent).toBe(2) // re-attempted because durability was unproven
    // The retry deduped against the landed write: no duplicate event exists.
    expect(s.requestedEvents()).toHaveLength(1)
    expect(projectWrapvmPolicy('s1', s.events).record).toMatchObject({ mode: 'protected', generation: 1 })
  })

  it('re-attempts an ambiguously durable arm barrier without double-installing the latch record', async () => {
    const s = new DurableSink({ arm: ['ambiguous', 'succeed'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked' })
    expect(s.latch.has(1)).toBe(true) // the latch write landed despite the rejection

    const recovered = s.controller.recover('s1', 'button')
    expect((await recovered.done).mode).toBe('protected')
    expect(s.calls.arm).toBe(2) // unproven durability is re-attempted, never assumed
    expect(s.latch.size).toBe(1) // idempotent install: no second record
    expect(projectWrapvmPolicy('s1', s.events).record).toMatchObject({ mode: 'protected', generation: 1 })
  })

  it('blocks again when a required durable barrier still fails on recovery, never protected', async () => {
    const s = new DurableSink({ arm: ['reject', 'reject'] })
    await s.controller.request('s1', 'command').done
    const recovered = s.controller.recover('s1', 'button')
    expect(await recovered.done).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /not durable/ })
    expect(s.calls.arm).toBe(2)
    expect(s.calls.bind).toBe(0)
    expect(s.calls.commit).toBe(0) // no commit without a proven arm barrier
    expect(s.controller.mode('s1')).toBe('protected-unavailable')
    expect(s.events.some(event => event.type === 'wrapvm/policy-committed')).toBe(false)
  })

  it('recovers a mixed failure cycle (ambiguous arm + rejected intent) with one clean replay', async () => {
    const s = new DurableSink({ arm: ['ambiguous'], persistIntent: ['reject', 'succeed'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked.stage).toBe('blocked')
    const recovered = s.controller.recover('s1', 'button')
    expect((await recovered.done).mode).toBe('protected')
    expect(s.calls.arm).toBe(2)
    expect(s.calls.persistIntent).toBe(2)
    expect(s.latch.size).toBe(1)
    expect(s.requestedEvents()).toHaveLength(1)
    expect(projectWrapvmPolicy('s1', s.events).record).toMatchObject({ mode: 'protected', generation: 1 })
  })

  // Regression (Sol review P1 #1, crash path): after a restart the projection
  // proves the intent barrier durable at this generation. Recovery must not
  // append a second conflicting event and must not skip an unproven barrier.
  it('recovers a crash-restored activation intent without duplicate events or skipped barriers', async () => {
    const s = new DurableSink()
    // Durable state before the crash: the intent is durable, the commit never landed.
    s.events.push({ type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 1 })
    const projected = projectWrapvmPolicy('s1', s.events)
    expect(projected.record.mode).toBe('activating')

    // A fresh controller after restart restores the projection before model work.
    const fresh = s.freshController()
    fresh.restore(projected.record)
    expect(fresh.mode('s1')).toBe('activating')
    const recovered = fresh.recover('s1', 'command')
    expect((await recovered.done).mode).toBe('protected')
    // The attempt identity is not durable: the restarted controller must
    // re-arm to install one before its commit can pass the core CAS.
    expect(s.calls.arm).toBe(1)
    expect(s.commitFences[0]).toBe(s.armFences[0])
    // No duplicate or conflicting events: exactly one intent, one commit.
    expect(s.events).toEqual([
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 1 },
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-1' },
    ])
    expect(projectWrapvmPolicy('s1', s.events).record).toEqual({
      sessionKey: 's1', mode: 'protected', generation: 1, stage: 'idle', environmentId: 'env-1',
    })
  })

  it('refuses to protect after a restart when the re-attempted barrier still fails', async () => {
    const s = new DurableSink({ arm: ['reject'] })
    // Restore-time degradation: a fresh controller restored to
    // protected-unavailable proves nothing durable, so recovery must
    // re-attempt the barriers — and a failing re-attempt blocks again, never
    // protects.
    const fresh = s.freshController()
    fresh.restore(degradeToUnavailable({ sessionKey: 's1', mode: 'activating', generation: 1, stage: 'awaiting-quiescence' }))
    expect(fresh.mode('s1')).toBe('protected-unavailable')
    const outcome = await fresh.recover('s1', 'button').done
    expect(outcome).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /not durable/ })
    expect(s.calls.arm).toBe(1) // the unproven barrier was re-attempted, never assumed
    expect(s.calls.commit).toBe(0)
    expect(fresh.mode('s1')).toBe('protected-unavailable')
    expect(s.events.some(event => event.type === 'wrapvm/policy-committed')).toBe(false)
  })
})

describe('release composed with the durable fold', () => {
  // Regression (Sol review P1 #2): the fold required a prior policy-committed
  // for policy-released, so an authenticated exit after a FAILED precommit
  // barrier replayed as corrupt protected-unavailable even though the
  // controller's release() permits it at the current armed generation.
  it('accepts an authenticated release after a failed precommit barrier; replay restores normal', async () => {
    const s = new DurableSink({ commit: ['reject'] })
    const blocked = await s.controller.request('s1', 'command').done
    expect(blocked).toMatchObject({ mode: 'protected-unavailable', stage: 'blocked', reason: /durable commit failed/ })
    expect(s.controller.release('s1', 1)).toBe(true)
    s.release(1) // the adapter mirrors the core-authenticated release durably
    expect(s.controller.mode('s1')).toBe('normal')
    expect(s.controller.generation('s1')).toBe(2)
    // The fold must accept the release at the armed generation WITHOUT a commit.
    expect(projectWrapvmPolicy('s1', s.events)).toEqual({
      record: { sessionKey: 's1', mode: 'normal', generation: 2, stage: 'idle' },
    })

    // The next activation starts at generation 3 and commits cleanly through both views.
    const next = s.controller.request('s1', 'command')
    expect(next.generation).toBe(3)
    expect((await next.done).mode).toBe('protected')
    expect(projectWrapvmPolicy('s1', s.events).record).toEqual({
      sessionKey: 's1', mode: 'protected', generation: 3, stage: 'idle', environmentId: 'env-2',
    })

    // A stale release against the released generation stays corrupt, and the
    // controller refuses it too: no second release authority is introduced.
    expect(s.controller.release('s1', 1)).toBe(false)
    const stale = projectWrapvmPolicy('s1', [...s.events, { type: 'wrapvm/policy-released', generation: 1 }])
    expect(stale.record.mode).toBe('protected-unavailable')
    expect(stale.invalid).toMatch(/policy-released/)
  })

  it('still fails closed on a release at an unknown generation', () => {
    const projected = projectWrapvmPolicy('s1', [
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: 1 },
      { type: 'wrapvm/policy-released', generation: 2 },
    ])
    expect(projected.record.mode).toBe('protected-unavailable')
    expect(projected.invalid).toMatch(/policy-released/)
  })

  it('fences a durable commit that lands after an authenticated release; controller and fold agree', async () => {
    const s = new DurableSink({ gateCommit: true })
    const done = s.controller.request('s1', 'command').done
    await flush() // the commit barrier is invoked and pending
    expect(s.calls.commit).toBe(1)
    expect(s.controller.release('s1', 1)).toBe(true)
    s.release(1) // core release lands durably and fences the late commit
    expect((await done).mode).toBe('normal')
    await flush()
    // The late durable effect was discarded by the fence: no commit event.
    expect(s.events).toEqual([
      { type: 'wrapvm/activation-requested', generation: 1, source: 'command', requestedAt: expect.any(Number) },
      { type: 'wrapvm/policy-released', generation: 1 },
    ])
    expect(projectWrapvmPolicy('s1', s.events)).toEqual({
      record: { sessionKey: 's1', mode: 'normal', generation: 2, stage: 'idle' },
    })
    expect(s.controller.mode('s1')).toBe('normal')
  })

  it('keeps the corruption rule sticky: a release never legitimises an earlier corrupt log', async () => {
    const s = new DurableSink()
    const done = s.controller.request('s1', 'command').done
    s.succeedCommit()
    expect((await done).mode).toBe('protected')
    s.controller.release('s1', 1)
    s.release(1)
    // A duplicate commit at the released generation remains corrupt forever.
    const corrupt = projectWrapvmPolicy('s1', [
      ...s.events,
      { type: 'wrapvm/policy-committed', generation: 1, environmentId: 'env-X' },
    ])
    expect(corrupt.record.mode).toBe('protected-unavailable')
    expect(corrupt.invalid).toMatch(/duplicate policy-committed|no matching activation/)
  })
})