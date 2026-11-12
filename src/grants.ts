/**
 * One-shot Mac-access grants for protected mode.
 *
 * A grant authorizes exactly one bounded host operation (file/directory import
 * or export) chosen by an authenticated user answer. It is immutable, bound to
 * the exact tool definition identity (the name alone is never authority), a
 * deep defensive snapshot of the approved parameters, the conversation, the
 * receiving agent, the policy generation, and an expiry. Consumption is atomic
 * and single-use: two racing consumptions admit at most one.
 *
 * Restart NEVER recovers an unconsumed approval. Durable issuance/consumption
 * records are an audit trail only: after a restart every still-unconsumed grant
 * must be re-approved by the user, and consumed or revoked records are never
 * re-admitted. Model text, web content, and tool results never authorize
 * issuance.
 * @module
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Host operations the first protected-mode version may grant. */
export const GRANT_OPERATIONS = ['import-file', 'export-file', 'import-directory', 'export-directory'] as const

/** One grantable host operation. Arbitrary host shell is never grantable. */
export type GrantOperation = (typeof GRANT_OPERATIONS)[number]

/** Parameter shape a caller may present for approval or consumption (flat JSON scalars). */
export type GrantParameters = Readonly<Record<string, string | number | boolean | null>>

/** Durable record of one issued grant. */
export interface HostAccessGrant {
  readonly id: string
  readonly operation: GrantOperation
  /** Exact tool name the grant may be consumed through. */
  readonly toolName: string
  /**
   * Exact tool definition identity the user approved. The name alone is not
   * authority: a shadowed or replaced registration behind the same name is
   * refused at consumption. The durable adapter must persist a verifiable
   * identity (name + owner + digest) and re-resolve it on restore.
   */
  readonly toolDefinition: ToolDefinition
  /** Canonical deep-frozen snapshot taken at issuance; later caller mutation cannot reach it. */
  readonly parameters: GrantParameters
  readonly sessionKey: string
  readonly agentId: string
  /** Policy generation the grant was issued under; a bumped generation voids it. */
  readonly generation: number
  /** Epoch ms after which the grant is refused. */
  readonly expiresAt: number
}

/** Presentation facts shown to the user before approval. */
export interface GrantDisclosure {
  readonly operation: GrantOperation
  readonly reason: string
  readonly resources: readonly string[]
  readonly consequences: readonly string[]
}

/** Result of one consumption attempt. */
export type GrantConsumption =
  | { kind: 'consumed'; grant: HostAccessGrant }
  | { kind: 'refused'; reason: string }

/** Attempt to consume a grant with the call's presented facts. */
export interface GrantAttempt {
  readonly grantId: string
  readonly operation: GrantOperation
  readonly toolName: string
  /**
   * Definition the registry resolves for the call at final dispatch, or
   * undefined when the name resolves to nothing (refused fail-closed).
   */
  readonly toolDefinition: ToolDefinition | undefined
  readonly parameters: GrantParameters
  readonly sessionKey: string
  readonly agentId: string
  readonly generation: number
  /** Epoch ms of the attempt. */
  readonly now: number
}

/**
 * Take a defensive, canonical, deep-frozen snapshot of the parameters. Only
 * flat JSON scalars are accepted: nested objects, arrays, functions, symbols,
 * and undefined values are rejected at the boundary, so the snapshot can never
 * alias caller-owned mutable structure.
 */
function snapshotParameters(parameters: GrantParameters, context: string): GrantParameters {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`wrapvm-isolate: grant ${context} parameters must be a flat parameter object`)
  }
  const snapshot: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(parameters).sort()) {
    const value = (parameters as Record<string, unknown>)[key]
    if (value === null) {
      snapshot[key] = null
      continue
    }
    const kind = typeof value
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw new Error(`wrapvm-isolate: grant ${context} parameter "${key}" must be a flat JSON scalar`)
    }
    if (kind === 'number' && !Number.isFinite(value as number)) {
      throw new Error(`wrapvm-isolate: grant ${context} parameter "${key}" must be a finite number`)
    }
    snapshot[key] = value as string | number | boolean | null
  }
  return Object.freeze(snapshot)
}

/** Canonical key for one parameter record, independent of property order. */
function canonicalParameters(parameters: GrantParameters): string {
  return JSON.stringify(Object.keys(parameters).sort().map(key => [key, parameters[key]]))
}

/**
 * Atomic single-use grant store. The durable persistence of issued/consumed
 * records (Session events plus storage) is wired in the runtime phase; this
 * class owns the issuance/consumption semantics the persistence must preserve.
 * Persistence is audit-only for unconsumed grants: a restart drops them
 * ({@link GrantLedger.dropUnconsumed}) and requires fresh user approval.
 */
export class GrantLedger {
  private readonly issued = new Map<string, HostAccessGrant>()
  private readonly consumed = new Set<string>()
  private readonly revoked = new Set<string>()
  private nextId = 1

  /**
   * Issue one immutable grant after an authenticated user approval. Every
   * field is validated at runtime (callers include adapters carrying
   * deserialized records) and the parameters are deep-snapshotted, so later
   * mutation of the caller's objects cannot change what was approved.
   * @param request - operation, tool identity, parameters, session, agent, generation, expiry.
   * @returns the issued grant, deep-frozen.
   */
  issue(request: Omit<HostAccessGrant, 'id'>): HostAccessGrant {
    if (!(GRANT_OPERATIONS as readonly string[]).includes(request.operation)) {
      throw new Error(`wrapvm-isolate: operation "${String(request.operation)}" is never grantable in protected mode`)
    }
    if (typeof request.toolName !== 'string' || request.toolName.length === 0) {
      throw new Error('wrapvm-isolate: grant needs the approved tool name')
    }
    if (request.toolDefinition === null || typeof request.toolDefinition !== 'object') {
      throw new Error('wrapvm-isolate: grant needs the exact approved tool definition')
    }
    if (typeof request.sessionKey !== 'string' || request.sessionKey.length === 0) {
      throw new Error('wrapvm-isolate: grant needs the approved conversation')
    }
    if (typeof request.agentId !== 'string' || request.agentId.length === 0) {
      throw new Error('wrapvm-isolate: grant needs the receiving agent')
    }
    if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
      throw new Error('wrapvm-isolate: grant needs a positive safe-integer policy generation')
    }
    if (typeof request.expiresAt !== 'number' || !Number.isFinite(request.expiresAt)) {
      throw new Error('wrapvm-isolate: grant needs a finite expiry')
    }
    const parameters = snapshotParameters(request.parameters, 'approval')
    // The id is assigned only after every validation passed: a rejected
    // issuance must not consume an id that a later grant could be looked up by.
    const grant: HostAccessGrant = Object.freeze({
      id: `grant-${this.nextId++}`,
      operation: request.operation,
      toolName: request.toolName,
      toolDefinition: request.toolDefinition,
      parameters,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      generation: request.generation,
      expiresAt: request.expiresAt,
    })
    this.issued.set(grant.id, grant)
    return grant
  }

  /**
   * Atomically consume a grant. The consumed mark is applied before the
   * admission is returned, so a second racing attempt can only be refused.
   * @param attempt - the call's presented facts at final dispatch.
   * @returns `consumed` at most once per grant; otherwise the refusal reason.
   */
  consume(attempt: GrantAttempt): GrantConsumption {
    const grant = this.issued.get(attempt.grantId)
    if (grant === undefined) return { kind: 'refused', reason: 'unknown grant' }
    if (this.revoked.has(grant.id)) return { kind: 'refused', reason: 'the grant was revoked' }
    if (this.consumed.has(grant.id)) return { kind: 'refused', reason: 'the grant was already consumed; a retry needs a new approval' }
    if (attempt.now > grant.expiresAt) {
      this.consumed.add(grant.id)
      return { kind: 'refused', reason: 'the grant expired' }
    }
    if (attempt.operation !== grant.operation) return { kind: 'refused', reason: 'the operation does not match the approved grant' }
    if (attempt.toolName !== grant.toolName || attempt.toolDefinition !== grant.toolDefinition) {
      return { kind: 'refused', reason: 'the tool does not match the approved grant' }
    }
    if (attempt.sessionKey !== grant.sessionKey) return { kind: 'refused', reason: 'the conversation does not match the approved grant' }
    if (attempt.agentId !== grant.agentId) return { kind: 'refused', reason: 'the agent does not match the approved grant' }
    if (attempt.generation !== grant.generation) return { kind: 'refused', reason: 'the policy generation changed after approval' }
    let presented: GrantParameters
    try {
      presented = snapshotParameters(attempt.parameters, 'attempt')
    } catch (error: unknown) {
      return { kind: 'refused', reason: `the presented parameters are not a flat snapshot: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (canonicalParameters(presented) !== canonicalParameters(grant.parameters)) {
      return { kind: 'refused', reason: 'the parameters do not match the approved grant' }
    }
    this.consumed.add(grant.id)
    return { kind: 'consumed', grant }
  }

  /**
   * Revoke an unconsumed grant (user withdrawal or environment change).
   * @param grantId - the grant to revoke.
   */
  revoke(grantId: string): void {
    this.revoked.add(grantId)
  }

  /**
   * Whether a grant was issued and not yet consumed or revoked.
   * @param grantId - the grant to inspect.
   * @returns true while the grant remains outstanding.
   */
  isOutstanding(grantId: string): boolean {
    return this.issued.has(grantId) && !this.consumed.has(grantId) && !this.revoked.has(grantId)
  }

  /**
   * Drop every unconsumed grant. Restart/recovery calls this: unconsumed
   * approvals are never silently recovered, even when their issuance was
   * persisted; the user must approve again. Consumed records stay refused.
   */
  dropUnconsumed(): void {
    for (const id of [...this.issued.keys()]) {
      if (!this.consumed.has(id)) this.revoked.add(id)
    }
  }
}