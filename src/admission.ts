/**
 * Final-dispatch admission and in-flight accounting for protected mode.
 *
 * The rewritten core contract makes the core latch the accounting authority:
 * it calls `check` with the exact dispatched definition, admits before the
 * body, and settles on every outcome. The plugin-side provider below decides
 * identity/constraints only; the `InFlightLedger` is a plugin-local mirror for
 * tests and observability, never the production authority. Activation awaits
 * the core `latch.awaitQuiescence` through the activation port, so it can
 * never declare protection while an older host call is about to enter its body.
 * @module
 */
import type { ToolDefinition, ToolExecution, ToolSafetyDecision } from '@deepseek-ai/dsh-tools'
import { admitsTrustedOnly, blocksHostWork, type SafetyMode } from './policy.ts'
import { admitTrustedCall, type TrustedCapabilitySet } from './capabilities.ts'

/** One execution tracked between final admission and settlement. */
export interface TrackedExecution {
  /** Execution identity (the executor-assigned token). */
  readonly key: object | symbol
  readonly name: string
}

/**
 * In-flight accounting for admitted executions. `admit`/`settle` are paired by
 * execution identity; quiescence is reached when no admitted execution remains.
 *
 * NOT the production authority: this ledger is plugin-local state for the
 * provider and the activation controller. The production per-session ledger
 * is core-owned (the runtime phase's dispatch-side accounting wired to the
 * final check); when that API lands this class becomes a thin adapter over it
 * — see the handoff note in `scratch/plans/wrapvm-v02-plugin-contract-fixes.md`.
 */
export class InFlightLedger {
  private readonly inflight = new Map<object | symbol, string>()
  private idleWaiters: { resolve(): void; reject(error: Error): void; signal: AbortSignal; onAbort(): void }[] = []

  /**
   * Record an execution admitted past the final check.
   * @param exec - the admitted execution identity.
   */
  admit(exec: TrackedExecution): void {
    this.inflight.set(exec.key, exec.name)
  }

  /**
   * Record that an admitted execution settled; unknown identities are ignored
   * because settlement may follow a provider replacement.
   * @param exec - the settled execution identity.
   */
  settle(exec: TrackedExecution): void {
    this.inflight.delete(exec.key)
    if (this.inflight.size === 0) this.releaseWaiters()
  }

  /** Number of admitted executions that have not settled. */
  inFlight(): number {
    return this.inflight.size
  }

  /** Names of admitted executions that have not settled, in admission order. */
  pendingNames(): readonly string[] {
    return [...this.inflight.values()]
  }

  /**
   * Wait until no admitted execution remains.
   * @param signal - cancellation; rejection carries the abort reason.
   * @param timeoutMs - upper bound; rejection means quiescence could not be
   *   verified, which must block activation rather than proceed.
   * @returns resolves at quiescence, rejects on cancellation or timeout.
   */
  awaitQuiescence(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.inflight.size === 0) return Promise.resolve()
    signal.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        remove()
        reject(new Error(`wrapvm-isolate: host work did not settle within ${timeoutMs}ms: ${this.pendingNames().join(', ')}`))
      }, timeoutMs)
      const onAbort = (): void => {
        remove()
        reject(signal.reason instanceof Error ? signal.reason : new Error('wrapvm-isolate: quiescence wait cancelled'))
      }
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          remove()
          resolve()
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          remove()
          reject(error)
        },
        signal,
        onAbort,
      }
      function remove(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const index = idleWaiters.indexOf(waiter)
        if (index >= 0) idleWaiters.splice(index, 1)
      }
      const idleWaiters = this.idleWaiters
      signal.addEventListener('abort', onAbort, { once: true })
      this.idleWaiters.push(waiter)
    })
  }

  private releaseWaiters(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }
}

/** Live protection state the admission provider reads at final dispatch. */
export interface AdmissionState {
  /** Current protection mode for the session this provider guards. */
  mode(): SafetyMode
  /** Current policy generation for the session this provider guards. */
  generation(): number
}

/**
 * Final-dispatch admission provider matching the rewritten core contract:
 * `check` receives the exact definition the dispatch will invoke. Structurally
 * compatible with the core `ToolSafetyAdmission` (the runtime adapter passes
 * this object to `latch.setProvider`).
 */
export interface ProtectedAdmissionProvider {
  /**
   * Decide whether the execution may enter its tool body now.
   * @param exec - the execution after pre-execute policy and around-dispatch middleware.
   * @param tool - the exact definition the dispatch resolved; identity checks
   *   use this, never a provider-side re-lookup. A dispatch that presents no
   *   definition is denied fail-closed.
   */
  check(exec: Readonly<ToolExecution>, tool: ToolDefinition | undefined): ToolSafetyDecision
  /** Record that an execution passed `check` and is entering its body. */
  admitted(exec: Readonly<ToolExecution>): void
  /** Record that an admitted execution settled (success, failure, or cancellation). */
  settled(exec: Readonly<ToolExecution>): void
}

/**
 * Build the plugin-side admission provider for one protected session.
 * @param state - live mode/generation source (the activation controller).
 * @param pinned - the session's pinned trusted capability identities.
 * @param ledger - optional plugin-local mirror of the admitted/settled pair for
 *   observability and fixtures. NOT the production authority: the core latch
 *   owns per-session in-flight accounting (`inFlight`/`pendingNames`/
 *   `awaitQuiescence`, token-bound, provider-detachment proof; `settled` is
 *   notified to the provider that received the `admitted`). Activation awaits
 *   the core quiescence through its own port, never this ledger.
 * @returns a provider satisfying the rewritten core `ToolSafetyAdmission`
 *   contract (`check` receives the exact dispatched definition). There is no
 *   provider-side definition lookup: identity comes only from the `tool`
 *   parameter, and a missing definition denies fail-closed.
 */
export function createProtectedAdmission(
  state: AdmissionState,
  pinned: TrustedCapabilitySet,
  ledger?: InFlightLedger,
): ProtectedAdmissionProvider {
  return {
    check(exec: Readonly<ToolExecution>, tool: ToolDefinition | undefined): ToolSafetyDecision {
      const mode = state.mode()
      if (!blocksHostWork(mode)) return { kind: 'allow' }
      if (!admitsTrustedOnly(mode)) {
        return { kind: 'deny', reason: 'the bound VM environment is unavailable; protected mode does not fall back to the Mac' }
      }
      // The dispatched definition is the sole identity authority; the provider
      // never re-resolves identity itself.
      // `exec.arguments` is the losslessly snapshotted, deep-frozen parsed
      // arguments; pinned capabilities with parameter constraints (bundled
      // skill loads) are checked against them at final dispatch.
      const denial = admitTrustedCall(exec.name, tool, pinned, exec.arguments)
      return denial === undefined ? { kind: 'allow' } : { kind: 'deny', reason: denial }
    },
    admitted(exec: Readonly<ToolExecution>): void {
      ledger?.admit({ key: exec.token, name: exec.name })
    },
    settled(exec: Readonly<ToolExecution>): void {
      ledger?.settle({ key: exec.token, name: exec.name })
    },
  }
}