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

import { randomUUID } from 'node:crypto'
import type {
  EnvironmentBackendDriver,
  EnvironmentBinding,
  EnvironmentCreateInput,
  EnvironmentDescriptor,
  EnvironmentId,
  EnvironmentLimits,
  EnvironmentOperation,
  EnvironmentRegistry,
  EnvironmentTarget,
  ResourceVerification,
} from './environments.ts'
import { asEnvironmentId } from './environments.ts'
import type { Inventory, PersistedOperation } from './inventory.ts'
import { canonicalJson, operationRequestSignature } from './inventory.ts'
import type { BindingRegistry } from './binding.ts'
import type { MountPolicyContext } from './mount-policy.ts'

/** Host budget the manager refuses to exceed when creating or resizing environments. */
export interface HostBudget {
  readonly totalCpuMillis: number
  readonly totalMemoryBytes: number
}

/** Options for one lifecycle mutation call. */
export interface MutationOptions {
  /** Caller dedup key: a repeated request with the same key returns the same operation. */
  readonly idempotencyKey?: string
  /** Explicit user action: overrides busy-lease refusals for lifecycle mutations. */
  readonly userAction?: boolean
  /** Cancellation for the backend call (admission itself is not cancellable). */
  readonly signal?: AbortSignal
}

/** Data a removal preview reports before the destructive call. */
export interface RemovalPreview {
  readonly environmentId: EnvironmentId
  readonly containerId: string
  readonly volumeName: string
  readonly networkName: string
  readonly displayName?: string
  /** Host directories that will be UNMOUNTED but never deleted. */
  readonly hostMounts: readonly string[]
  /** Sessions currently bound to this environment. */
  readonly boundSessions: readonly string[]
  /** Token proving the caller saw this preview; single-use, resource-bound. */
  readonly deleteVolumes: boolean
  readonly confirmToken: string
  /** Wall time after which the token stops being accepted (staleness bound). */
  readonly expiresAt: number
}

/** A lease shared by guest executions and lifecycle mutations. */
export interface ExecutionLedger {
  /** Acquire before guest work and release after all effects settle. */
  acquireExecution(environmentId: EnvironmentId, name: string): Promise<() => void>
  /** Hold admission against new execution leases for the entire lifecycle mutation. */
  withMutation<T>(environmentId: EnvironmentId, override: boolean, job: () => Promise<T>): Promise<
    { readonly kind: 'executed'; readonly value: T } | { readonly kind: 'busy'; readonly names: readonly string[] }
  >
}

/** Process-local lease coordinator shared by manager and guest tool adapter. */
export class ExecutionLeaseRegistry implements ExecutionLedger {
  private readonly active = new Map<EnvironmentId, Map<symbol, string>>()
  private chain: Promise<unknown> = Promise.resolve()

  async acquireExecution(environmentId: EnvironmentId, name: string): Promise<() => void> {
    return await this.serialize(() => {
      const token = Symbol(name)
      const entries = this.active.get(environmentId) ?? new Map<symbol, string>()
      entries.set(token, name)
      this.active.set(environmentId, entries)
      let released = false
      return Promise.resolve(() => {
        if (released) return
        released = true
        entries.delete(token)
        if (entries.size === 0 && this.active.get(environmentId) === entries) this.active.delete(environmentId)
      })
    })
  }

  async withMutation<T>(environmentId: EnvironmentId, override: boolean, job: () => Promise<T>): Promise<
    { readonly kind: 'executed'; readonly value: T } | { readonly kind: 'busy'; readonly names: readonly string[] }
  > {
    return await this.serialize(async () => {
      const names = [...(this.active.get(environmentId)?.values() ?? [])]
      if (names.length > 0 && !override) return { kind: 'busy', names }
      return { kind: 'executed', value: await job() }
    })
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job, job)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Manager dependencies. */
export interface ManagerPorts {
  readonly inventory: Inventory
  readonly driver: EnvironmentBackendDriver
  readonly bindings: BindingRegistry
  readonly mountPolicy: MountPolicyContext
  readonly budget: HostBudget
  readonly executions?: ExecutionLedger
  readonly newId?: () => EnvironmentId
  readonly now?: () => number
  /** How long a removal preview token stays valid (default 120s). */
  readonly previewTtlMs?: number
}

/** A refusal produced inside the serialized admission, before any effect. */
interface AdmissionRefusal {
  readonly error: string
  readonly errorCode: string
}

/** Outcome of acquiring the verified mutation target inside admission. */
interface TargetCaptureOutcome {
  readonly target?: EnvironmentTarget
  readonly refusal?: AdmissionRefusal
}

/** Checks and effects an admission runs inside the serialized queue. */
interface AdmissionChecks {
  readonly signature?: string
  readonly recoverOperationId?: string
  /** Synchronous validation inside admission (budget, leases, preview match). */
  readonly preCheck?: (operation: PersistedOperation) => AdmissionRefusal | undefined
  /** Durable effects (binding events, token consumption, ownership re-verification). */
  readonly effects?: (signal: AbortSignal) => Promise<AdmissionRefusal | undefined>
  /** Verified target acquisition for operations that address existing resources. */
  readonly target?: (signal: AbortSignal) => Promise<TargetCaptureOutcome>
}

/** The manager's view of one issued removal preview (full approved snapshot). */
interface StoredPreview {
  readonly environmentId: EnvironmentId
  readonly token: string
  /** Complete record snapshot shown to the user; any change invalidates it. */
  readonly descriptor: EnvironmentDescriptor
  /** Inspected target captured at preview time (immutable approved destination). */
  readonly target: EnvironmentTarget
  readonly capturedAt: number
  readonly deleteVolumes: boolean
  readonly bindingRevision: number
}

function isResourceMutation(kind: EnvironmentOperation['kind']): boolean {
  return kind === 'start' || kind === 'stop' || kind === 'pause' || kind === 'resume' || kind === 'update-limits' || kind === 'remove'
}

function totalCommitted(records: readonly EnvironmentDescriptor[]): { cpuMillis: number; memoryBytes: number } {
  return records.reduce(
    (sum, record) => ({ cpuMillis: sum.cpuMillis + record.limits.cpuMillis, memoryBytes: sum.memoryBytes + record.limits.memoryBytes }),
    { cpuMillis: 0, memoryBytes: 0 },
  )
}


/** The preview requires the entire inspected target to match, except capture time. */
function sameApprovedIdentity(approved: EnvironmentTarget, live: EnvironmentTarget): boolean {
  return canonicalJson({ ...approved, capturedAt: 0 }) === canonicalJson({ ...live, capturedAt: 0 })
}

/**
 * The serialized multi-environment manager.
 */
export class EnvironmentManager implements EnvironmentRegistry {
  private chain: Promise<unknown> = Promise.resolve()
  private initialized = false
  private readonly previews = new Map<EnvironmentId, StoredPreview>()
  private readonly now: () => number
  private readonly newId: () => EnvironmentId
  private readonly previewTtlMs: number

  constructor(private readonly ports: ManagerPorts) {
    this.now = ports.now ?? (() => Date.now())
    this.newId = ports.newId ?? (() => asEnvironmentId(`env-${randomUUID().slice(0, 13)}`))
    this.previewTtlMs = ports.previewTtlMs ?? 120_000
  }

  // ------------------------------------------------------------ registry face

  list(signal: AbortSignal): Promise<readonly EnvironmentDescriptor[]> {
    signal.throwIfAborted()
    return Promise.resolve(this.ports.inventory.list())
  }

  get(id: EnvironmentId): EnvironmentDescriptor | undefined {
    return this.ports.inventory.get(id)
  }

  binding(sessionKey: string): EnvironmentBinding | undefined {
    return this.ports.bindings.binding(sessionKey)
  }

  /** Return a durable operation whose backend outcome is still unknown. */
  uncertainty(id: EnvironmentId): PersistedOperation | undefined {
    return this.ports.inventory.operationsFor(id).find(operation =>
      (operation.state === 'running' && isResourceMutation(operation.kind)) ||
      (operation.state === 'failed' && operation.errorCode === 'outcome-unknown'),
    )
  }

  /** Read one operation by identity (state observable to the UI). */
  operation(id: string): PersistedOperation | undefined {
    return this.ports.inventory.operation(id)
  }

  /** Operations for one environment, oldest first. */
  operationsFor(environmentId: EnvironmentId): readonly PersistedOperation[] {
    return this.ports.inventory.operationsFor(environmentId)
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Crash recovery: reconcile the inventory against the backend and settle
   * operations left unsettled by an interruption. Must run before any new
   * mutation. Never starts, unpauses, or deletes backend resources on its
   * own; interrupted creates require an explicit recovery request.
   * Deletions may be settled only when confirmed by read-only inspection.
   * @param signal - cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    await this.serialize(async () => {
      this.initialized = false
      await this.ports.inventory.initialize()
      await this.ports.driver.reconcile(signal)
      // Structural: drivers that report the three-way split support evidence
      // for interrupted creates; the manager stays backend-agnostic.
      // 1) Completed-but-uncommitted (legacy split writes interrupted between
      // the settled record and the descriptor): re-apply the durable outcome
      // deterministically. The atomic commit below makes this impossible for
      // new operations; this pass heals records from older generations.
      const completedOperations = this.ports.inventory.completedOperations()
      for (const completed of [...completedOperations.filter(op => op.kind !== 'remove'), ...completedOperations.filter(op => op.kind === 'remove')]) {
        if (completed.kind === 'create' && completedOperations.some(op => op.kind === 'remove' && op.environmentId === completed.environmentId)) continue
        await this.reconcileCompleted(completed)
      }
      // 2) Operations left pending by the interruption.
      for (const pending of this.ports.inventory.pendingOperations()) {
        if (pending.kind === 'create' && pending.payload?.kind === 'create') {
          await this.ports.inventory.putOperation({
            ...pending, state: 'failed', errorCode: 'recovery-required',
            error: 'create was interrupted; explicitly recover this intent to continue', settledAt: this.now(),
          })
          continue
        }
        if (pending.kind === 'create') {
          // Legacy record whose create intent was never persisted (older
          // schema stripped the payload): the intent cannot be re-executed
          // and an adopted descriptor must not be reconstructed with empty
          // mounts. Fail closed; reconciliation still reports any owned
          // container for an explicit user decision.
          await this.ports.inventory.putOperation({
            ...pending,
            state: 'failed',
            error: 'interrupted before completion; the create intent was not persisted, so it was not re-executed; any owned container is reported by reconciliation for an explicit decision',
            errorCode: 'interrupted',
            settledAt: this.now(),
          })
          continue
        }
        if (pending.kind === 'remove' && pending.target !== undefined && pending.payload?.kind === 'remove' && this.ports.driver.verifyTarget !== undefined) {
          const observed = await this.ports.driver.verifyTarget(pending.target, signal)
          if (observed.container.kind === 'missing' && observed.network.kind === 'missing' &&
            (!pending.payload.deleteVolumes || observed.volume.kind === 'missing')) {
            const completed: PersistedOperation = { ...pending, state: 'completed', settledAt: this.now() }
            await this.ports.inventory.commitSettlement(completed, this.outcomeFor(completed))
            continue
          }
        }
        // An operation that never reached the backend (or whose backend result
        // was lost) is settled as failed with an explicit interruption code;
        // the caller can retry with a fresh idempotency key.
        const uncertain = pending.state === 'running' && isResourceMutation(pending.kind)
        await this.ports.inventory.putOperation({
          ...pending,
          state: 'failed',
          error: uncertain ? 'backend outcome is unknown after interruption; verified reconciliation is required' : 'interrupted before backend dispatch',
          errorCode: uncertain ? 'outcome-unknown' : 'interrupted',
          settledAt: this.now(),
        })
      }
      this.initialized = true
    })
  }

  /**
   * Create a new environment. Validates mounts against the canonical policy
   * and the host budget BEFORE admitting, then runs the backend create.
   * @param input - creation options (explicit mounts, limits, ports).
   * @param options - idempotency key for duplicate-request dedup.
   * @returns the settled create operation (target captured on success).
   */
  async create(input: EnvironmentCreateInput, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    const id = this.newId()
    const operation: PersistedOperation = {
      id: randomUUID(), environmentId: id, kind: 'create', state: 'requested',
      payload: { kind: 'create', input }, requestedAt: this.now(),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    }
    return await this.admit(operation, options, { preCheck: current => {
      // Docker's internal-only bridge does not reliably publish host ports
      // (including OrbStack on macOS). Refuse before allocating anything;
      // never silently grant network access the owner did not select.
      if (!input.internetAccess) return { error: 'Desktop access without internet is not supported by this Docker backend. Enable internet access to create an environment.', errorCode: 'unsupported-network' }
      return this.createBudgetRefusal(input, current.id)
    } })
  }

  /** Explicitly retry exactly one durable create intent with its original identity. */
  async recoverCreate(operationId: string, options: Omit<MutationOptions, 'idempotencyKey'> = {}): Promise<EnvironmentOperation> {
    this.requireInitialized()
    const existing = this.ports.inventory.operation(operationId)
    if (existing === undefined || existing.kind !== 'create' || existing.payload?.kind !== 'create') {
      throw new Error('wrapvm-isolate: the requested durable create intent is unavailable')
    }
    const input = existing.payload.input
    return await this.admit(existing, options, {
      recoverOperationId: operationId,
      preCheck: (current) => {
        if (this.ports.inventory.get(current.environmentId) !== undefined) {
          return { error: 'an inventory descriptor already exists for this create intent', errorCode: 'resource-conflict' }
        }
        return this.createBudgetRefusal(input, current.id)
      },
    })
  }

  private createBudgetRefusal(input: EnvironmentCreateInput, excludeOperationId: string): AdmissionRefusal | undefined {
    if (this.hasUnmeasuredCreateIntent()) {
      return { error: 'an interrupted create has unknown limits; aggregate budget cannot be verified', errorCode: 'outcome-unknown' }
    }
    const committed = this.budgetUsage(excludeOperationId)
    if (committed.cpuMillis + input.limits.cpuMillis > this.ports.budget.totalCpuMillis) {
      return { error: 'the requested CPU budget exceeds the host budget', errorCode: 'budget-exceeded' }
    }
    if (committed.memoryBytes + input.limits.memoryBytes > this.ports.budget.totalMemoryBytes) {
      return { error: 'the requested memory budget exceeds the host budget', errorCode: 'budget-exceeded' }
    }
    return undefined
  }

  private hasUnmeasuredCreateIntent(): boolean {
    const operations = this.ports.inventory.allOperations()
    const removed = new Set(operations.filter(operation => operation.kind === 'remove' && operation.state === 'completed')
      .map(operation => operation.environmentId))
    return operations.some(operation => operation.kind === 'create' && operation.payload?.kind !== 'create' &&
      !removed.has(operation.environmentId) && this.ports.inventory.get(operation.environmentId) === undefined)
  }

  /** Count unregistered create intents as reserved until resolved. */
  private budgetUsage(excludeOperationId?: string): { cpuMillis: number; memoryBytes: number } {
    const records = this.ports.inventory.list()
    const total = totalCommitted(records)
    const counted = new Set(records.map(record => record.id))
    let { cpuMillis, memoryBytes } = total
    const operations = this.ports.inventory.allOperations()
    const removed = new Set(operations.filter(operation => operation.kind === 'remove' && operation.state === 'completed')
      .map(operation => operation.environmentId))
    for (const operation of operations) {
      if (operation.id === excludeOperationId || operation.kind !== 'create' || operation.payload?.kind !== 'create' ||
        counted.has(operation.environmentId) || removed.has(operation.environmentId)) continue
      // A failed or interrupted create may already have allocated resources.
      counted.add(operation.environmentId)
      cpuMillis += operation.payload.input.limits.cpuMillis
      memoryBytes += operation.payload.input.limits.memoryBytes
    }
    return { cpuMillis, memoryBytes }
  }

  /** Start a stopped environment (never resumes a paused one). */
  async start(id: EnvironmentId, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    return await this.stateOperation(id, 'start', options)
  }

  /** Stop the container; the workspace volume and container stay for restart. */
  async stop(id: EnvironmentId, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    return await this.stateOperation(id, 'stop', options)
  }

  /** Freeze the container, keeping its RAM. Never auto-resumed. */
  async pause(id: EnvironmentId, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    return await this.stateOperation(id, 'pause', options)
  }

  /** Unfreeze a paused environment (explicit user or admitted agent action). */
  async resume(id: EnvironmentId, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    return await this.stateOperation(id, 'resume', options)
  }

  /**
   * Update CPU/RAM within the backend's enforced knobs; disk quota refuses.
   * The aggregate budget check runs inside the SAME serialization as creates:
   * concurrent updates cannot both pass against the same committed total, and
   * a failed driver call leaves the persisted limits untouched (the outcome
   * commits only with a completed operation).
   */
  async updateLimits(id: EnvironmentId, limits: EnvironmentLimits, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    const operation: PersistedOperation = {
      id: randomUUID(),
      environmentId: id,
      kind: 'update-limits',
      state: 'requested',
      payload: { kind: 'update-limits', limits },
      requestedAt: this.now(),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    }
    return await this.admit(operation, options, {
      preCheck: () => {
        const record = this.ports.inventory.get(id)
        if (record === undefined) return { error: `unknown environment ${id}`, errorCode: 'unknown-environment' }
        if (this.hasUnmeasuredCreateIntent()) {
          return { error: 'an interrupted create has unknown limits; aggregate budget cannot be verified', errorCode: 'outcome-unknown' }
        }
        const committed = this.budgetUsage()
        const othersCpu = committed.cpuMillis - record.limits.cpuMillis
        const othersMemory = committed.memoryBytes - record.limits.memoryBytes
        if (othersCpu + limits.cpuMillis > this.ports.budget.totalCpuMillis) {
          return { error: `the updated CPU budget exceeds the host budget (${othersCpu + limits.cpuMillis} > ${this.ports.budget.totalCpuMillis} millicores)`, errorCode: 'budget-exceeded' }
        }
        if (othersMemory + limits.memoryBytes > this.ports.budget.totalMemoryBytes) {
          return { error: `the updated memory budget exceeds the host budget (${othersMemory + limits.memoryBytes} > ${this.ports.budget.totalMemoryBytes} bytes)`, errorCode: 'budget-exceeded' }
        }
        return undefined
      },
      target: signal => this.acquireVerifiedTarget(id, signal),
    })
  }

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
  async previewRemoval(id: EnvironmentId, deleteVolumes = false): Promise<RemovalPreview> {
    this.requireInitialized()
    const result = await this.ports.bindings.withUsage(id, async (usage) => {
      const record = this.requireRecord(id)
      if (this.uncertainty(id) !== undefined) throw new Error(`wrapvm-isolate: environment ${id} has an unknown operation outcome`)
      let captured: TargetCaptureOutcome
      try {
        captured = await this.acquireVerifiedTarget(id, usage.signal)
      } catch (error) {
        if (usage.signal.aborted) throw new Error('wrapvm-isolate: binding index is incomplete; preview again after restoration')
        throw error
      }
      if (usage.signal.aborted) throw new Error('wrapvm-isolate: binding index is incomplete; preview again after restoration')
      const target = captured.target
      if (target === undefined) throw new Error(`wrapvm-isolate: cannot preview removal of ${id}: ${captured.refusal?.error ?? 'no verified target'}`)
      const token = randomUUID()
      const capturedAt = this.now()
      this.previews.set(id, {
        environmentId: id, token, descriptor: record, target, capturedAt, deleteVolumes, bindingRevision: usage.revision,
      })
      return {
        environmentId: id, containerId: target.containerId, volumeName: target.volumeName, networkName: target.networkName,
        ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
        hostMounts: record.mounts.map(mount => mount.hostPath), boundSessions: usage.sessions,
        deleteVolumes, confirmToken: token, expiresAt: capturedAt + this.previewTtlMs,
      }
    })
    if (result.kind === 'incomplete') throw new Error('wrapvm-isolate: binding index is incomplete; restore every Session before preview')
    return result.value
  }

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
  async remove(
    id: EnvironmentId, confirmToken: string, deleteVolumes: boolean, options: MutationOptions = {},
  ): Promise<EnvironmentOperation> {
    const operation: PersistedOperation = {
      id: randomUUID(),
      environmentId: id,
      kind: 'remove',
      state: 'requested',
      payload: { kind: 'remove', deleteVolumes },
      requestedAt: this.now(),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    }
    // The approved snapshot is bound inside admission (effects) and carried
    // to the target step: a concurrent remove holding the SAME token can
    // never pass the checks against a stale reference to the consumed entry.
    let approved: StoredPreview | undefined
    return await this.admit(operation, options, {
      preCheck: () => {
        const live = this.previews.get(id)
        if (live === undefined || live.token !== confirmToken) {
          return { error: 'removal requires a current preview: call previewRemoval and pass its token', errorCode: 'preview-required' }
        }
        if (live.bindingRevision !== this.ports.bindings.usageRevision()) return { error: 'bindings changed; preview again', errorCode: 'preview-stale' }
        if (live.deleteVolumes !== deleteVolumes) return { error: 'the volume deletion choice changed; preview again', errorCode: 'preview-stale' }
        if (this.now() - live.capturedAt >= this.previewTtlMs) {
          return { error: 'the removal preview expired; preview the removal again', errorCode: 'preview-expired' }
        }
        const current = this.ports.inventory.get(id)
        if (current === undefined) return { error: `unknown environment ${id}`, errorCode: 'unknown-environment' }
        if (canonicalJson(current) !== canonicalJson(live.descriptor)) {
          return { error: 'the environment record changed after the preview (replacement or reconfiguration); preview the removal again', errorCode: 'preview-stale' }
        }
        approved = live
        return undefined
      },
      effects: async (signal) => {
        // Consume the token exactly once, inside admission, before any engine
        // call: a replayed remove can never reuse an approved preview.
        const live = this.previews.get(id)
        if (live === undefined || live.token !== confirmToken) {
          return { error: 'removal requires a current preview: call previewRemoval and pass its token', errorCode: 'preview-required' }
        }
        this.previews.delete(id)
        approved = live
        const driver = this.ports.driver
        if (driver.verifyTarget === undefined) {
          return { error: 'the backend driver cannot re-verify resource ownership before deletion (verifyTarget unavailable); refusing destructive removal', errorCode: 'verification-unavailable' }
        }
        const verification = await driver.verifyTarget(live.target, signal)
        for (const [resource, result] of Object.entries(verification) as readonly (readonly [string, ResourceVerification])[]) {
          const refusal = verificationRefusal(resource, result)
          if (refusal !== undefined) return refusal
        }
        return undefined
      },
      target: async (signal) => {
        if (approved === undefined) return { refusal: { error: 'removal requires a current preview', errorCode: 'preview-required' } }
        const captured = await this.acquireVerifiedTarget(id, signal)
        if (captured.refusal?.errorCode === 'resource-missing') {
          // Idempotent cleanup: the container is gone; the approved target's
          // network/volume names still need removal (the driver re-verifies
          // each resource's ownership itself before touching it).
          return { target: approved.target }
        }
        if (captured.refusal !== undefined) return { refusal: captured.refusal }
        if (captured.target === undefined) return { refusal: { error: 'no verified target for removal', errorCode: 'resource-unverified' } }
        if (!sameApprovedIdentity(approved.target, captured.target)) {
          return { refusal: { error: 'the backend resources changed after the preview (container, network, or volume was replaced); preview the removal again', errorCode: 'preview-stale' } }
        }
        // The approved snapshot stays the operation's target: the call
        // addresses exactly what the user confirmed.
        return { target: approved.target }
      },
    })
  }

  /**
   * Bind a conversation to an environment (explicit selection). The binding
   * event is emitted INSIDE the serialized admission, after the environment
   * is validated and the request deduplicated — never before. Refuses while
   * another conversation actively uses the environment unless shared reuse is
   * explicit. In-flight operations keep their captured target regardless.
   */
  async bind(
    sessionKey: string, environmentId: EnvironmentId, generation: number, options: MutationOptions & { allowShared?: boolean } = {},
  ): Promise<EnvironmentOperation> {
    const operation: PersistedOperation = {
      id: randomUUID(),
      environmentId,
      kind: 'bind',
      state: 'requested',
      payload: { kind: 'bind', sessionKey, generation },
      requestedAt: this.now(),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    }
    return await this.admit(operation, options, {
      signature: canonicalJson({ request: operationRequestSignature(operation), allowShared: options.allowShared === true }),
      preCheck: () => {
        if (this.ports.inventory.get(environmentId) === undefined) {
          return { error: `unknown environment ${environmentId}`, errorCode: 'unknown-environment' }
        }
        return undefined
      },
      effects: async () => {
        try {
          await this.ports.bindings.bind(sessionKey, environmentId, generation, { allowShared: options.allowShared === true })
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error), errorCode: 'binding-conflict' }
        }
        return undefined
      },
    })
  }

  /** Unbind a conversation from its environment (explicit user action). */
  async unbind(sessionKey: string, options: MutationOptions = {}): Promise<EnvironmentOperation> {
    const previous = options.idempotencyKey === undefined ? undefined : this.ports.inventory.findByIdempotencyKey(options.idempotencyKey)
    const binding = this.ports.bindings.binding(sessionKey)
    if (binding === undefined && previous?.kind === 'unbind' && previous.payload?.kind === 'unbind' && previous.payload.sessionKey === sessionKey && previous.state === 'completed') return previous
    if (binding === undefined) {
      return {
        id: randomUUID(),
        environmentId: '' as EnvironmentId,
        kind: 'unbind',
        state: 'failed',
        error: 'the conversation has no environment binding',
        errorCode: 'not-bound',
        requestedAt: this.now(),
        settledAt: this.now(),
      }
    }
    const operation: PersistedOperation = {
      id: randomUUID(),
      environmentId: binding.environmentId,
      kind: 'unbind',
      state: 'requested',
      payload: { kind: 'unbind', sessionKey },
      requestedAt: this.now(),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    }
    return await this.admit(operation, options, {
      preCheck: () => {
        if (this.ports.bindings.binding(sessionKey)?.environmentId !== binding.environmentId) {
          return { error: 'the conversation has no environment binding', errorCode: 'not-bound' }
        }
        return undefined
      },
      effects: async () => {
        await this.ports.bindings.unbind(sessionKey)
        return undefined
      },
    })
  }

  /**
   * Import an existing container as an environment after explicit identity
   * verification. The original container, its ports, and its data are
   * preserved: import writes inventory only, it never recreates or restarts.
   * @param id - durable id to assign.
   * @param descriptor - verified inventory record (ownership 'imported').
   */
  async importEnvironment(id: EnvironmentId, descriptor: EnvironmentDescriptor): Promise<void> {
    this.requireInitialized()
    if (descriptor.ownership !== 'imported') throw new Error('wrapvm-isolate: imported records must carry ownership imported')
    if (this.ports.inventory.get(id) !== undefined) throw new Error(`wrapvm-isolate: environment ${id} already exists`)
    await this.ports.inventory.putDescriptor({ ...descriptor, id, ownership: 'imported' })
  }

  // ---------------------------------------------------------------- internal

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('wrapvm-isolate: initialize the manager before mutations')
  }

  private requireRecord(id: EnvironmentId): EnvironmentDescriptor {
    const record = this.ports.inventory.get(id)
    if (record === undefined) throw new Error(`wrapvm-isolate: unknown environment ${id}`)
    return record
  }

  /**
   * Acquire the verified mutation target through the driver's acquisition
   * API. There is NO fallback that reconstructs a target from the inventory
   * record: a driver that cannot verify ownership cannot mutate resources.
   * A missing resource refuses normal mutations (idempotent cleanup paths
   * decide separately); foreign/conflicting/unknown always refuse.
   */
  private async acquireVerifiedTarget(id: EnvironmentId, signal?: AbortSignal): Promise<TargetCaptureOutcome> {
    const driver = this.ports.driver
    if (driver.captureTarget === undefined) {
      return { refusal: { error: 'the backend driver cannot verify resource ownership (captureTarget unavailable); refusing to mutate unverified resources', errorCode: 'verification-unavailable' } }
    }
    const acquisition = await driver.captureTarget(id, signal ?? new AbortController().signal)
    switch (acquisition.kind) {
      case 'captured': {
        const record = this.ports.inventory.get(id)
        if (record === undefined || record.containerId !== acquisition.target.containerId) {
          return { refusal: { error: 'the inspected container differs from the inventory identity', errorCode: 'resource-conflict' } }
        }
        return { target: acquisition.target }
      }
      case 'absent':
        return { refusal: { error: `no backend resource claims environment ${id}`, errorCode: 'resource-missing' } }
      case 'foreign':
        return { refusal: { error: acquisition.reason, errorCode: 'resource-foreign' } }
      case 'conflicting':
        return { refusal: { error: acquisition.reason, errorCode: 'resource-conflict' } }
      case 'unknown':
        return { refusal: { error: acquisition.reason, errorCode: 'resource-unverified' } }
    }
  }

  private async stateOperation(id: EnvironmentId, kind: 'start' | 'stop' | 'pause' | 'resume', options: MutationOptions): Promise<EnvironmentOperation> {
    const operation: PersistedOperation = {
      id: randomUUID(),
      environmentId: id,
      kind,
      state: 'requested',
      payload: { kind },
      requestedAt: this.now(),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    }
    return await this.admit(operation, options, {
      preCheck: () => {
        if (this.ports.inventory.get(id) === undefined) return { error: `unknown environment ${id}`, errorCode: 'unknown-environment' }
        return undefined
      },
      target: signal => this.acquireVerifiedTarget(id, signal),
    })
  }

  /** Synthetic failed operation for a refusal (never persisted). */
  private refusalOf(operation: PersistedOperation, refusal: AdmissionRefusal): EnvironmentOperation {
    return {
      ...operation,
      state: 'failed',
      error: refusal.error,
      errorCode: refusal.errorCode,
      settledAt: this.now(),
    }
  }

  /**
   * Admit one operation. Inside the serialized queue, in order: cancellation,
   * idempotency dedup WITH canonical-signature comparison, pre-checks,
   * target capture, requested/running journal writes, durable effects, the
   * driver call, and finally one commit of settlement and inventory outcome.
   */
  private async admit(
    operation: PersistedOperation, options: MutationOptions, checks: AdmissionChecks = {},
  ): Promise<EnvironmentOperation> {
    return await this.serialize(async () => {
      this.requireInitialized()
      options.signal?.throwIfAborted()
      if ((operation.kind === 'bind' || operation.kind === 'unbind') && !this.ports.bindings.isComplete()) {
        return this.refusalOf(operation, { error: 'binding index is incomplete; restore every Session', errorCode: 'binding-incomplete' })
      }
      const signature = checks.signature ?? operationRequestSignature(operation)
      let base: PersistedOperation = { ...operation, requestSignature: signature }
      if (checks.recoverOperationId !== undefined) {
        const current = this.ports.inventory.operation(checks.recoverOperationId)
        if (current === undefined || current.kind !== 'create' || current.payload?.kind !== 'create') {
          return this.refusalOf(operation, { error: 'the requested create intent is unavailable', errorCode: 'recovery-unavailable' })
        }
        if (current.state === 'completed') return current
        if (current.state !== 'failed') return this.refusalOf(current, { error: 'the create intent is not settled', errorCode: 'recovery-unavailable' })
        base = {
          id: current.id, environmentId: current.environmentId, kind: current.kind, state: 'requested',
          ...(current.idempotencyKey !== undefined ? { idempotencyKey: current.idempotencyKey } : {}),
          payload: current.payload,
          ...(current.target !== undefined ? { target: current.target } : {}),
          ...(current.requestedAt !== undefined ? { requestedAt: current.requestedAt } : {}),
          requestSignature: operationRequestSignature(current),
        }
      }
      if (checks.recoverOperationId === undefined && operation.idempotencyKey !== undefined) {
        const existing = this.ports.inventory.findByIdempotencyKey(operation.idempotencyKey)
        if (existing !== undefined) {
          if ((existing.requestSignature ?? operationRequestSignature(existing)) !== signature) {
            return this.refusalOf(operation, {
              error: `the idempotency key '${operation.idempotencyKey}' was already used for a different request (${existing.kind} of ${existing.environmentId}); use a fresh key`,
              errorCode: 'idempotency-conflict',
            })
          }
          if (existing.state !== 'failed') return existing
          // A FAILED operation under the same key with the same semantic
          // request is re-executed as the SAME durable operation: the retry
          // keeps the environment identity, so a create adopts the network/
          // volume (and any container) its interrupted attempt already
          // created instead of orphaning them under a fresh id.
          base = {
            id: existing.id,
            environmentId: existing.environmentId,
            kind: existing.kind,
            state: 'requested',
            ...(existing.idempotencyKey !== undefined ? { idempotencyKey: existing.idempotencyKey } : {}),
            ...(existing.payload !== undefined ? { payload: existing.payload } : {}),
            ...(existing.target !== undefined ? { target: existing.target } : {}),
            ...(existing.requestedAt !== undefined ? { requestedAt: existing.requestedAt } : {}),
            requestSignature: signature,
          }
        }
      }
      if (operation.kind !== 'create' && operation.kind !== 'unbind' && this.uncertainty(base.environmentId) !== undefined) {
        return this.refusalOf(base, { error: 'a previous backend outcome is unknown; verified reconciliation is required', errorCode: 'outcome-unknown' })
      }
      if ((operation.kind === 'create' || operation.kind === 'update-limits') &&
        this.ports.inventory.list().some(record => this.uncertainty(record.id)?.kind === 'update-limits')) {
        return this.refusalOf(base, { error: 'an environment has unknown limits; aggregate budget cannot be verified', errorCode: 'outcome-unknown' })
      }
      const perform = async (bindingSignal?: AbortSignal): Promise<EnvironmentOperation> => {
        const signal = bindingSignal === undefined ? (options.signal ?? new AbortController().signal)
          : options.signal === undefined ? bindingSignal : AbortSignal.any([options.signal, bindingSignal])
        const incomplete = (): AdmissionRefusal | undefined => bindingSignal?.aborted === true
          ? { error: 'binding index became incomplete; restore every Session', errorCode: 'binding-incomplete' } : undefined
        const early = incomplete()
        if (early !== undefined) return this.refusalOf(base, early)
        const refusal = checks.preCheck?.(base)
        if (refusal !== undefined) return this.refusalOf(base, refusal)
        let admitted: PersistedOperation = base
        if (checks.target !== undefined) {
          let captured: TargetCaptureOutcome
          try {
            captured = await checks.target(signal)
          } catch (error) {
            const revoked = incomplete()
            if (revoked !== undefined) return this.refusalOf(base, revoked)
            throw error
          }
          const revoked = incomplete()
          if (revoked !== undefined) return this.refusalOf(base, revoked)
          if (captured.refusal !== undefined) return this.refusalOf(base, captured.refusal)
          if (captured.target === undefined) return this.refusalOf(base, { error: 'verified target missing', errorCode: 'resource-unverified' })
          admitted = { ...base, target: captured.target }
        }
        await this.ports.inventory.putOperation(admitted)
        const running: PersistedOperation = { ...admitted, state: 'running' }
        await this.ports.inventory.putOperation(running)
        const afterJournal = incomplete()
        if (afterJournal !== undefined) {
          const refused = { ...running, state: 'failed' as const, ...afterJournal, settledAt: this.now() }
          await this.ports.inventory.commitSettlement(refused)
          return refused
        }
        signal.throwIfAborted()
        if (checks.effects !== undefined) {
          let effectRefusal: AdmissionRefusal | undefined
          try {
            effectRefusal = await checks.effects(signal) ?? incomplete()
          } catch (error) {
            effectRefusal = incomplete()
            if (effectRefusal === undefined) throw error
          }
          if (effectRefusal !== undefined) {
            const refused = { ...running, state: 'failed' as const, ...effectRefusal, settledAt: this.now() }
            await this.ports.inventory.commitSettlement(refused)
            return refused
          }
        }
        // Binding events are the durable effect. Do not call a backend or
        // observe cancellation after committing the Session event.
        if (running.kind === 'bind' || running.kind === 'unbind') {
          const completed = { ...running, state: 'completed' as const, settledAt: this.now() }
          await this.ports.inventory.commitSettlement(completed)
          return completed
        }
        let settled: PersistedOperation
        let dispatched = false
        try {
          if (running.target !== undefined) {
            if (this.ports.driver.verifyTarget === undefined) {
              settled = { ...running, state: 'failed', error: 'backend cannot verify the target', errorCode: 'verification-unavailable', settledAt: this.now() }
            } else {
              const result = await this.ports.driver.verifyTarget(running.target, signal)
              const refusal = (Object.entries(result) as [string, ResourceVerification][]).map(([resource, value]) =>
                value.kind === 'missing' && running.kind !== 'remove'
                  ? { error: `${resource} is missing`, errorCode: 'resource-missing' }
                  : verificationRefusal(resource, value),
              ).find(value => value !== undefined)
              if (refusal === undefined && incomplete() === undefined) {
                dispatched = true
                settled = await this.ports.driver.run(running, signal)
              } else {
                settled = { ...running, state: 'failed', ...(refusal ?? incomplete()), settledAt: this.now() }
              }
            }
          } else {
            dispatched = true
            settled = await this.ports.driver.run(running, signal)
          }
        } catch (error) {
          if (options.signal?.aborted === true) throw error
          const revoked = incomplete()
          settled = {
            ...running,
            state: 'failed',
            error: revoked?.error ?? (error instanceof Error ? error.message : String(error)),
            errorCode: revoked?.errorCode ?? 'engine-error',
            settledAt: this.now(),
          }
        }
        if (dispatched && (settled.state === 'failed' || incomplete() !== undefined) && isResourceMutation(settled.kind)) {
          settled = { ...settled, state: 'failed', errorCode: 'outcome-unknown', error: `${settled.error ?? 'backend operation failed'}; verified reconciliation is required` }
        }
        if (settled.kind === 'create' && settled.state === 'completed' && settled.target === undefined) {
          settled = { ...running, state: 'failed', error: 'create completed without an inspected target', errorCode: 'resource-unverified', settledAt: this.now() }
        }
        await this.ports.inventory.commitSettlement(settled, this.outcomeFor(settled))
        return settled
      }
      if (checks.target === undefined) return await perform()
      const ledger = this.ports.executions
      if (ledger === undefined) return this.refusalOf(base, { error: 'execution lease coordinator is unavailable', errorCode: 'lease-unavailable' })
      const result = await ledger.withMutation(base.environmentId, options.userAction === true, async () => {
        if (!['stop', 'pause', 'remove', 'update-limits'].includes(base.kind)) return await perform()
        const usage = await this.ports.bindings.withUsage(base.environmentId, async (current) => {
          if (base.kind === 'remove' && current.sessions.length > 0) {
            return this.refusalOf(base, { error: `environment is selected by ${current.sessions.join(', ')}; unselect it before removal`, errorCode: 'binding-in-use' })
          }
          return await perform(current.signal)
        })
        return usage.kind === 'complete' ? usage.value : this.refusalOf(base, {
          error: 'binding index is incomplete; restore every Session before this operation', errorCode: 'binding-incomplete',
        })
      })
      return result.kind === 'executed' ? result.value : this.refusalOf(base, {
        error: `the environment has active executions (${result.names.join(', ')}); explicit user override is required`, errorCode: 'busy',
      })
    })
  }

  /**
   * Pure descriptor transition a completed operation's outcome applies. The
   * manager folds it into the SAME durable transaction that writes the
   * settled record, so the journal and the inventory never disagree.
   */
  private outcomeFor(operation: PersistedOperation): {
    readonly apply?: (environments: Record<string, EnvironmentDescriptor>) => Record<string, EnvironmentDescriptor>
    readonly pruneOperationsFor?: EnvironmentId
  } {
    if (operation.state !== 'completed') return {}
    const id = operation.environmentId
    switch (operation.kind) {
      case 'create': {
        const input = operation.payload?.kind === 'create' ? operation.payload.input : undefined
        const target = operation.target
        if (input === undefined || target === undefined) return {}
        return {
          apply: environments => ({
            ...environments,
            [id]: {
              id,
              backend: 'docker',
              containerId: target.containerId,
              ownership: 'plugin',
              image: input.image,
              digest: target.imageDigest ?? 'unobserved',
              createdAt: operation.requestedAt ?? this.now(),
              mounts: input.mounts,
              limits: input.limits,
              internetAccess: input.internetAccess,
              displayName: input.displayName,
              volumeName: target.volumeName,
              networkName: target.networkName,
              ports: target.ports,
              desiredPhase: 'running',
            },
          }),
        }
      }
      case 'start':
      case 'resume':
      case 'stop':
      case 'pause': {
        const desiredPhase = operation.kind === 'stop' ? 'stopped' : operation.kind === 'pause' ? 'paused' : 'running'
        return {
          apply: (environments) => {
            const record = environments[id]
            if (record === undefined) return environments
            return { ...environments, [id]: { ...record, desiredPhase } }
          },
        }
      }
      case 'update-limits': {
        const limits = operation.payload?.kind === 'update-limits' ? operation.payload.limits : undefined
        if (limits === undefined) return {}
        return {
          apply: (environments) => {
            const record = environments[id]
            if (record === undefined) return environments
            return { ...environments, [id]: { ...record, limits } }
          },
        }
      }
      case 'remove':
        return {
          apply: (environments) => {
            const kept: Record<string, EnvironmentDescriptor> = {}
            for (const [key, record] of Object.entries(environments)) {
              if (key !== id) kept[key] = record
            }
            return kept
          },
        }
      default:
        return {}
    }
  }

  /**
   * Recover a completed legacy operation whose descriptor transition was lost.
   * Create intents are verified or re-executed through the backend first.
   */
  private async reconcileCompleted(operation: PersistedOperation): Promise<void> {
    const { inventory } = this.ports
    const record = inventory.get(operation.environmentId)
    switch (operation.kind) {
      case 'create':
        if (record === undefined && operation.payload?.kind === 'create') {
          await inventory.putOperation({ ...operation, state: 'failed', errorCode: 'recovery-required',
            error: 'create outcome was not committed; explicitly recover this intent', settledAt: this.now() })
        }
        return
      case 'remove':
        if (record !== undefined) {
          // The backend already removed the resources; commit the record
          // deletion the interrupted split write left behind.
          await inventory.commitSettlement(operation, this.outcomeFor(operation))
        }
        return
      default:
        return
    }
  }

  /** Serialize one job behind every earlier admitted mutation. */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job, job)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** Map one per-resource verification to an admission refusal (missing is tolerated). */
function verificationRefusal(resource: string, result: ResourceVerification): AdmissionRefusal | undefined {
  switch (result.kind) {
    case 'owned':
    case 'missing':
      return undefined
    case 'foreign':
      return { error: `the ${resource} is not owned by this plugin: ${result.reason}`, errorCode: 'resource-foreign' }
    case 'conflicting':
      return { error: `the ${resource} no longer matches the approved target: ${result.reason}`, errorCode: 'resource-conflict' }
    case 'unknown':
      return { error: `the ${resource} ownership could not be confirmed: ${result.reason}`, errorCode: 'resource-unverified' }
  }
}
