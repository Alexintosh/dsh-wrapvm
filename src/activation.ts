/**
 * Deterministic protected-mode activation.
 *
 * `/use-vm` and the Modalità VM button drive this controller before the model
 * step selects any tool; natural-language requests reach the same entry point
 * but cannot be the safety mechanism. The transition is coordinated outside
 * any tool body: the `vm_enter` convenience tool calls
 * {@link VmActivationController.request} and returns immediately with the
 * transition handle, so it never waits for its own turn. Cancellation or an
 * error after the transition starts leaves the conversation blocked with an
 * explicit recovery path.
 *
 * State-machine rules this controller enforces:
 * - One transition per session at a time. {@link VmActivationController.request}
 *   and {@link VmActivationController.recover} join a running transition
 *   instead of starting a second one (a second concurrent bind could double
 *   create or rebind environments).
 * - The durable ports are Promise-based. `arm` closes host admission
 *   synchronously at invocation, registers the attempt fence's identity as the
 *   session's live attempt, and resolves only once the `activating` record is
 *   crash-durable; `persistIntent` and `commit` resolve only after their
 *   durable barriers. A rejected barrier leaves the conversation blocked —
 *   `protected` is reached only after the commit barrier succeeded.
 * - Two identities govern recovery and must never be conflated. The DURABLE
 *   request identity is (sessionKey, generation): one activation request per
 *   generation, so a proven-durable intent is never re-emitted (a duplicate
 *   `activation-requested` is corrupt to the fold) and a retried intent carries
 *   the identical original payload for the adapter's idempotent append. The
 *   ATTEMPT identity is per controller attempt and always fresh — recovery
 *   re-arms with a new fence because release, restore, or a restart clear the
 *   core's live attempt and its commit CAS fences against it.
 * - Every await is fenced by the EXACT attempt identity (a unique per-attempt
 *   symbol), not just the generation: a {@link VmActivationController.restore}
 *   that installs any state other than the same-generation `activating`
 *   reconciliation, a {@link VmActivationController.release}, or a
 *   {@link VmActivationController.dispose} invalidates the active attempt, and
 *   the stale continuation never mutates session state, commits, or clears a
 *   same-generation replacement's slot. The `done` handle always resolves
 *   (never rejects), so a caller that ignores it cannot produce an unhandled
 *   rejection, and it settles promptly on cancellation even when a backend
 *   port hangs — a local settle never claims the underlying side effect ended;
 *   durable effects are fenced core-side by the attempt identity carried on
 *   the commit port.
 * @module
 */
import type { SafetyMode, SafetyTransitionStage } from '@deepseek-ai/dsh-tools'
import type { PolicyRecord } from './policy.ts'

/** How an activation was requested. Only `command` and `button` are deterministic. */
export type ActivationSource = 'command' | 'button' | 'model-tool'

/** One durable activation intent record, persisted before further stages run. */
export interface ActivationIntent {
  readonly sessionKey: string
  readonly generation: number
  readonly source: ActivationSource
  readonly requestedAt: number
}

/** Handle returned to callers (including `vm_enter`) while the transition runs. */
export interface ActivationHandle {
  readonly sessionKey: string
  readonly generation: number
  /**
   * Resolves with the final mode when the transition commits, blocks, or is
   * superseded. Never rejects.
   */
  readonly done: Promise<ActivationOutcome>
}

/** Terminal state of one activation attempt. */
export interface ActivationOutcome {
  readonly mode: SafetyMode
  readonly stage: SafetyTransitionStage
  /** Why activation blocked or was superseded; present whenever the mode is not `protected`. */
  readonly reason?: string
}

/**
 * Ports the controller drives; production wires latch, ledger, storage, and
 * backend. Durability contract: a port promise resolves only after its record
 * survived a crash (append plus flush/fsync barrier, or the storage domain's
 * durable write), never merely after an in-memory append. A rejected port may
 * have an unknown durable outcome, so the transition must remain blocked.
 */
export interface ActivationPorts {
  /**
   * Install the `activating` record on the core-owned latch and persist it
   * durably, registering `fence.attemptId` as the session's live attempt. The
   * implementation must close host admission SYNCHRONOUSLY when this port is
   * invoked (the latch install), so admission is closed before the controller
   * returns; the returned promise resolves once the record is crash-durable
   * and rejects if durability failed.
   *
   * ATTEMPT FENCE (core Safety API rev.2 `SafetyTransitionFence`): the SAME
   * fence instance is later passed to {@link ActivationPorts.commit}. The
   * adapter must map `fence.attemptId` to the core fence's `attemptId` string
   * (one stable string per symbol) and pass that one fence from `arm` through
   * `commit`, so the core CAS accepts this attempt's durable commit and fences
   * out every superseded attempt.
   *
   * IDEMPOTENCE CONTRACT (adapter): recovery re-invokes this port at the SAME
   * generation with a FRESH fence — the new attempt identity must be
   * reinstalled because release/restore/restart clear the core's live attempt,
   * while the durable request identity (sessionKey, generation) is unchanged.
   * The adapter must make the install idempotent per generation: re-arming an
   * already-durable `activating` record re-registers the attempt and resolves
   * at the durable barrier WITHOUT appending a second activation-intent
   * record. The attempt identity is never the durable request identity.
   */
  arm(record: PolicyRecord, fence: ActivationAttemptFence): Promise<void>
  /**
   * Persist the activation intent behind a crash-durable barrier.
   *
   * IDEMPOTENCE CONTRACT (adapter): the (sessionKey, generation) pair is the
   * stable DURABLE request identity — one activation request per generation.
   * The controller only re-invokes this port when the barrier's durability was
   * not proven, and a retry carries the IDENTICAL intent payload (same
   * requestedAt and source) as the first attempt. The adapter must key the
   * durable append by (sessionKey, generation): if the activation-intent
   * record is already durable — including after an ambiguous write that landed
   * but was not acknowledged — the retry must resolve WITHOUT appending a
   * second event. A duplicate `wrapvm/activation-requested` at one generation
   * is corrupt to the projection fold and fails the session closed.
   */
  persistIntent(intent: ActivationIntent): Promise<void>
  /**
   * Persist the committed binding/policy behind a crash-durable barrier.
   * The controller marks the session `protected` only after this resolves.
   *
   * CORE-SIDE EFFECT FENCE (core Safety API rev.2, `wrapvm-v02-core-api.md` §3):
   * the controller's post-await fencing alone is NOT sufficient. A durable
   * commit can complete AFTER the local attempt was cancelled (release/dispose
   * during a pending commit), so the adapter must apply the durable commit
   * serialized/CAS-style against the attempt identity and expected generation
   * carried by `fence`: a commit whose `fence.attemptId` is no longer the
   * session's live attempt, or whose generation is stale, must be rejected or
   * discarded by the core latch/store even when it arrives late. Generation
   * alone is not enough — a same-generation replacement (recovery after a
   * blocked attempt) carries a fresh `attemptId`, installed by that attempt's
   * own `arm` call: the adapter must pass the SAME fence it received from
   * `arm` for this attempt through to `latch.commit`. The local settle on
   * cancellation does not mean the underlying durable effect ended; the fence
   * is what makes it inert.
   */
  commit(sessionKey: string, generation: number, environmentId: string, fence: ActivationAttemptFence): Promise<void>
  /**
   * Select or create the environment and verify identity, mounts, network,
   * capabilities. `signal` aborts when the attempt is superseded, released,
   * or disposed: the controller settles its local handle promptly on
   * cancellation, so a backend that ignores the signal cannot hold `done`
   * open. Honouring the signal is best-effort cleanup only — a local settle
   * never proves the backend bind did not complete; the durable commit fence
   * above is what keeps a late effect from taking effect.
   */
  bindEnvironment(sessionKey: string, generation: number, signal: AbortSignal): Promise<string>
  /** Start the environment and probe shell, browser, and desktop services. */
  verifyEnvironment(environmentId: string, signal: AbortSignal): Promise<void>
  /**
   * Wait until no admitted execution remains for one session. Production
   * wires this to the CORE-owned per-session
   * `latch.awaitQuiescence(sessionKey, signal, timeoutMs)` — token-bound
   * accounting plus registered quiescence contributors (host jobs/scheduler).
   * The plugin-local `InFlightLedger` is never the production authority for
   * this port. Rejection means quiescence could not be verified: activation
   * blocks.
   */
  awaitQuiescence(sessionKey: string, signal: AbortSignal, timeoutMs: number): Promise<void>
  /** Upper bound for proving in-flight host work concluded. */
  quiescenceTimeoutMs: number
  /** Clock for intent timestamps. */
  now(): number
}

/**
 * Cancellation and identity fence handed to the durable ports (arm and commit)
 * for one activation attempt. See the core-side effect fence documented on
 * {@link ActivationPorts.commit} and the idempotence contract on
 * {@link ActivationPorts.arm}. This is the ATTEMPT identity, deliberately
 * distinct from the durable request identity (sessionKey, generation): two
 * attempts of one recovery chain share the request identity but never the
 * attempt identity. The adapter maps the symbol to the core
 * `SafetyTransitionFence.attemptId` string with one stable string per symbol.
 */
export interface ActivationAttemptFence {
  /** Unique per controller attempt; a same-generation replacement gets a fresh identity. */
  readonly attemptId: symbol
  /** Aborted when the attempt is superseded, released, or disposed. */
  readonly signal: AbortSignal
}

interface SessionState {
  mode: SafetyMode
  generation: number
  stage: SafetyTransitionStage
  environmentId?: string
}

interface RunningTransition {
  handle: ActivationHandle
  generation: number
  /** Exact attempt identity: same-generation replacements get a fresh symbol. */
  attemptId: symbol
  abort: AbortController
}

/**
 * Per-generation durability knowledge for the current activation cycle: which
 * durable barriers have been PROVEN (their port resolved). The
 * (sessionKey, generation) pair is the stable durable request identity — one
 * activation request per generation — so recovery re-attempts only unproven
 * intent persistence and retries carry the original intent payload verbatim
 * for the adapter's idempotent append. The arm barrier is always re-attempted
 * on recovery: not because its durability is doubted, but because only `arm`
 * installs the attempt identity the core CAS fences commit against, and
 * release/restore/restart clear it.
 */
interface CycleDurability {
  generation: number
  intentDurable: boolean
  /** The intent payload first attempted, reused verbatim on retry for idempotency. */
  intent?: ActivationIntent
}

/** One controller attempt: fresh identity + cancellation for every transition. */
interface AttemptContext {
  abort: AbortController
  fence: ActivationAttemptFence
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const noop = (): void => {}

/** Discriminated port outcome: EVERY rejection is `ok: false`, never a sentinel value. */
type PortResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('wrapvm-isolate: activation attempt cancelled')
}

/**
 * Settle the LOCAL result as soon as the attempt is cancelled, even when the
 * underlying port promise hangs or ignores its signal. The original promise
 * keeps attached handlers, so a late rejection can never surface as an
 * unhandled rejection, and the caller's attempt-identity fencing still fences
 * any late completion. A local settle on cancellation does NOT mean the
 * underlying side effect ended.
 */
function raceCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.then(noop, noop)
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Invoke a port and reduce its outcome (synchronous throw or rejection) to a discriminated result. */
async function settlePort<T>(produce: () => Promise<T>, signal: AbortSignal): Promise<PortResult<T>> {
  let promise: Promise<T>
  try {
    promise = raceCancellation(produce(), signal)
  } catch (error: unknown) {
    return { ok: false, error }
  }
  try {
    return { ok: true, value: await promise }
  } catch (error: unknown) {
    return { ok: false, error }
  }
}

/**
 * Activation controller for one protected-mode deployment.
 */
export class VmActivationController {
  private readonly state = new Map<string, SessionState>()
  private readonly running = new Map<string, RunningTransition>()
  private readonly durability = new Map<string, CycleDurability>()

  constructor(private readonly ports: ActivationPorts) {}

  /**
   * Current protection mode for one session; never-activated sessions are `normal`.
   * @param sessionKey - the conversation.
   * @returns the live mode.
   */
  mode(sessionKey: string): SafetyMode {
    return this.state.get(sessionKey)?.mode ?? 'normal'
  }

  /**
   * Current policy generation for one session; 0 when never protected.
   * @param sessionKey - the conversation.
   * @returns the monotonic generation.
   */
  generation(sessionKey: string): number {
    return this.state.get(sessionKey)?.generation ?? 0
  }

  /**
   * Start (or join) the protected-mode transition for one session. Returns
   * synchronously with a handle: host admission closes and the intent ports
   * are invoked before this call returns, while their durable barriers,
   * quiescence, environment binding, and verification continue outside the
   * caller's body. A barrier failure blocks the conversation; it never
   * silently proceeds.
   * @param sessionKey - the conversation to protect.
   * @param source - activation origin; `model-tool` requests join an existing
   *   transition but never start one (the deterministic entry points own it).
   * @returns the transition handle, or a refusal when a model-tool request
   *   arrives with no transition running.
   */
  request(sessionKey: string, source: ActivationSource): ActivationHandle {
    const running = this.running.get(sessionKey)
    if (running !== undefined) return running.handle
    if (this.mode(sessionKey) === 'protected') {
      return { sessionKey, generation: this.generation(sessionKey), done: Promise.resolve({ mode: 'protected', stage: 'idle' }) }
    }
    if (source === 'model-tool') {
      return {
        sessionKey,
        generation: this.generation(sessionKey),
        done: Promise.resolve({
          mode: this.mode(sessionKey),
          stage: 'blocked',
          reason: 'protected-mode activation must be started by /use-vm or the Modalità VM button',
        }),
      }
    }
    const generation = this.generation(sessionKey) + 1
    const record: PolicyRecord = {
      sessionKey,
      mode: 'activating',
      generation,
      stage: 'closing-admission',
    }
    this.set(sessionKey, 'activating', generation, 'closing-admission')
    const intent: ActivationIntent = { sessionKey, generation, source, requestedAt: this.ports.now() }
    // A fresh cycle proves nothing durable yet: recovery must re-attempt the
    // intent barrier until it resolves, retrying with this exact payload.
    this.durability.set(sessionKey, { generation, intentDurable: false, intent })
    const attempt = this.newAttempt(sessionKey, generation)
    let armed: Promise<void>
    try {
      // Closes host admission synchronously at invocation; resolves at the durable barrier.
      armed = this.ports.arm(record, attempt.fence)
    } catch (error: unknown) {
      return this.blockedHandle(sessionKey, generation, `activation could not close host admission: ${failureMessage(error)}`)
    }
    let persisted: Promise<void>
    try {
      persisted = this.ports.persistIntent(intent)
    } catch (error: unknown) {
      persisted = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return this.start(sessionKey, generation, attempt, armed, persisted)
  }

  /**
   * Explicit user recovery from a blocked or interrupted transition. The
   * conversation stays closed to host work until recovery completes or the
   * user releases it. A transition already running for this session is
   * joined, never duplicated.
   * @param sessionKey - the conversation.
   * @param source - recovery origin; only deterministic sources recover.
   * @returns the retried transition handle.
   */
  recover(sessionKey: string, source: ActivationSource): ActivationHandle {
    if (source === 'model-tool') {
      return {
        sessionKey,
        generation: this.generation(sessionKey),
        done: Promise.resolve({
          mode: this.mode(sessionKey),
          stage: 'blocked',
          reason: 'recovery requires /use-vm or the Modalità VM button',
        }),
      }
    }
    const running = this.running.get(sessionKey)
    if (running !== undefined) return running.handle
    const mode = this.mode(sessionKey)
    if (mode === 'normal') {
      return { sessionKey, generation: this.generation(sessionKey), done: Promise.resolve({ mode: 'normal', stage: 'idle' }) }
    }
    if (mode === 'protected') {
      return { sessionKey, generation: this.generation(sessionKey), done: Promise.resolve({ mode: 'protected', stage: 'idle' }) }
    }
    const generation = this.generation(sessionKey)
    if (generation < 1) {
      return this.blockedHandle(sessionKey, generation, 'there is no durable activation intent to recover; start activation with /use-vm')
    }
    // Recovery is a NEW attempt at the SAME generation (the latch never
    // unlocked it): it re-arms with a fresh fence because only `arm` installs
    // the live attempt identity the core CAS fences commit against, and
    // release/restore/restart clear it. The durable request identity stays
    // (sessionKey, generation), so the re-arm must be durably idempotent (see
    // ActivationPorts.arm) and the intent barrier is re-attempted ONLY when
    // its durability was not proven — a proven intent is never re-emitted as
    // a duplicate `activation-requested` the fold must reject as corrupt.
    const cycle = this.cycleFor(sessionKey, generation)
    const attempt = this.newAttempt(sessionKey, generation)
    const record: PolicyRecord = { sessionKey, mode: 'activating', generation, stage: 'closing-admission' }
    let armed: Promise<void>
    try {
      armed = this.ports.arm(record, attempt.fence)
    } catch (error: unknown) {
      return this.blockedHandle(sessionKey, generation, `activation could not close host admission: ${failureMessage(error)}`)
    }
    let persisted: Promise<void>
    if (cycle.intentDurable) {
      persisted = Promise.resolve()
    } else {
      // Retry with the IDENTICAL original payload when one was already
      // attempted, so the adapter's idempotent append dedups an ambiguous write.
      const payload: ActivationIntent = cycle.intent ??= { sessionKey, generation, source, requestedAt: this.ports.now() }
      try {
        persisted = this.ports.persistIntent(payload)
      } catch (error: unknown) {
        persisted = Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return this.start(sessionKey, generation, attempt, armed, persisted)
  }

  /**
   * Reinstall a durable projection before the agent receives work (restart,
   * reload, fork). A restored `protected-unavailable` keeps host work denied.
   * A stale restore (older generation than the live state) is ignored: durable
   * replay never downgrades protection. Any restore other than the same-state
   * reconciliation invalidates a locally running attempt — including a
   * `protected-unavailable` at the SAME generation, which is an authoritative
   * blocked state, not a reconciliation. Only a same-generation `activating`
   * restore is reconciliation: the latch is still armed at that generation and
   * the transition remains the current one. The cancelled continuation is
   * fenced by its exact attempt identity and can never mark the session
   * `protected`.
   * @param record - the projected durable record.
   */
  restore(record: PolicyRecord): void {
    const current = this.state.get(record.sessionKey)
    if (current !== undefined && record.generation < current.generation) return
    const running = this.running.get(record.sessionKey)
    if (running !== undefined && (running.generation !== record.generation || record.mode !== 'activating')) {
      this.cancel(record.sessionKey, 'superseded by a restored policy record')
    }
    this.set(record.sessionKey, record.mode, record.generation, record.stage,
      record.environmentId === undefined ? {} : { environmentId: record.environmentId })
    // Durability knowledge follows the durable record: a projection at
    // `activating` or `protected` for a generation exists only because the
    // activation-intent barrier for that generation is durable, so recovery
    // must not re-emit it. `protected-unavailable` proves nothing (it can come
    // from a degraded or corrupt restore): keep same-generation knowledge,
    // drop anything else. The attempt identity is never durable — a fresh
    // controller after restart must re-arm before its commit passes the CAS.
    if (record.mode === 'activating' || record.mode === 'protected') {
      const known = this.durability.get(record.sessionKey)
      this.durability.set(record.sessionKey, {
        generation: record.generation,
        intentDurable: true,
        ...(known !== undefined && known.generation === record.generation && known.intent !== undefined ? { intent: known.intent } : {}),
      })
    } else if (record.mode !== 'protected-unavailable' || this.durability.get(record.sessionKey)?.generation !== record.generation) {
      this.durability.delete(record.sessionKey)
    }
  }

  /**
   * Mirror of a user-authenticated release of one generation (the GUI exit
   * path; model text never authorizes this). The AUTHORITATIVE release is the
   * core latch's `release(sessionKey, generation)` plus the durable
   * `wrapvm/policy-released` event: the runtime adapter calls this method only
   * after the core release succeeded, so the controller never becomes a second
   * independent source of release authority. A running transition at the
   * session is cancelled first, so its continuation can never re-protect the
   * session. Mirrors the durable fold: releasing generation N moves the
   * session to `normal` at generation N+1, voiding grants bound to N.
   * @param sessionKey - the conversation to release.
   * @param generation - the generation the release was authorized against; a
   *   stale generation is refused.
   * @returns true when the release was applied.
   */
  release(sessionKey: string, generation: number): boolean {
    if (this.generation(sessionKey) !== generation) return false
    this.cancel(sessionKey, 'released by the user')
    // The released cycle is void: a later activation at the bumped generation
    // starts with no durability knowledge.
    this.durability.delete(sessionKey)
    this.state.set(sessionKey, { mode: 'normal', generation: generation + 1, stage: 'idle' })
    return true
  }

  /**
   * Cancel the exact running attempt represented by a handle, without release.
   * Joined callers share one handle and cancellation affects their shared attempt.
   * A settled or superseded handle cannot cancel its replacement. The local
   * result settles promptly; a port that ignores its signal may still run.
   * @param handle - the exact handle returned by request or recover.
   * @param reason - optional explanation for cancelling the attempt.
   * @returns true if this call cancelled the live attempt.
   */
  cancelAttempt(handle: ActivationHandle, reason = 'cancelled by the user'): boolean {
    const running = this.running.get(handle.sessionKey)
    if (running === undefined || running.handle !== handle) return false
    this.set(handle.sessionKey, 'protected-unavailable', running.generation, 'blocked')
    this.cancel(handle.sessionKey, reason)
    return true
  }

  /**
   * Stop every locally running transition (plugin disposal). This does NOT
   * clear protection: the core-owned latch keeps armed sessions closed with
   * no provider installed. Cancelling here only prevents local continuations
   * from outliving the controller; each `done` settles promptly, even when a
   * backend port promise hangs. A local settle does NOT mean the underlying
   * port completed or its side effects ended — late completions stay fenced
   * by attempt identity locally, and durable effects are fenced core-side by
   * the commit attempt fence.
   */
  dispose(): void {
    for (const sessionKey of [...this.running.keys()]) this.cancel(sessionKey, 'activation controller disposed')
    this.running.clear()
  }

  /** Kick off one transition whose durable barriers the caller fired synchronously. */
  private start(sessionKey: string, generation: number, attempt: AttemptContext, armed: Promise<void>, intent: Promise<void>): ActivationHandle {
    const attemptId = attempt.fence.attemptId
    const done = this.advance(sessionKey, generation, attempt, armed, intent)
    const handle: ActivationHandle = { sessionKey, generation, done }
    this.running.set(sessionKey, { handle, generation, attemptId, abort: attempt.abort })
    void done.finally(() => {
      // Compare the exact attempt identity, not just the generation: a
      // same-generation replacement (recovery after a blocked attempt) must
      // keep its slot when this attempt's continuation settles late.
      if (this.running.get(sessionKey)?.attemptId === attemptId) this.running.delete(sessionKey)
    })
    return handle
  }

  /** Fresh attempt identity + cancellation: every transition, including every recovery retry. */
  private newAttempt(sessionKey: string, generation: number): AttemptContext {
    const abort = new AbortController()
    const fence: ActivationAttemptFence = {
      attemptId: Symbol(`wrapvm-isolate:activation:${sessionKey}:${generation}`),
      signal: abort.signal,
    }
    return { abort, fence }
  }

  /** Durability knowledge for one activation cycle; a stale generation starts clean. */
  private cycleFor(sessionKey: string, generation: number): CycleDurability {
    const known = this.durability.get(sessionKey)
    if (known !== undefined && known.generation === generation) return known
    const cycle: CycleDurability = { generation, intentDurable: false }
    this.durability.set(sessionKey, cycle)
    return cycle
  }

  private async advance(
    sessionKey: string,
    generation: number,
    attempt: AttemptContext,
    armed: Promise<void>,
    intent: Promise<void>,
  ): Promise<ActivationOutcome> {
    const { fence } = attempt
    // Fencing compares the exact attempt identity: a same-generation
    // replacement is NOT the same transition and never validates this await.
    const isCurrent = (): boolean => !fence.signal.aborted && this.running.get(sessionKey)?.attemptId === fence.attemptId
    const superseded = (): ActivationOutcome => ({
      mode: this.mode(sessionKey),
      stage: 'blocked',
      reason: 'the transition was superseded by a newer policy state',
    })
    const block = (reason: string): ActivationOutcome => {
      if (!isCurrent()) return superseded()
      this.set(sessionKey, 'protected-unavailable', generation, 'blocked')
      return { mode: 'protected-unavailable', stage: 'blocked', reason }
    }
    try {
      this.set(sessionKey, 'activating', generation, 'awaiting-quiescence')
      // Await BOTH durable barriers even when the first failed: neither promise
      // may end up unhandled, and a failed barrier must block, not proceed.
      // Outcomes are discriminated: EVERY rejection — including undefined or
      // null rejection values — is a failure, never conflated with success.
      const [armedResult, intentResult] = await Promise.all([
        settlePort(() => armed, fence.signal),
        settlePort(() => intent, fence.signal),
      ])
      // Durability knowledge is a fact about the durable log, independent of
      // this attempt's currency: a resolved intent barrier is never re-emitted
      // by a later recovery at the same generation.
      if (intentResult.ok) {
        const cycle = this.durability.get(sessionKey)
        if (cycle !== undefined && cycle.generation === generation) cycle.intentDurable = true
      }
      if (!armedResult.ok) return block(`activation intent is not durable (arm barrier failed): ${failureMessage(armedResult.error)}`)
      if (!intentResult.ok) return block(`activation intent is not durable: ${failureMessage(intentResult.error)}`)
      if (!isCurrent()) return superseded()
      const quiescence = await settlePort(() => this.ports.awaitQuiescence(sessionKey, fence.signal, this.ports.quiescenceTimeoutMs), fence.signal)
      if (!quiescence.ok) {
        return block(`existing host work did not conclude verifiably: ${failureMessage(quiescence.error)}`)
      }
      if (!isCurrent()) return superseded()
      this.set(sessionKey, 'activating', generation, 'binding-environment')
      const bind = await settlePort(() => this.ports.bindEnvironment(sessionKey, generation, fence.signal), fence.signal)
      if (!bind.ok) return block(`environment selection failed: ${failureMessage(bind.error)}`)
      const environmentId = bind.value
      if (!isCurrent()) return superseded()
      this.set(sessionKey, 'activating', generation, 'verifying-guest')
      const verified = await settlePort(() => this.ports.verifyEnvironment(environmentId, fence.signal), fence.signal)
      if (!verified.ok) return block(`environment verification failed: ${failureMessage(verified.error)}`)
      if (!isCurrent()) return superseded()
      this.set(sessionKey, 'activating', generation, 'committing')
      // The SAME fence instance this attempt passed to `arm` flows into the
      // commit port, so the core CAS accepts exactly the attempt that armed.
      const committed = await settlePort(() => this.ports.commit(sessionKey, generation, environmentId, fence), fence.signal)
      if (!committed.ok) {
        // A failed commit barrier may have an unknown durable outcome. The
        // session must not be declared protected and stays blocked-closed.
        // If this attempt was cancelled while the commit was pending, the
        // durable effect may still complete late: rejecting it is the
        // core-side attempt fence (see ActivationPorts.commit).
        return block(`durable commit failed: ${failureMessage(committed.error)}`)
      }
      if (!isCurrent()) return superseded()
      this.set(sessionKey, 'protected', generation, 'idle', { environmentId })
      return { mode: 'protected', stage: 'idle' }
    } catch (error: unknown) {
      // Ports must not throw synchronously mid-stage; fail closed regardless.
      // `done` never rejects, so ignoring the handle cannot create an
      // unhandled rejection.
      return block(`activation failed: ${failureMessage(error)}`)
    }
  }

  private cancel(sessionKey: string, reason: string): void {
    const running = this.running.get(sessionKey)
    if (running === undefined) return
    this.running.delete(sessionKey)
    running.abort.abort(new Error(`wrapvm-isolate: transition ${reason}`))
  }

  private blockedHandle(sessionKey: string, generation: number, reason: string): ActivationHandle {
    this.set(sessionKey, 'protected-unavailable', generation, 'blocked')
    return { sessionKey, generation, done: Promise.resolve({ mode: 'protected-unavailable', stage: 'blocked', reason }) }
  }

  private set(sessionKey: string, mode: SafetyMode, generation: number, stage: SafetyTransitionStage, extra: { environmentId?: string } = {}): void {
    const previous = this.state.get(sessionKey)
    this.state.set(sessionKey, {
      mode,
      generation,
      stage,
      ...extra.environmentId !== undefined ? { environmentId: extra.environmentId }
        : previous?.environmentId !== undefined ? { environmentId: previous.environmentId } : {},
    })
  }
}