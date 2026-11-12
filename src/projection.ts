/**
 * Typed Session events for Wrapvm protected mode and their projection.
 *
 * The fold is the single source for restoring conversation mode after restart,
 * reload, fork, or context acquisition, and it runs before the agent receives
 * work. It is fail-closed: a missing, unreadable, malformed, or out-of-order
 * protection record never restores `normal` and never downgrades protection.
 * The fold validates every event's runtime shape (event payloads arrive from
 * durable storage and are not trusted TypeScript), enforces strictly
 * monotonic safe-integer generations, and refuses impossible orderings —
 * including a second `policy-committed` at one generation, which would
 * otherwise silently rebind the session from one environment to another
 * without any activation. Pause or stop of the container never returns a
 * protected conversation to `normal` either. The durable wiring (event
 * registration in `SessionEventMap`, storage, and the agent setup hook) lands
 * in the runtime phase against these shapes.
 * @module
 */
import type { SafetyMode, SafetyTransitionStage } from '@deepseek-ai/dsh-tools'
import type { PolicyRecord } from './policy.ts'

/** Activation intent, persisted before any later transition stage. */
export interface ActivationRequestedEvent {
  readonly type: 'wrapvm/activation-requested'
  readonly generation: number
  readonly source: 'command' | 'button'
  readonly requestedAt: number
}

/** Binding and policy committed; protection is authoritative from here. */
export interface PolicyCommittedEvent {
  readonly type: 'wrapvm/policy-committed'
  readonly generation: number
  readonly environmentId: string
}

/** The bound environment stopped responding; mode stays protected-closed. */
export interface EnvironmentLostEvent {
  readonly type: 'wrapvm/environment-lost'
  readonly generation: number
}

/** The bound environment answered again after a loss. */
export interface EnvironmentRestoredEvent {
  readonly type: 'wrapvm/environment-restored'
  readonly generation: number
}

/** One host-access grant consumed (audit trail; never re-admits anything). */
export interface GrantConsumedEvent {
  readonly type: 'wrapvm/grant-consumed'
  readonly generation: number
  readonly grantId: string
}

/** User-authenticated release; the only event that restores `normal`. */
export interface PolicyReleasedEvent {
  readonly type: 'wrapvm/policy-released'
  readonly generation: number
}

/** Every protected-mode Session event. */
export type WrapvmSessionEvent =
  | ActivationRequestedEvent
  | PolicyCommittedEvent
  | EnvironmentLostEvent
  | EnvironmentRestoredEvent
  | GrantConsumedEvent
  | PolicyReleasedEvent

/** Result of folding the protection events of one conversation. */
export interface WrapvmProjection {
  readonly record: PolicyRecord
  /** Set when events were unreadable, malformed, or out of order; the record is fail-closed. */
  readonly invalid?: string
}

function isSafeGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validate one event's runtime shape before the fold trusts it. Payloads come
 * from durable storage and may be corrupt or hostile; anything unexpected
 * fails closed instead of being interpreted.
 * @returns an invalidation reason, or undefined when the event is well-formed.
 */
function malformedEvent(event: WrapvmSessionEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>
  if (record === null || typeof record !== 'object') return 'protection event is not an object'
  switch (record.type) {
    case 'wrapvm/activation-requested':
      if (!isSafeGeneration(record.generation)) return 'activation-requested generation must be a positive safe integer'
      if (record.source !== 'command' && record.source !== 'button') return 'activation-requested source must be command or button'
      if (typeof record.requestedAt !== 'number' || !Number.isFinite(record.requestedAt)) return 'activation-requested requestedAt must be a finite number'
      return undefined
    case 'wrapvm/policy-committed':
      if (!isSafeGeneration(record.generation)) return 'policy-committed generation must be a positive safe integer'
      if (!isNonEmptyString(record.environmentId)) return 'policy-committed environmentId must be a non-empty string'
      return undefined
    case 'wrapvm/environment-lost':
    case 'wrapvm/environment-restored':
    case 'wrapvm/policy-released':
      if (!isSafeGeneration(record.generation)) return `${String(record.type)} generation must be a positive safe integer`
      return undefined
    case 'wrapvm/grant-consumed':
      if (!isSafeGeneration(record.generation)) return 'grant-consumed generation must be a positive safe integer'
      if (!isNonEmptyString(record.grantId)) return 'grant-consumed grantId must be a non-empty string'
      return undefined
    default:
      return `unknown protection event ${String(record.type)}`
  }
}

/**
 * Fold the protection events of one conversation into a live policy record.
 * Events arrive in log order. An empty log for a never-protected conversation
 * projects `normal`; a protection intent without a commit projects
 * `activating` (admission stays closed); a commit followed by environment loss
 * projects `protected-unavailable`; only `wrapvm/policy-released` at the
 * current generation — committed or still armed (an authenticated exit after a
 * failed precommit barrier is legitimate) — restores `normal`. Generations are
 * strictly monotonic safe integers. Malformed payloads, unknown event types,
 * and out-of-order or impossible records (duplicate commits at one generation,
 * environment events without a commit, release events at a stale or unknown
 * generation) fail closed to `protected-unavailable` and stop the fold; later
 * events never undo an invalidation.
 * @param sessionKey - the conversation the events belong to.
 * @param events - protection events in durable log order.
 * @returns the projected record plus an invalidation reason when applicable.
 */
export function projectWrapvmPolicy(sessionKey: string, events: Iterable<WrapvmSessionEvent>): WrapvmProjection {
  let generation = 0
  let stage: SafetyTransitionStage = 'idle'
  let environmentId: string | undefined
  let committedGeneration = 0
  let lost = false
  let released = true
  let invalid: string | undefined
  for (const event of events) {
    const malformed = malformedEvent(event)
    if (malformed !== undefined) {
      invalid = malformed
      break
    }
    switch (event.type) {
      case 'wrapvm/activation-requested': {
        if (event.generation !== generation + 1) {
          invalid = `activation-requested at generation ${event.generation} after ${generation}`
          break
        }
        if (!Number.isSafeInteger(generation + 1)) {
          invalid = 'policy generation exceeded the safe integer range'
          break
        }
        generation = event.generation
        released = false
        // A new activation cycle starts clean: environment loss and the bound
        // environment belong to the previous cycle and must not leak into it.
        lost = false
        environmentId = undefined
        stage = 'closing-admission'
        break
      }
      case 'wrapvm/policy-committed': {
        if (generation === 0 || event.generation !== generation) {
          invalid = `policy-committed at generation ${event.generation} with no matching activation`
          break
        }
        if (event.generation === committedGeneration) {
          invalid = `duplicate policy-committed at generation ${event.generation}`
          break
        }
        committedGeneration = event.generation
        stage = 'idle'
        environmentId = event.environmentId
        break
      }
      case 'wrapvm/environment-lost': {
        if (event.generation !== generation) invalid = `environment-lost at generation ${event.generation} after ${generation}`
        else if (committedGeneration !== generation) invalid = `environment-lost at generation ${event.generation} without a commit`
        else lost = true
        break
      }
      case 'wrapvm/environment-restored': {
        if (event.generation !== generation) invalid = `environment-restored at generation ${event.generation} after ${generation}`
        else if (committedGeneration !== generation) invalid = `environment-restored at generation ${event.generation} without a commit`
        else lost = false
        break
      }
      case 'wrapvm/grant-consumed': {
        if (event.generation !== generation) invalid = `grant-consumed at generation ${event.generation} after ${generation}`
        else if (committedGeneration !== generation) invalid = `grant-consumed at generation ${event.generation} without a commit`
        break
      }
      case 'wrapvm/policy-released': {
        if (event.generation !== generation) {
          invalid = `policy-released at generation ${event.generation} after ${generation}`
          break
        }
        // No prior commit is required: an authenticated exit is valid at the
        // armed generation even when a precommit barrier failed — the
        // controller's release() permits exactly this, and refusing the
        // release here would strand the conversation blocked forever after a
        // failed activation. Release AUTHORITY is the core latch's
        // (`ReleaseAuthorizer`), never this fold's: the fold only validates
        // durable ordering, and the generation equality above still refuses
        // stale or unknown generations.
        if (!Number.isSafeInteger(generation + 1)) {
          invalid = 'policy generation exceeded the safe integer range'
          break
        }
        generation += 1
        committedGeneration = 0
        released = true
        // The released cycle's environment and its loss are void: a later
        // activation must not inherit `lost` from them.
        lost = false
        stage = 'idle'
        environmentId = undefined
        break
      }
      default: {
        invalid = `unknown protection event ${(event as { type: string }).type}`
        break
      }
    }
    if (invalid !== undefined) break
  }
  if (invalid !== undefined) {
    return {
      record: { sessionKey, mode: 'protected-unavailable', generation: Math.max(generation, 1), stage: 'blocked' },
      invalid,
    }
  }
  const mode: SafetyMode = released ? 'normal'
    : lost ? 'protected-unavailable'
      : stage === 'idle' && environmentId !== undefined ? 'protected'
        : stage === 'idle' ? 'protected-unavailable'
          : 'activating'
  return {
    record: {
      sessionKey,
      mode,
      generation,
      stage,
      ...environmentId !== undefined ? { environmentId } : {},
    },
  }
}

/**
 * Mark a projection as lost-environment without a durable event (backend
 * probe failure at restore time). Host work stays denied.
 * @param record - the projected record to degrade.
 * @returns the degraded `protected-unavailable` record.
 */
export function degradeToUnavailable(record: PolicyRecord): PolicyRecord {
  return { ...record, mode: 'protected-unavailable', stage: record.stage === 'idle' ? 'blocked' : record.stage }
}

/**
 * Project the inherited policy for a fork or derived conversation. The
 * restriction carries; ownership of the bound environment does not transfer
 * implicitly (the child must be bound explicitly by user action).
 * @param parent - the parent conversation's projection.
 * @param childSessionKey - the derived conversation's key.
 * @returns the child's starting record, protected with no environment ownership.
 */
export function inheritProjection(parent: WrapvmProjection, childSessionKey: string): WrapvmProjection {
  if (parent.record.mode === 'normal') return { record: { sessionKey: childSessionKey, mode: 'normal', generation: 0, stage: 'idle' } }
  return {
    record: {
      sessionKey: childSessionKey,
      mode: 'protected-unavailable',
      generation: parent.record.generation,
      stage: 'blocked',
    },
    ...parent.invalid === undefined ? {} : { invalid: parent.invalid },
  }
}