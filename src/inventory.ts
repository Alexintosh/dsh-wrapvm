/**
 * Durable environment inventory.
 *
 * The inventory is the authoritative record of which environments this
 * plugin owns: identity, immutable container id, ownership labels, image
 * digest, desired configuration, and the operation log used for crash
 * recovery. It persists through the DSH storage domain (never browser local
 * state). This package declares the domain spec structurally and ships a
 * store port plus two implementations:
 *
 * - {@link MemoryInventoryStore} — tests and dry runs;
 * - {@link DomainInventoryStore} — package-local adapter over the DSH
 *   storage-domain `KvTable` face, storing one atomic snapshot record.
 *
 * Ownership is decided by labels plus immutable container ids, never by
 * container names. Reads validate every record and fail closed: a corrupt
 * record throws instead of silently shrinking the inventory.
 * @module
 */

import { z as validate } from 'zod'
import type { EnvironmentDescriptor, EnvironmentId, EnvironmentOperation } from './environments.ts'

/**
 * The durable operation record: the in-memory {@link EnvironmentOperation}
 * plus the canonical semantic request signature. The signature is what makes
 * an idempotency key safe to deduplicate against: two requests sharing a key
 * must carry the same kind, environment, and parameters, and the comparison
 * survives a crash because it is persisted with the record.
 */
export interface PersistedOperation extends EnvironmentOperation {
  /** Canonical signature of the semantic request (kind + environment + params). */
  readonly requestSignature?: string
}

/** Domain name for the inventory (matches the storage-domain unit-name rules). */
export const WRAPVM_ENVIRONMENT_DOMAIN = 'wrapvm_environments'
/** Inventory record format version. */
export const WRAPVM_INVENTORY_VERSION = 1

/** Label marking every backend resource this plugin owns. */
export const OWNERSHIP_LABEL = 'dsh.wrapvm.environment'
/** Label carrying the durable environment id on every owned resource. */
export const ENVIRONMENT_ID_LABEL = 'dsh.wrapvm.environment-id'

/** Ownership labels applied to containers, volumes, and networks of one environment. */
export function environmentLabels(id: EnvironmentId): Readonly<Record<string, string>> {
  return { [OWNERSHIP_LABEL]: '1', [ENVIRONMENT_ID_LABEL]: id }
}

/** Container name derived from the durable id (names stay disposable; ids own). */
export function containerNameFor(id: EnvironmentId): string {
  return `dsh-wrapvm-${id}`
}

export const environmentMountSchema = validate.object({
  hostPath: validate.string().min(1),
  guestPath: validate.string().startsWith('/'),
  access: validate.enum(['read-only', 'read-write']),
})

const positiveSafeInt = validate.number().refine(value => Number.isSafeInteger(value) && value >= 1, { message: 'must be a positive safe integer' })

export const environmentLimitsSchema = validate.object({
  cpuMillis: positiveSafeInt,
  memoryBytes: positiveSafeInt,
  diskBytes: positiveSafeInt.optional(),
})

export const environmentPortsSchema = validate.object({
  viewerPort: validate.int().min(1).max(65535),
  cdpPort: validate.int().min(1).max(65535),
})

/**
 * Ports as they appear inside a captured target or a create request: the
 * backend may not have resolved ephemeral loopback ports yet, so 0 is a
 * legal "unresolved" placeholder there (the driver refuses to settle one).
 */
const unresolvedPortsSchema = validate.object({
  viewerPort: validate.int().min(0).max(65535),
  cdpPort: validate.int().min(0).max(65535),
})

/** Persisted shape of a create request: the full intent, validated at the boundary. */
export const environmentCreateInputSchema = validate.object({
  displayName: validate.string().min(1),
  image: validate.string().min(1),
  limits: environmentLimitsSchema,
  internetAccess: validate.boolean(),
  mounts: validate.array(environmentMountSchema),
  ports: unresolvedPortsSchema.optional(),
})

/**
 * Persisted shape of an admission-captured target (immutable destination
 * snapshot). Passthrough on purpose: identity fields the backend adds at
 * capture (network id, volume driver, and any later creation-identity
 * fields) must survive persistence untouched — stripping them would silently
 * weaken preview invalidation and recovery after a reload.
 */
export const environmentTargetSchema = validate.object({
  environmentId: validate.string().min(3).max(64),
  containerId: validate.string().min(1),
  containerName: validate.string().min(1),
  networkName: validate.string().min(1),
  volumeName: validate.string().min(1),
  ports: unresolvedPortsSchema,
  imageDigest: validate.string().min(1).optional(),
  capturedAt: validate.number(),
  networkId: validate.string().min(1).optional(),
  volumeDriver: validate.string().min(1).optional(),
  volumeToken: validate.string().min(1).optional(),
  volumeCreatedAt: validate.string().min(1).optional(),
}).loose()

/** Persisted discriminated operation payload: every kind's full parameters. */
export const environmentOperationPayloadSchema = validate.discriminatedUnion('kind', [
  validate.object({ kind: validate.literal('create'), input: environmentCreateInputSchema }),
  validate.object({ kind: validate.literal('start') }),
  validate.object({ kind: validate.literal('stop') }),
  validate.object({ kind: validate.literal('pause') }),
  validate.object({ kind: validate.literal('resume') }),
  validate.object({ kind: validate.literal('bind'), sessionKey: validate.string().min(1), generation: validate.number().int() }),
  validate.object({ kind: validate.literal('unbind'), sessionKey: validate.string().min(1) }),
  validate.object({ kind: validate.literal('update-limits'), limits: environmentLimitsSchema }),
  validate.object({ kind: validate.literal('remove'), deleteVolumes: validate.boolean() }),
])

/** Stored descriptor record: the single source validated at the durable boundary. */
export const environmentDescriptorSchema = validate.object({
  id: validate.string().min(3).max(64),
  backend: validate.literal('docker'),
  containerId: validate.string().min(1),
  ownership: validate.enum(['plugin', 'imported']),
  image: validate.string().min(1),
  digest: validate.string().min(1),
  createdAt: validate.number(),
  mounts: validate.array(environmentMountSchema),
  limits: environmentLimitsSchema,
  internetAccess: validate.boolean(),
  displayName: validate.string().min(1).optional(),
  volumeName: validate.string().min(1).optional(),
  networkName: validate.string().min(1).optional(),
  ports: environmentPortsSchema.optional(),
  desiredPhase: validate.enum(['running', 'stopped', 'paused']).optional(),
})

export const environmentOperationSchema = validate.object({
  id: validate.string().min(1),
  environmentId: validate.string().min(3).max(64),
  kind: validate.enum(['create', 'start', 'stop', 'pause', 'resume', 'bind', 'unbind', 'update-limits', 'remove']),
  state: validate.enum(['requested', 'running', 'completed', 'failed']),
  error: validate.string().optional(),
  errorCode: validate.string().optional(),
  idempotencyKey: validate.string().min(1).optional(),
  requestedAt: validate.number().optional(),
  settledAt: validate.number().optional(),
  // The complete validated intent and the captured destination persist with
  // the record: a crash-replayed or reloaded operation can be re-executed,
  // reconciled, and idempotency-checked without the caller resupplying them.
  payload: environmentOperationPayloadSchema.optional(),
  target: environmentTargetSchema.optional(),
  requestSignature: validate.string().min(1).optional(),
})

/**
 * Structural declaration of the inventory domain, shaped to match the DSH
 * storage-domain `DomainSpec` (name/version/layout/tables with zod value
 * schemas). The adapter wiring (later phase) passes it through `defineDomain`
 * and `ctx.storageDomain.open`; this package deliberately does not import the
 * storage packages so it adds no dependency here.
 */
export const wrapvmInventoryDomainSpec = {
  name: WRAPVM_ENVIRONMENT_DOMAIN,
  version: WRAPVM_INVENTORY_VERSION,
  layout: 'per-record',
  tables: {
    snapshots: { valueSchema: validate.object({
      environments: validate.record(validate.string(), environmentDescriptorSchema),
      operations: validate.record(validate.string(), environmentOperationSchema.strict()),
    }) },
  },
} as const

/**
 * Deterministic canonical JSON: object keys sorted, `undefined`/functions/
 * symbols dropped. Used for the persisted request signature and for the
 * removal preview's snapshot-equality check, so two semantically identical
 * requests always produce byte-identical text regardless of key order.
 * @param value - plain data (the persisted record shapes).
 * @returns the canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  if (typeof value !== 'object') return 'null'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/**
 * Canonical semantic signature of a mutation request: kind, environment, and
 * full parameters. Deliberately excludes operation id, timestamps, and the
 * captured target so a retried request matches, while a DIFFERENT request
 * reusing the same idempotency key never does. For `create` the environment
 * id is generated by the manager per request, not supplied by the caller, so
 * it is not part of the semantic request; for every other kind the target
 * environment IS part of the request.
 * @param operation - the requested operation (payload carries the parameters).
 * @returns the canonical signature text.
 */
export function operationRequestSignature(operation: EnvironmentOperation): string {
  return canonicalJson({
    kind: operation.kind,
    environmentId: operation.kind === 'create' ? null : operation.environmentId,
    payload: operation.payload ?? null,
  })
}

/** Full persisted state of the inventory. */
export interface InventorySnapshot {
  readonly environments: Readonly<Record<string, EnvironmentDescriptor>>
  readonly operations: Readonly<Record<string, PersistedOperation>>
}

/** Durable store port the inventory reads and writes through. */
export interface InventoryStore {
  /**
   * Load the persisted snapshot.
   * @returns the snapshot, or undefined when nothing was ever written.
   */
  load(): Promise<InventorySnapshot | undefined>
  /**
   * Persist a full snapshot atomically (the store owns the medium's write
   * serialization; the inventory serializes callers).
   * @param snapshot - the complete new state.
   */
  save(snapshot: InventorySnapshot): Promise<void>
}

/** In-memory store for tests and dry runs. */
export class MemoryInventoryStore implements InventoryStore {
  private snapshot: InventorySnapshot | undefined
  /** Saved snapshots in call order, for assertions about persistence attempts. */
  readonly saves: InventorySnapshot[] = []

  load(): Promise<InventorySnapshot | undefined> {
    return Promise.resolve(this.snapshot)
  }

  save(snapshot: InventorySnapshot): Promise<void> {
    this.snapshot = snapshot
    this.saves.push(snapshot)
    return Promise.resolve()
  }
}

/** The structural slice of a storage-domain `KvTable` this adapter needs. */
export interface KvTableLike<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Persists the entire inventory as one atomically replaced storage-domain record. */
export class DomainInventoryStore implements InventoryStore {
  constructor(private readonly snapshots: KvTableLike<unknown>) {}

  load(): Promise<InventorySnapshot | undefined> {
    const value = this.snapshots.get('current')
    if (value === undefined) return Promise.resolve(undefined)
    const parsed = wrapvmInventoryDomainSpec.tables.snapshots.valueSchema.parse(value)
    const environments: Record<string, EnvironmentDescriptor> = {}
    const operations: Record<string, PersistedOperation> = {}
    for (const [key, record] of Object.entries(parsed.environments)) environments[key] = parseDescriptor(record, key)
    for (const [key, record] of Object.entries(parsed.operations)) operations[key] = parseOperation(record, key)
    return Promise.resolve({ environments, operations })
  }

  async save(snapshot: InventorySnapshot): Promise<void> {
    const environments: Record<string, EnvironmentDescriptor> = {}
    const operations: Record<string, PersistedOperation> = {}
    for (const [key, record] of Object.entries(snapshot.environments)) environments[key] = parseDescriptor(record, key)
    for (const [key, record] of Object.entries(snapshot.operations)) operations[key] = parseOperation(record, key)
    await this.snapshots.put('current', { environments, operations })
  }
}

function parseDescriptor(value: unknown, key: string): EnvironmentDescriptor {
  try {
    const record = environmentDescriptorSchema.parse(value)
    if (record.id !== key) throw new Error('record id does not match its key')
    return record as unknown as EnvironmentDescriptor
  } catch (error) {
    throw new Error(`wrapvm-isolate: inventory record '${key}' is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseOperation(value: unknown, key: string): PersistedOperation {
  try {
    // Strict on purpose: a field the schema does not know (a leaked
    // AbortSignal, an ad-hoc debug field) must fail loudly at the durable
    // boundary, never be silently stripped from the persisted intent.
    const record = environmentOperationSchema.strict().parse(value)
    if (record.id !== key || (record.payload !== undefined && record.payload.kind !== record.kind) ||
      (record.target !== undefined && record.target.environmentId !== record.environmentId)) {
      throw new Error('operation identity or payload does not match its record')
    }
    return record as unknown as PersistedOperation
  } catch (error) {
    throw new Error(`wrapvm-isolate: operation record '${key}' is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Durable inventory with serialized mutations and an operation log.
 *
 * Every mutation goes through one internal write chain (no torn snapshots),
 * validates records at the boundary, and keeps operations durable so a crash
 * between "requested" and "settled" is visible to reconciliation.
 */
export class Inventory {
  private snapshot: InventorySnapshot = { environments: {}, operations: {} }
  private chain: Promise<void> = Promise.resolve()
  private initialized = false

  constructor(private readonly store: InventoryStore) {}

  /**
   * Load and validate the persisted snapshot. Fail-closed: an invalid record
   * rejects initialization; the manager must not run on a half-read inventory.
   * @returns this inventory, ready for use.
   */
  async initialize(): Promise<this> {
    const snapshot = await this.store.load()
    this.snapshot = { environments: {}, operations: {} }
    if (snapshot !== undefined) {
      const environments: Record<string, EnvironmentDescriptor> = {}
      for (const [key, record] of Object.entries(snapshot.environments)) {
        environments[key] = parseDescriptor(record, key)
      }
      const operations: Record<string, EnvironmentOperation> = {}
      for (const [key, record] of Object.entries(snapshot.operations)) {
        operations[key] = parseOperation(record, key)
      }
      this.snapshot = { environments, operations }
    }
    this.initialized = true
    return this
  }

  /** All inventory descriptors, ordered by creation time. */
  list(): readonly EnvironmentDescriptor[] {
    this.assertReady()
    return Object.values(this.snapshot.environments).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Read one descriptor by durable id. */
  get(id: EnvironmentId): EnvironmentDescriptor | undefined {
    this.assertReady()
    return this.snapshot.environments[id]
  }

  /** Read one descriptor by immutable container id (never by name). */
  getByContainerId(containerId: string): EnvironmentDescriptor | undefined {
    this.assertReady()
    return Object.values(this.snapshot.environments).find(record => record.containerId === containerId)
  }

  /** Read one operation by identity. */
  operation(id: string): PersistedOperation | undefined {
    this.assertReady()
    return this.snapshot.operations[id]
  }

  /** Operations for one environment, oldest first. */
  operationsFor(environmentId: EnvironmentId): readonly PersistedOperation[] {
    this.assertReady()
    return Object.values(this.snapshot.operations)
      .filter(record => record.environmentId === environmentId)
      .sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0))
  }

  /** Find an operation by caller idempotency key (dedup of duplicate requests). */
  findByIdempotencyKey(key: string): PersistedOperation | undefined {
    this.assertReady()
    return Object.values(this.snapshot.operations).find(record => record.idempotencyKey === key)
  }

  /** All durable operation records, including unresolved create intents. */
  allOperations(): readonly PersistedOperation[] {
    this.assertReady()
    return Object.values(this.snapshot.operations)
  }

  /** Operations left unsettled by an interruption; reconciliation input. */
  pendingOperations(): readonly PersistedOperation[] {
    this.assertReady()
    return Object.values(this.snapshot.operations).filter(record => record.state === 'requested' || record.state === 'running')
  }

  /**
   * Operations settled `completed` but whose outcome may not have reached the
   * descriptor table (a legacy split write interrupted in between): the
   * recovery pass re-applies their durable outcome deterministically.
   * @returns completed operations, oldest first.
   */
  completedOperations(): readonly PersistedOperation[] {
    this.assertReady()
    return Object.values(this.snapshot.operations)
      .filter(record => record.state === 'completed')
      .sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0))
  }

  /**
   * Apply one mutation to the snapshot and persist it, serialized behind all
   * earlier mutations. The mutator sees the current snapshot and returns the
   * next one; it must not mutate the input.
   * @param mutate - pure snapshot transition.
   * @returns the snapshot the mutation landed with.
   */
  async transact(mutate: (snapshot: InventorySnapshot) => InventorySnapshot): Promise<InventorySnapshot> {
    this.assertReady()
    const run = this.chain.then(async () => {
      this.assertReady()
      const next = mutate(this.snapshot)
      try {
        await this.store.save(next)
      } catch (error) {
        // A storage error may occur after atomic replacement. Do not write
        // from the old in-memory snapshot until the medium is reopened.
        this.initialized = false
        throw error
      }
      this.snapshot = next
      return next
    })
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Insert or replace one descriptor (validated). */
  async putDescriptor(descriptor: EnvironmentDescriptor): Promise<void> {
    const record = parseDescriptor(descriptor, descriptor.id)
    await this.transact(snapshot => ({
      ...snapshot,
      environments: { ...snapshot.environments, [record.id]: record },
    }))
  }

  /** Remove one descriptor (its operation log is pruned by the caller). */
  async deleteDescriptor(id: EnvironmentId): Promise<void> {
    await this.transact((snapshot) => {
      const environments: Record<string, EnvironmentDescriptor> = {}
      for (const [key, record] of Object.entries(snapshot.environments)) {
        if (key !== id) environments[key] = record
      }
      return { ...snapshot, environments }
    })
  }

  /** Persist one operation record (validated). */
  async putOperation(operation: PersistedOperation): Promise<void> {
    const record = parseOperation(operation, operation.id)
    await this.transact(snapshot => ({
      ...snapshot,
      operations: { ...snapshot.operations, [record.id]: record },
    }))
  }

  /**
   * Commit one settled operation AND its inventory outcome in a single
   * durable transaction. This is the atomic unit crash recovery relies on:
   * an observer either sees the settled record with its outcome applied, or
   * sees neither — never a `completed` create whose descriptor was lost, or
   * a removed environment whose record survived the deletion.
   * @param operation - the settled operation record (validated).
   * @param outcome - descriptor transition the outcome applies, and the
   * environment whose operation log is pruned with the commit (removals).
   */
  async commitSettlement(
    operation: PersistedOperation,
    outcome: {
      readonly apply?: (environments: Record<string, EnvironmentDescriptor>) => Record<string, EnvironmentDescriptor>
      readonly pruneOperationsFor?: EnvironmentId
    } = {},
  ): Promise<void> {
    const record = parseOperation(operation, operation.id)
    await this.transact((snapshot) => {
      const applied = outcome.apply === undefined ? snapshot.environments : outcome.apply(snapshot.environments)
      const environments: Record<string, EnvironmentDescriptor> = {}
      for (const [key, value] of Object.entries(applied)) {
        environments[key] = parseDescriptor(value, key)
      }
      let operations: Record<string, PersistedOperation> = { ...snapshot.operations, [record.id]: record }
      if (outcome.pruneOperationsFor !== undefined) {
        const pruned: Record<string, PersistedOperation> = {}
        for (const [key, value] of Object.entries(operations)) {
          if (value.environmentId !== outcome.pruneOperationsFor) pruned[key] = value
        }
        operations = pruned
      }
      return { environments, operations }
    })
  }

  /** Drop the operation log of a removed environment. */
  async pruneOperations(environmentId: EnvironmentId): Promise<void> {
    await this.transact((snapshot) => {
      const operations: Record<string, PersistedOperation> = {}
      for (const [key, record] of Object.entries(snapshot.operations)) {
        if (record.environmentId !== environmentId) operations[key] = record
      }
      return { ...snapshot, operations }
    })
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('wrapvm-isolate: inventory used before initialize()')
  }
}
