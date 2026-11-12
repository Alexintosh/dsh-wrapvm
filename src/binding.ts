/**
 * Conversation-to-environment binding.
 *
 * Bindings are Session-event facts, projected here — never browser local
 * state. This module owns the projection fold, the active-user index (so a
 * second conversation binding to a busy environment sees an explicit
 * conflict), and the emission port.
 *
 * Boundary note for the runtime-adapter owner (agent A): session event
 * emission and durable persistence belong to the Session event
 * infrastructure. {@link BindingEventSink} is the port the adapter must
 * implement: forward each emitted event to the session event log (the
 * `wrapvm/*` event forms registered in Phase 2), and feed replayed events
 * back through {@link BindingRegistry.restore}. This package never writes
 * session storage directly.
 * @module
 */

import type { EnvironmentBinding, EnvironmentId } from './environments.ts'

/**
 * Durable event forms the binding projection folds over. `shared` marks a
 * bound event whose reuse of an already-used environment was explicit:
 * replay accepts a second user onto the same environment only with that
 * marker, never silently.
 */
export type BindingEvent =
  | { readonly type: 'wrapvm/environment-bound'; readonly sessionKey: string; readonly environmentId: EnvironmentId; readonly generation: number; readonly timestamp: number; readonly shared?: boolean }
  | { readonly type: 'wrapvm/environment-unbound'; readonly sessionKey: string; readonly environmentId: EnvironmentId; readonly timestamp: number }

/** Emission port implemented by the session-event adapter (agent A's infrastructure). */
export interface BindingEventSink {
  /**
   * Persist one binding event durably. The registry applies the event to its
   * projection only after this call resolves, so a rejected sink leaves the
   * in-memory view unchanged.
   * @param event - the event to persist.
   */
  emit(event: BindingEvent): Promise<void>
}

/** A sink that only records events in memory (tests, dry runs). */
export class MemoryBindingEventSink implements BindingEventSink {
  readonly events: BindingEvent[] = []
  emit(event: BindingEvent): Promise<void> {
    this.events.push(event)
    return Promise.resolve()
  }
}

interface BindingState {
  environmentId: EnvironmentId
  generation: number
  history: EnvironmentId[]
}

/**
 * Projected binding registry: one active environment per conversation,
 * selection history visible to the model, and an active-user index per
 * environment.
 *
 * Rules held here:
 * - one environment per conversation at a time; rebinding replaces the active
 *   environment and appends to history;
 * - binding is refused while the environment has active users from OTHER
 *   conversations unless the caller passes `allowShared` (explicit reuse);
 * - unbinding never touches the backend; stop/pause/remove are lifecycle
 *   operations with their own guards;
 * - `restore` replays durable events after a restart; the fold is
 *   order-governed and ignores events for unknown shapes fail-closed.
 */
export class BindingRegistry {
  private readonly bindings = new Map<string, BindingState>()
  private readonly users = new Map<EnvironmentId, Set<string>>()
  private chain: Promise<unknown> = Promise.resolve()
  private complete = false
  private inFlight = 0
  private revision = 0
  private completenessController = new AbortController()

  constructor(
    private readonly sink: BindingEventSink,
    private readonly now: () => number = () => Date.now(),
    private readonly onChange: () => void = () => {},
  ) {}

  /** Mark the projection complete only after every authoritative Session was restored. */
  markComplete(): void {
    if (this.inFlight !== 0) throw new Error('wrapvm-isolate: binding operations must drain before marking complete')
    if (!this.complete) {
      this.completenessController = new AbortController()
      this.revision += 1
      this.complete = true
    }
  }

  /** Invalidate the projection when the adapter loses completeness. */
  invalidateCompleteness(): void {
    this.complete = false
    this.revision += 1
    this.completenessController.abort()
  }

  /** Wait for admitted binding writes before restoring the authoritative Sessions. */
  async drained(): Promise<void> {
    await this.chain
  }

  /** Clear the projection before a complete replay after completeness was invalidated. */
  resetForRestore(): void {
    if (this.complete || this.inFlight !== 0) throw new Error('wrapvm-isolate: invalidate and drain bindings before reset')
    this.bindings.clear()
    this.users.clear()
  }

  /** Whether the adapter has confirmed every Session is represented. */
  isComplete(): boolean {
    return this.complete
  }

  /** Serialize a lifecycle decision with binding writes; invalidation aborts its signal immediately. */
  async withUsage<T>(environmentId: EnvironmentId, job: (usage: {
    readonly sessions: readonly string[]
    readonly revision: number
    readonly signal: AbortSignal
  }) => Promise<T>): Promise<{ readonly kind: 'incomplete' } | { readonly kind: 'complete'; readonly value: T }> {
    return await this.serialize(async () => {
      if (!this.complete) return { kind: 'incomplete' }
      const usage = { sessions: this.usersOf(environmentId), revision: this.revision, signal: this.completenessController.signal }
      return { kind: 'complete', value: await job(usage) }
    })
  }

  /** Current version of the complete binding projection. */
  usageRevision(): number {
    this.requireComplete()
    return this.revision
  }

  private requireComplete(): void {
    if (!this.complete) throw new Error('wrapvm-isolate: binding index is incomplete; restore every Session before use')
  }

  /** Read the binding for one conversation. */
  binding(sessionKey: string): EnvironmentBinding | undefined {
    this.requireComplete()
    return this.projectBinding(sessionKey)
  }

  private projectBinding(sessionKey: string): EnvironmentBinding | undefined {
    const state = this.bindings.get(sessionKey)
    if (state === undefined) return undefined
    return { sessionKey, environmentId: state.environmentId, generation: state.generation, history: [...state.history] }
  }

  /** Conversations currently bound to one environment (active users). */
  usersOf(environmentId: EnvironmentId): readonly string[] {
    this.requireComplete()
    return [...(this.users.get(environmentId) ?? [])]
  }

  /**
   * Bind one conversation to one environment.
   *
   * The conflict check, the durable emission, and the projection apply run
   * as ONE serialized step: two concurrent binds of different conversations
   * onto the same environment can never both pass the check against the same
   * pre-state (the second sees the first's applied users).
   * @param sessionKey - the conversation.
   * @param environmentId - the environment selected by the user.
   * @param generation - policy generation the binding commits under.
   * @param options - `allowShared` permits explicit reuse of an environment
   * already used by another conversation; the default refuses it.
   * @returns the new binding.
   * @throws when another conversation actively uses the environment.
   */
  async bind(
    sessionKey: string, environmentId: EnvironmentId, generation: number, options: { allowShared?: boolean } = {},
  ): Promise<EnvironmentBinding> {
    return await this.serialize(async () => {
      this.requireComplete()
      const otherUsers = this.usersOf(environmentId).filter(key => key !== sessionKey)
      if (otherUsers.length > 0 && options.allowShared !== true) {
        throw new Error(`wrapvm-isolate: environment ${environmentId} is already used by ${otherUsers.join(', ')}; sharing must be explicit`)
      }
      const previous = this.bindings.get(sessionKey)
      if (previous !== undefined && previous.environmentId === environmentId && previous.generation === generation) {
        // Idempotent re-bind under the same generation: no duplicate event.
        const current = this.projectBinding(sessionKey)
        if (current === undefined) throw new Error('wrapvm-isolate: binding projection is inconsistent')
        return current
      }
      const event: BindingEvent = {
        type: 'wrapvm/environment-bound',
        sessionKey,
        environmentId,
        generation,
        timestamp: this.now(),
        ...(options.allowShared === true ? { shared: true } : {}),
      }
      await this.sink.emit(event)
      this.apply(event)
      this.onChange()
      const applied = this.projectBinding(sessionKey)
      if (applied === undefined) throw new Error('wrapvm-isolate: binding projection is inconsistent')
      return applied
    })
  }

  /**
   * Unbind one conversation from its environment (explicit user action).
   * Serialized with {@link bind}: an unbind can never interleave between a
   * concurrent bind's check and its apply.
   * @param sessionKey - the conversation.
   * @returns true when a binding existed and was removed.
   */
  async unbind(sessionKey: string): Promise<boolean> {
    return await this.serialize(async () => {
      this.requireComplete()
      const state = this.bindings.get(sessionKey)
      if (state === undefined) return false
      const event: BindingEvent = { type: 'wrapvm/environment-unbound', sessionKey, environmentId: state.environmentId, timestamp: this.now() }
      await this.sink.emit(event)
      this.apply(event)
      this.onChange()
      return true
    })
  }

  /**
   * Replay durable events after a restart (restore-before-work). Events are
   * applied in order; the last event per conversation wins. Duplicate replays
   * of the same event are idempotent; a bound event that would add a SECOND
   * user to an environment without the explicit `shared` marker fails closed
   * instead of silently growing the user set.
   * @param events - durable binding events in durable order.
   */
  restore(events: readonly BindingEvent[]): void {
    if (this.complete || this.inFlight !== 0) throw new Error('wrapvm-isolate: invalidate and drain bindings before restoring Sessions')
    for (const event of events) this.apply(event)
  }

  private apply(event: BindingEvent): void {
    switch (event.type) {
      case 'wrapvm/environment-bound': {
        const previous = this.bindings.get(event.sessionKey)
        const others = [...(this.users.get(event.environmentId) ?? [])].filter(key => key !== event.sessionKey)
        if (others.length > 0 && event.shared !== true) {
          throw new Error(`wrapvm-isolate: conflicting binding events: ${event.environmentId} is used by ${others.join(', ')}; '${event.sessionKey}' may only join with an explicit shared event`)
        }
        if (previous !== undefined) this.detach(event.sessionKey, previous.environmentId)
        const history = [...(previous?.history ?? [])]
        if (history.at(-1) !== event.environmentId) history.push(event.environmentId)
        this.revision += 1
        this.bindings.set(event.sessionKey, { environmentId: event.environmentId, generation: event.generation, history })
        this.attach(event.sessionKey, event.environmentId)
        return
      }
      case 'wrapvm/environment-unbound': {
        const previous = this.bindings.get(event.sessionKey)
        if (previous === undefined || previous.environmentId !== event.environmentId) return
        this.revision += 1
        this.detach(event.sessionKey, event.environmentId)
        this.bindings.delete(event.sessionKey)
        return
      }
      default: {
        // Unknown event shape: fail closed by ignoring is NOT safe for policy
        // events, but bindings are not the safety latch — record and skip.
        const unknown: string = (event as BindingEvent).type
        throw new Error(`wrapvm-isolate: unknown binding event type '${unknown}'`)
      }
    }
  }

  private attach(sessionKey: string, environmentId: EnvironmentId): void {
    const set = this.users.get(environmentId) ?? new Set<string>()
    set.add(sessionKey)
    this.users.set(environmentId, set)
  }

  private detach(sessionKey: string, environmentId: EnvironmentId): void {
    const set = this.users.get(environmentId)
    if (set === undefined) return
    set.delete(sessionKey)
    if (set.size === 0) this.users.delete(environmentId)
  }

  /** Serialize one binding step (check + durable emit + apply) behind all earlier ones. */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    this.inFlight += 1
    const wrapped = async (): Promise<T> => {
      try {
        return await job()
      } finally {
        this.inFlight -= 1
      }
    }
    const result = this.chain.then(wrapped, wrapped)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
