/**
 * Environment lifecycle manager.
 *
 * The durable multi-environment manager the UI, Remote face, and activation
 * controller consume. It composes the inventory, the backend driver, the
 * binding registry, and the mount policy behind one serialized mutation
 * queue with observable operations.
 *
 * Invariants enforced here:
 * - mutations are serial per environment and operation-admitted targets are
 *   captured INSIDE the serialized admission through the driver's verified
 *   acquisition API (`captureTarget`): rebinding or re-listing never
 *   retargets a call in flight, and no target is ever reconstructed from an
 *   inventory record alone;
 * - destructive work (removal) re-verifies container/network/volume
 *   ownership with `verifyTarget` immediately before dispatch and refuses
 *   outright when the driver cannot verify — an unverified destructive call
 *   never reaches the engine;
 * - duplicate requests deduplicate by idempotency key AND by the persisted
 *   canonical request signature: the same semantic request returns the same
 *   operation, a DIFFERENT request reusing the key is refused, never silently
 *   answered with an unrelated previous success;
 * - the shared lease coordinator serializes lifecycle mutation admission with
 *   guest executions and requires an explicit user override while busy;
 *   unknown backend outcomes block dependent mutations and budget decisions;
 * - crash recovery: the settled operation AND its inventory outcome commit in
 *   one durable transaction; `initialize()` only inspects the backend and
 *   records interrupted intents. Explicit recovery addresses one intent;
 *   initialization never starts or removes backend resources;
 * - a manual pause is never auto-resumed and a stopped environment never
 *   auto-starts: reconciliation only observes, it never contradicts the
 *   desired phase;
 * - removal previews the inspected effective configuration (captured target
 *   plus the full record snapshot), expires, is consumed exactly once, and
 *   is atomically revalidated inside admission: a replaced container, a
 *   recreated network, or any record change invalidates the token. Host
 *   directories are never deleted;
 * - creation AND limit updates are checked against the aggregate host budget
 *   inside the same serialization, so concurrent requests cannot both pass
 *   against the same committed total; a failed driver call leaves the
 *   desired state untouched (the outcome commits only with a completed
 *   operation), and disk quotas are refused by the backend, not silently
 *   dropped.
 * @module
 */
import type { EnvironmentBackendDriver, EnvironmentBinding, EnvironmentCreateInput, EnvironmentDescriptor, EnvironmentId, EnvironmentLimits, EnvironmentOperation, EnvironmentRegistry } from './environments.ts';
import type { Inventory, PersistedOperation } from './inventory.ts';
import type { BindingRegistry } from './binding.ts';
import type { MountPolicyContext } from './mount-policy.ts';
/** Host budget the manager refuses to exceed when creating or resizing environments. */
export interface HostBudget {
    readonly totalCpuMillis: number;
    readonly totalMemoryBytes: number;
}
/** Options for one lifecycle mutation call. */
export interface MutationOptions {
    /** Caller dedup key: a repeated request with the same key returns the same operation. */
    readonly idempotencyKey?: string;
    /** Explicit user action: overrides busy-lease refusals for lifecycle mutations. */
    readonly userAction?: boolean;
    /** Cancellation for the backend call (admission itself is not cancellable). */
    readonly signal?: AbortSignal;
}
/** Data a removal preview reports before the destructive call. */
export interface RemovalPreview {
    readonly environmentId: EnvironmentId;
    readonly containerId: string;
    readonly volumeName: string;
    readonly networkName: string;
    readonly displayName?: string;
    /** Host directories that will be UNMOUNTED but never deleted. */
    readonly hostMounts: readonly string[];
    /** Sessions currently bound to this environment. */
    readonly boundSessions: readonly string[];
    /** Token proving the caller saw this preview; single-use, resource-bound. */
    readonly deleteVolumes: boolean;
    readonly confirmToken: string;
    /** Wall time after which the token stops being accepted (staleness bound). */
    readonly expiresAt: number;
}
/** A lease shared by guest executions and lifecycle mutations. */
export interface ExecutionLedger {
    /** Acquire before guest work and release after all effects settle. */
    acquireExecution(environmentId: EnvironmentId, name: string): Promise<() => void>;
    /** Hold admission against new execution leases for the entire lifecycle mutation. */
    withMutation<T>(environmentId: EnvironmentId, override: boolean, job: () => Promise<T>): Promise<{
        readonly kind: 'executed';
        readonly value: T;
    } | {
        readonly kind: 'busy';
        readonly names: readonly string[];
    }>;
}
/** Process-local lease coordinator shared by manager and guest tool adapter. */
export declare class ExecutionLeaseRegistry implements ExecutionLedger {
    private readonly active;
    private chain;
    acquireExecution(environmentId: EnvironmentId, name: string): Promise<() => void>;
    withMutation<T>(environmentId: EnvironmentId, override: boolean, job: () => Promise<T>): Promise<{
        readonly kind: 'executed';
        readonly value: T;
    } | {
        readonly kind: 'busy';
        readonly names: readonly string[];
    }>;
    private serialize;
}
/** Manager dependencies. */
export interface ManagerPorts {
    readonly inventory: Inventory;
    readonly driver: EnvironmentBackendDriver;
    readonly bindings: BindingRegistry;
    readonly mountPolicy: MountPolicyContext;
    readonly budget: HostBudget;
    readonly executions?: ExecutionLedger;
    readonly newId?: () => EnvironmentId;
    readonly now?: () => number;
    /** How long a removal preview token stays valid (default 120s). */
    readonly previewTtlMs?: number;
}
/**
 * The serialized multi-environment manager.
 */
export declare class EnvironmentManager implements EnvironmentRegistry {
    private readonly ports;
    private chain;
    private initialized;
    private readonly previews;
    private readonly now;
    private readonly newId;
    private readonly previewTtlMs;
    constructor(ports: ManagerPorts);
    list(signal: AbortSignal): Promise<readonly EnvironmentDescriptor[]>;
    get(id: EnvironmentId): EnvironmentDescriptor | undefined;
    binding(sessionKey: string): EnvironmentBinding | undefined;
    /** Return a durable operation whose backend outcome is still unknown. */
    uncertainty(id: EnvironmentId): PersistedOperation | undefined;
    /** Read one operation by identity (state observable to the UI). */
    operation(id: string): PersistedOperation | undefined;
    /** Operations for one environment, oldest first. */
    operationsFor(environmentId: EnvironmentId): readonly PersistedOperation[];
    /**
     * Crash recovery: reconcile the inventory against the backend and settle
     * operations left unsettled by an interruption. Must run before any new
     * mutation. Never starts, unpauses, or deletes backend resources on its
     * own; interrupted creates require an explicit recovery request.
     * Deletions may be settled only when confirmed by read-only inspection.
     * @param signal - cancellation.
     */
    initialize(signal: AbortSignal): Promise<void>;
    /**
     * Create a new environment. Validates mounts against the canonical policy
     * and the host budget BEFORE admitting, then runs the backend create.
     * @param input - creation options (explicit mounts, limits, ports).
     * @param options - idempotency key for duplicate-request dedup.
     * @returns the settled create operation (target captured on success).
     */
    create(input: EnvironmentCreateInput, options?: MutationOptions): Promise<EnvironmentOperation>;
    /** Explicitly retry exactly one durable create intent with its original identity. */
    recoverCreate(operationId: string, options?: Omit<MutationOptions, 'idempotencyKey'>): Promise<EnvironmentOperation>;
    private createBudgetRefusal;
    private hasUnmeasuredCreateIntent;
    /** Count unregistered create intents as reserved until resolved. */
    private budgetUsage;
    /** Start a stopped environment (never resumes a paused one). */
    start(id: EnvironmentId, options?: MutationOptions): Promise<EnvironmentOperation>;
    /** Stop the container; the workspace volume and container stay for restart. */
    stop(id: EnvironmentId, options?: MutationOptions): Promise<EnvironmentOperation>;
    /** Freeze the container, keeping its RAM. Never auto-resumed. */
    pause(id: EnvironmentId, options?: MutationOptions): Promise<EnvironmentOperation>;
    /** Unfreeze a paused environment (explicit user or admitted agent action). */
    resume(id: EnvironmentId, options?: MutationOptions): Promise<EnvironmentOperation>;
    /**
     * Update CPU/RAM within the backend's enforced knobs; disk quota refuses.
     * The aggregate budget check runs inside the SAME serialization as creates:
     * concurrent updates cannot both pass against the same committed total, and
     * a failed driver call leaves the persisted limits untouched (the outcome
     * commits only with a completed operation).
     */
    updateLimits(id: EnvironmentId, limits: EnvironmentLimits, options?: MutationOptions): Promise<EnvironmentOperation>;
    /**
     * Preview what removing an environment involves. The target is CAPTURED
     * FROM THE LIVE BACKEND (inspected ids and identity, never reconstructed
     * from the inventory record), and the full record snapshot is stored so
     * any later replacement invalidates the token. The token must be presented
     * to {@link remove}; it is single-use and expires. Host directories are
     * listed as unmounted, never deleted.
     * @param id - the environment.
     * @param deleteVolumes - whether the preview approves deletion of the volume.
     * @returns the preview with its single-use confirmation token.
     * @throws when the backend cannot present a verified owned target.
     */
    previewRemoval(id: EnvironmentId, deleteVolumes?: boolean): Promise<RemovalPreview>;
    /**
     * Remove an environment after preview and confirmation. Every check and
     * effect runs inside the serialized admission: the token is matched,
     * expiry-checked, and consumed exactly once; the stored record snapshot is
     * compared atomically against the live record; the live target identity is
     * re-acquired and must match the approved snapshot; container, network,
     * and volume ownership are re-verified with the driver immediately before
     * dispatch. A missing resource is accepted for idempotent cleanup; a
     * foreign, replaced, or unconfirmable resource refuses the removal with no
     * engine call. Host directories are never deleted.
     * @param id - the environment.
     * @param confirmToken - token from {@link previewRemoval} (single use).
     * @param deleteVolumes - explicit choice about the persistent named volume.
     * @param options - mutation options; busy leases refuse unless `userAction`.
     * @returns the settled remove operation.
     */
    remove(id: EnvironmentId, confirmToken: string, deleteVolumes: boolean, options?: MutationOptions): Promise<EnvironmentOperation>;
    /**
     * Bind a conversation to an environment (explicit selection). The binding
     * event is emitted INSIDE the serialized admission, after the environment
     * is validated and the request deduplicated — never before. Refuses while
     * another conversation actively uses the environment unless shared reuse is
     * explicit. In-flight operations keep their captured target regardless.
     */
    bind(sessionKey: string, environmentId: EnvironmentId, generation: number, options?: MutationOptions & {
        allowShared?: boolean;
    }): Promise<EnvironmentOperation>;
    /** Unbind a conversation from its environment (explicit user action). */
    unbind(sessionKey: string, options?: MutationOptions): Promise<EnvironmentOperation>;
    /**
     * Import an existing container as an environment after explicit identity
     * verification. The original container, its ports, and its data are
     * preserved: import writes inventory only, it never recreates or restarts.
     * @param id - durable id to assign.
     * @param descriptor - verified inventory record (ownership 'imported').
     */
    importEnvironment(id: EnvironmentId, descriptor: EnvironmentDescriptor): Promise<void>;
    private requireInitialized;
    private requireRecord;
    /**
     * Acquire the verified mutation target through the driver's acquisition
     * API. There is NO fallback that reconstructs a target from the inventory
     * record: a driver that cannot verify ownership cannot mutate resources.
     * A missing resource refuses normal mutations (idempotent cleanup paths
     * decide separately); foreign/conflicting/unknown always refuse.
     */
    private acquireVerifiedTarget;
    private stateOperation;
    /** Synthetic failed operation for a refusal (never persisted). */
    private refusalOf;
    /**
     * Admit one operation. Inside the serialized queue, in order: cancellation,
     * idempotency dedup WITH canonical-signature comparison, pre-checks,
     * target capture, requested/running journal writes, durable effects, the
     * driver call, and finally one commit of settlement and inventory outcome.
     */
    private admit;
    /**
     * Pure descriptor transition a completed operation's outcome applies. The
     * manager folds it into the SAME durable transaction that writes the
     * settled record, so the journal and the inventory never disagree.
     */
    private outcomeFor;
    /**
     * Recover a completed legacy operation whose descriptor transition was lost.
     * Create intents are verified or re-executed through the backend first.
     */
    private reconcileCompleted;
    /** Serialize one job behind every earlier admitted mutation. */
    private serialize;
}
//# sourceMappingURL=lifecycle.d.ts.map