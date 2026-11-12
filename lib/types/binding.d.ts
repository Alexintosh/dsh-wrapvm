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
import type { EnvironmentBinding, EnvironmentId } from './environments.ts';
/**
 * Durable event forms the binding projection folds over. `shared` marks a
 * bound event whose reuse of an already-used environment was explicit:
 * replay accepts a second user onto the same environment only with that
 * marker, never silently.
 */
export type BindingEvent = {
    readonly type: 'wrapvm/environment-bound';
    readonly sessionKey: string;
    readonly environmentId: EnvironmentId;
    readonly generation: number;
    readonly timestamp: number;
    readonly shared?: boolean;
} | {
    readonly type: 'wrapvm/environment-unbound';
    readonly sessionKey: string;
    readonly environmentId: EnvironmentId;
    readonly timestamp: number;
};
/** Emission port implemented by the session-event adapter (agent A's infrastructure). */
export interface BindingEventSink {
    /**
     * Persist one binding event durably. The registry applies the event to its
     * projection only after this call resolves, so a rejected sink leaves the
     * in-memory view unchanged.
     * @param event - the event to persist.
     */
    emit(event: BindingEvent): Promise<void>;
}
/** A sink that only records events in memory (tests, dry runs). */
export declare class MemoryBindingEventSink implements BindingEventSink {
    readonly events: BindingEvent[];
    emit(event: BindingEvent): Promise<void>;
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
export declare class BindingRegistry {
    private readonly sink;
    private readonly now;
    private readonly onChange;
    private readonly bindings;
    private readonly users;
    private chain;
    private complete;
    private inFlight;
    private revision;
    private completenessController;
    constructor(sink: BindingEventSink, now?: () => number, onChange?: () => void);
    /** Mark the projection complete only after every authoritative Session was restored. */
    markComplete(): void;
    /** Invalidate the projection when the adapter loses completeness. */
    invalidateCompleteness(): void;
    /** Wait for admitted binding writes before restoring the authoritative Sessions. */
    drained(): Promise<void>;
    /** Clear the projection before a complete replay after completeness was invalidated. */
    resetForRestore(): void;
    /** Whether the adapter has confirmed every Session is represented. */
    isComplete(): boolean;
    /** Serialize a lifecycle decision with binding writes; invalidation aborts its signal immediately. */
    withUsage<T>(environmentId: EnvironmentId, job: (usage: {
        readonly sessions: readonly string[];
        readonly revision: number;
        readonly signal: AbortSignal;
    }) => Promise<T>): Promise<{
        readonly kind: 'incomplete';
    } | {
        readonly kind: 'complete';
        readonly value: T;
    }>;
    /** Current version of the complete binding projection. */
    usageRevision(): number;
    private requireComplete;
    /** Read the binding for one conversation. */
    binding(sessionKey: string): EnvironmentBinding | undefined;
    private projectBinding;
    /** Conversations currently bound to one environment (active users). */
    usersOf(environmentId: EnvironmentId): readonly string[];
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
    bind(sessionKey: string, environmentId: EnvironmentId, generation: number, options?: {
        allowShared?: boolean;
    }): Promise<EnvironmentBinding>;
    /**
     * Unbind one conversation from its environment (explicit user action).
     * Serialized with {@link bind}: an unbind can never interleave between a
     * concurrent bind's check and its apply.
     * @param sessionKey - the conversation.
     * @returns true when a binding existed and was removed.
     */
    unbind(sessionKey: string): Promise<boolean>;
    /**
     * Replay durable events after a restart (restore-before-work). Events are
     * applied in order; the last event per conversation wins. Duplicate replays
     * of the same event are idempotent; a bound event that would add a SECOND
     * user to an environment without the explicit `shared` marker fails closed
     * instead of silently growing the user set.
     * @param events - durable binding events in durable order.
     */
    restore(events: readonly BindingEvent[]): void;
    private apply;
    private attach;
    private detach;
    /** Serialize one binding step (check + durable emit + apply) behind all earlier ones. */
    private serialize;
}
//# sourceMappingURL=binding.d.ts.map