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
import { z as validate } from 'zod';
import type { EnvironmentDescriptor, EnvironmentId, EnvironmentOperation } from './environments.ts';
/**
 * The durable operation record: the in-memory {@link EnvironmentOperation}
 * plus the canonical semantic request signature. The signature is what makes
 * an idempotency key safe to deduplicate against: two requests sharing a key
 * must carry the same kind, environment, and parameters, and the comparison
 * survives a crash because it is persisted with the record.
 */
export interface PersistedOperation extends EnvironmentOperation {
    /** Canonical signature of the semantic request (kind + environment + params). */
    readonly requestSignature?: string;
}
/** Domain name for the inventory (matches the storage-domain unit-name rules). */
export declare const WRAPVM_ENVIRONMENT_DOMAIN = "wrapvm_environments";
/** Inventory record format version. */
export declare const WRAPVM_INVENTORY_VERSION = 1;
/** Label marking every backend resource this plugin owns. */
export declare const OWNERSHIP_LABEL = "dsh.wrapvm.environment";
/** Label carrying the durable environment id on every owned resource. */
export declare const ENVIRONMENT_ID_LABEL = "dsh.wrapvm.environment-id";
/** Ownership labels applied to containers, volumes, and networks of one environment. */
export declare function environmentLabels(id: EnvironmentId): Readonly<Record<string, string>>;
/** Container name derived from the durable id (names stay disposable; ids own). */
export declare function containerNameFor(id: EnvironmentId): string;
export declare const environmentMountSchema: validate.ZodObject<{
    hostPath: validate.ZodString;
    guestPath: validate.ZodString;
    access: validate.ZodEnum<{
        "read-only": "read-only";
        "read-write": "read-write";
    }>;
}, validate.core.$strip>;
export declare const environmentLimitsSchema: validate.ZodObject<{
    cpuMillis: validate.ZodNumber;
    memoryBytes: validate.ZodNumber;
    diskBytes: validate.ZodOptional<validate.ZodNumber>;
}, validate.core.$strip>;
export declare const environmentPortsSchema: validate.ZodObject<{
    viewerPort: validate.ZodInt;
    cdpPort: validate.ZodInt;
}, validate.core.$strip>;
/** Persisted shape of a create request: the full intent, validated at the boundary. */
export declare const environmentCreateInputSchema: validate.ZodObject<{
    displayName: validate.ZodString;
    image: validate.ZodString;
    limits: validate.ZodObject<{
        cpuMillis: validate.ZodNumber;
        memoryBytes: validate.ZodNumber;
        diskBytes: validate.ZodOptional<validate.ZodNumber>;
    }, validate.core.$strip>;
    internetAccess: validate.ZodBoolean;
    mounts: validate.ZodArray<validate.ZodObject<{
        hostPath: validate.ZodString;
        guestPath: validate.ZodString;
        access: validate.ZodEnum<{
            "read-only": "read-only";
            "read-write": "read-write";
        }>;
    }, validate.core.$strip>>;
    ports: validate.ZodOptional<validate.ZodObject<{
        viewerPort: validate.ZodInt;
        cdpPort: validate.ZodInt;
    }, validate.core.$strip>>;
}, validate.core.$strip>;
/**
 * Persisted shape of an admission-captured target (immutable destination
 * snapshot). Passthrough on purpose: identity fields the backend adds at
 * capture (network id, volume driver, and any later creation-identity
 * fields) must survive persistence untouched — stripping them would silently
 * weaken preview invalidation and recovery after a reload.
 */
export declare const environmentTargetSchema: validate.ZodObject<{
    environmentId: validate.ZodString;
    containerId: validate.ZodString;
    containerName: validate.ZodString;
    networkName: validate.ZodString;
    volumeName: validate.ZodString;
    ports: validate.ZodObject<{
        viewerPort: validate.ZodInt;
        cdpPort: validate.ZodInt;
    }, validate.core.$strip>;
    imageDigest: validate.ZodOptional<validate.ZodString>;
    capturedAt: validate.ZodNumber;
    networkId: validate.ZodOptional<validate.ZodString>;
    volumeDriver: validate.ZodOptional<validate.ZodString>;
    volumeToken: validate.ZodOptional<validate.ZodString>;
    volumeCreatedAt: validate.ZodOptional<validate.ZodString>;
}, validate.core.$loose>;
/** Persisted discriminated operation payload: every kind's full parameters. */
export declare const environmentOperationPayloadSchema: validate.ZodDiscriminatedUnion<[validate.ZodObject<{
    kind: validate.ZodLiteral<"create">;
    input: validate.ZodObject<{
        displayName: validate.ZodString;
        image: validate.ZodString;
        limits: validate.ZodObject<{
            cpuMillis: validate.ZodNumber;
            memoryBytes: validate.ZodNumber;
            diskBytes: validate.ZodOptional<validate.ZodNumber>;
        }, validate.core.$strip>;
        internetAccess: validate.ZodBoolean;
        mounts: validate.ZodArray<validate.ZodObject<{
            hostPath: validate.ZodString;
            guestPath: validate.ZodString;
            access: validate.ZodEnum<{
                "read-only": "read-only";
                "read-write": "read-write";
            }>;
        }, validate.core.$strip>>;
        ports: validate.ZodOptional<validate.ZodObject<{
            viewerPort: validate.ZodInt;
            cdpPort: validate.ZodInt;
        }, validate.core.$strip>>;
    }, validate.core.$strip>;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"start">;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"stop">;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"pause">;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"resume">;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"bind">;
    sessionKey: validate.ZodString;
    generation: validate.ZodNumber;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"unbind">;
    sessionKey: validate.ZodString;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"update-limits">;
    limits: validate.ZodObject<{
        cpuMillis: validate.ZodNumber;
        memoryBytes: validate.ZodNumber;
        diskBytes: validate.ZodOptional<validate.ZodNumber>;
    }, validate.core.$strip>;
}, validate.core.$strip>, validate.ZodObject<{
    kind: validate.ZodLiteral<"remove">;
    deleteVolumes: validate.ZodBoolean;
}, validate.core.$strip>], "kind">;
/** Stored descriptor record: the single source validated at the durable boundary. */
export declare const environmentDescriptorSchema: validate.ZodObject<{
    id: validate.ZodString;
    backend: validate.ZodLiteral<"docker">;
    containerId: validate.ZodString;
    ownership: validate.ZodEnum<{
        plugin: "plugin";
        imported: "imported";
    }>;
    image: validate.ZodString;
    digest: validate.ZodString;
    createdAt: validate.ZodNumber;
    mounts: validate.ZodArray<validate.ZodObject<{
        hostPath: validate.ZodString;
        guestPath: validate.ZodString;
        access: validate.ZodEnum<{
            "read-only": "read-only";
            "read-write": "read-write";
        }>;
    }, validate.core.$strip>>;
    limits: validate.ZodObject<{
        cpuMillis: validate.ZodNumber;
        memoryBytes: validate.ZodNumber;
        diskBytes: validate.ZodOptional<validate.ZodNumber>;
    }, validate.core.$strip>;
    internetAccess: validate.ZodBoolean;
    displayName: validate.ZodOptional<validate.ZodString>;
    volumeName: validate.ZodOptional<validate.ZodString>;
    networkName: validate.ZodOptional<validate.ZodString>;
    ports: validate.ZodOptional<validate.ZodObject<{
        viewerPort: validate.ZodInt;
        cdpPort: validate.ZodInt;
    }, validate.core.$strip>>;
    desiredPhase: validate.ZodOptional<validate.ZodEnum<{
        running: "running";
        stopped: "stopped";
        paused: "paused";
    }>>;
}, validate.core.$strip>;
export declare const environmentOperationSchema: validate.ZodObject<{
    id: validate.ZodString;
    environmentId: validate.ZodString;
    kind: validate.ZodEnum<{
        create: "create";
        start: "start";
        stop: "stop";
        pause: "pause";
        resume: "resume";
        bind: "bind";
        unbind: "unbind";
        "update-limits": "update-limits";
        remove: "remove";
    }>;
    state: validate.ZodEnum<{
        running: "running";
        requested: "requested";
        completed: "completed";
        failed: "failed";
    }>;
    error: validate.ZodOptional<validate.ZodString>;
    errorCode: validate.ZodOptional<validate.ZodString>;
    idempotencyKey: validate.ZodOptional<validate.ZodString>;
    requestedAt: validate.ZodOptional<validate.ZodNumber>;
    settledAt: validate.ZodOptional<validate.ZodNumber>;
    payload: validate.ZodOptional<validate.ZodDiscriminatedUnion<[validate.ZodObject<{
        kind: validate.ZodLiteral<"create">;
        input: validate.ZodObject<{
            displayName: validate.ZodString;
            image: validate.ZodString;
            limits: validate.ZodObject<{
                cpuMillis: validate.ZodNumber;
                memoryBytes: validate.ZodNumber;
                diskBytes: validate.ZodOptional<validate.ZodNumber>;
            }, validate.core.$strip>;
            internetAccess: validate.ZodBoolean;
            mounts: validate.ZodArray<validate.ZodObject<{
                hostPath: validate.ZodString;
                guestPath: validate.ZodString;
                access: validate.ZodEnum<{
                    "read-only": "read-only";
                    "read-write": "read-write";
                }>;
            }, validate.core.$strip>>;
            ports: validate.ZodOptional<validate.ZodObject<{
                viewerPort: validate.ZodInt;
                cdpPort: validate.ZodInt;
            }, validate.core.$strip>>;
        }, validate.core.$strip>;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"start">;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"stop">;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"pause">;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"resume">;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"bind">;
        sessionKey: validate.ZodString;
        generation: validate.ZodNumber;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"unbind">;
        sessionKey: validate.ZodString;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"update-limits">;
        limits: validate.ZodObject<{
            cpuMillis: validate.ZodNumber;
            memoryBytes: validate.ZodNumber;
            diskBytes: validate.ZodOptional<validate.ZodNumber>;
        }, validate.core.$strip>;
    }, validate.core.$strip>, validate.ZodObject<{
        kind: validate.ZodLiteral<"remove">;
        deleteVolumes: validate.ZodBoolean;
    }, validate.core.$strip>], "kind">>;
    target: validate.ZodOptional<validate.ZodObject<{
        environmentId: validate.ZodString;
        containerId: validate.ZodString;
        containerName: validate.ZodString;
        networkName: validate.ZodString;
        volumeName: validate.ZodString;
        ports: validate.ZodObject<{
            viewerPort: validate.ZodInt;
            cdpPort: validate.ZodInt;
        }, validate.core.$strip>;
        imageDigest: validate.ZodOptional<validate.ZodString>;
        capturedAt: validate.ZodNumber;
        networkId: validate.ZodOptional<validate.ZodString>;
        volumeDriver: validate.ZodOptional<validate.ZodString>;
        volumeToken: validate.ZodOptional<validate.ZodString>;
        volumeCreatedAt: validate.ZodOptional<validate.ZodString>;
    }, validate.core.$loose>>;
    requestSignature: validate.ZodOptional<validate.ZodString>;
}, validate.core.$strip>;
/**
 * Structural declaration of the inventory domain, shaped to match the DSH
 * storage-domain `DomainSpec` (name/version/layout/tables with zod value
 * schemas). The adapter wiring (later phase) passes it through `defineDomain`
 * and `ctx.storageDomain.open`; this package deliberately does not import the
 * storage packages so it adds no dependency here.
 */
export declare const wrapvmInventoryDomainSpec: {
    readonly name: "wrapvm_environments";
    readonly version: 1;
    readonly layout: "per-record";
    readonly tables: {
        readonly snapshots: {
            readonly valueSchema: validate.ZodObject<{
                environments: validate.ZodRecord<validate.ZodString, validate.ZodObject<{
                    id: validate.ZodString;
                    backend: validate.ZodLiteral<"docker">;
                    containerId: validate.ZodString;
                    ownership: validate.ZodEnum<{
                        plugin: "plugin";
                        imported: "imported";
                    }>;
                    image: validate.ZodString;
                    digest: validate.ZodString;
                    createdAt: validate.ZodNumber;
                    mounts: validate.ZodArray<validate.ZodObject<{
                        hostPath: validate.ZodString;
                        guestPath: validate.ZodString;
                        access: validate.ZodEnum<{
                            "read-only": "read-only";
                            "read-write": "read-write";
                        }>;
                    }, validate.core.$strip>>;
                    limits: validate.ZodObject<{
                        cpuMillis: validate.ZodNumber;
                        memoryBytes: validate.ZodNumber;
                        diskBytes: validate.ZodOptional<validate.ZodNumber>;
                    }, validate.core.$strip>;
                    internetAccess: validate.ZodBoolean;
                    displayName: validate.ZodOptional<validate.ZodString>;
                    volumeName: validate.ZodOptional<validate.ZodString>;
                    networkName: validate.ZodOptional<validate.ZodString>;
                    ports: validate.ZodOptional<validate.ZodObject<{
                        viewerPort: validate.ZodInt;
                        cdpPort: validate.ZodInt;
                    }, validate.core.$strip>>;
                    desiredPhase: validate.ZodOptional<validate.ZodEnum<{
                        running: "running";
                        stopped: "stopped";
                        paused: "paused";
                    }>>;
                }, validate.core.$strip>>;
                operations: validate.ZodRecord<validate.ZodString, validate.ZodObject<{
                    id: validate.ZodString;
                    environmentId: validate.ZodString;
                    kind: validate.ZodEnum<{
                        create: "create";
                        start: "start";
                        stop: "stop";
                        pause: "pause";
                        resume: "resume";
                        bind: "bind";
                        unbind: "unbind";
                        "update-limits": "update-limits";
                        remove: "remove";
                    }>;
                    state: validate.ZodEnum<{
                        running: "running";
                        requested: "requested";
                        completed: "completed";
                        failed: "failed";
                    }>;
                    error: validate.ZodOptional<validate.ZodString>;
                    errorCode: validate.ZodOptional<validate.ZodString>;
                    idempotencyKey: validate.ZodOptional<validate.ZodString>;
                    requestedAt: validate.ZodOptional<validate.ZodNumber>;
                    settledAt: validate.ZodOptional<validate.ZodNumber>;
                    payload: validate.ZodOptional<validate.ZodDiscriminatedUnion<[validate.ZodObject<{
                        kind: validate.ZodLiteral<"create">;
                        input: validate.ZodObject<{
                            displayName: validate.ZodString;
                            image: validate.ZodString;
                            limits: validate.ZodObject<{
                                cpuMillis: validate.ZodNumber;
                                memoryBytes: validate.ZodNumber;
                                diskBytes: validate.ZodOptional<validate.ZodNumber>;
                            }, validate.core.$strip>;
                            internetAccess: validate.ZodBoolean;
                            mounts: validate.ZodArray<validate.ZodObject<{
                                hostPath: validate.ZodString;
                                guestPath: validate.ZodString;
                                access: validate.ZodEnum<{
                                    "read-only": "read-only";
                                    "read-write": "read-write";
                                }>;
                            }, validate.core.$strip>>;
                            ports: validate.ZodOptional<validate.ZodObject<{
                                viewerPort: validate.ZodInt;
                                cdpPort: validate.ZodInt;
                            }, validate.core.$strip>>;
                        }, validate.core.$strip>;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"start">;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"stop">;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"pause">;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"resume">;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"bind">;
                        sessionKey: validate.ZodString;
                        generation: validate.ZodNumber;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"unbind">;
                        sessionKey: validate.ZodString;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"update-limits">;
                        limits: validate.ZodObject<{
                            cpuMillis: validate.ZodNumber;
                            memoryBytes: validate.ZodNumber;
                            diskBytes: validate.ZodOptional<validate.ZodNumber>;
                        }, validate.core.$strip>;
                    }, validate.core.$strip>, validate.ZodObject<{
                        kind: validate.ZodLiteral<"remove">;
                        deleteVolumes: validate.ZodBoolean;
                    }, validate.core.$strip>], "kind">>;
                    target: validate.ZodOptional<validate.ZodObject<{
                        environmentId: validate.ZodString;
                        containerId: validate.ZodString;
                        containerName: validate.ZodString;
                        networkName: validate.ZodString;
                        volumeName: validate.ZodString;
                        ports: validate.ZodObject<{
                            viewerPort: validate.ZodInt;
                            cdpPort: validate.ZodInt;
                        }, validate.core.$strip>;
                        imageDigest: validate.ZodOptional<validate.ZodString>;
                        capturedAt: validate.ZodNumber;
                        networkId: validate.ZodOptional<validate.ZodString>;
                        volumeDriver: validate.ZodOptional<validate.ZodString>;
                        volumeToken: validate.ZodOptional<validate.ZodString>;
                        volumeCreatedAt: validate.ZodOptional<validate.ZodString>;
                    }, validate.core.$loose>>;
                    requestSignature: validate.ZodOptional<validate.ZodString>;
                }, validate.core.$strict>>;
            }, validate.core.$strip>;
        };
    };
};
/**
 * Deterministic canonical JSON: object keys sorted, `undefined`/functions/
 * symbols dropped. Used for the persisted request signature and for the
 * removal preview's snapshot-equality check, so two semantically identical
 * requests always produce byte-identical text regardless of key order.
 * @param value - plain data (the persisted record shapes).
 * @returns the canonical JSON text.
 */
export declare function canonicalJson(value: unknown): string;
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
export declare function operationRequestSignature(operation: EnvironmentOperation): string;
/** Full persisted state of the inventory. */
export interface InventorySnapshot {
    readonly environments: Readonly<Record<string, EnvironmentDescriptor>>;
    readonly operations: Readonly<Record<string, PersistedOperation>>;
}
/** Durable store port the inventory reads and writes through. */
export interface InventoryStore {
    /**
     * Load the persisted snapshot.
     * @returns the snapshot, or undefined when nothing was ever written.
     */
    load(): Promise<InventorySnapshot | undefined>;
    /**
     * Persist a full snapshot atomically (the store owns the medium's write
     * serialization; the inventory serializes callers).
     * @param snapshot - the complete new state.
     */
    save(snapshot: InventorySnapshot): Promise<void>;
}
/** In-memory store for tests and dry runs. */
export declare class MemoryInventoryStore implements InventoryStore {
    private snapshot;
    /** Saved snapshots in call order, for assertions about persistence attempts. */
    readonly saves: InventorySnapshot[];
    load(): Promise<InventorySnapshot | undefined>;
    save(snapshot: InventorySnapshot): Promise<void>;
}
/** The structural slice of a storage-domain `KvTable` this adapter needs. */
export interface KvTableLike<V> {
    get(key: string): V | undefined;
    entries(): IterableIterator<[string, V]>;
    put(key: string, value: V): Promise<void>;
    delete(key: string): Promise<boolean>;
}
/** Persists the entire inventory as one atomically replaced storage-domain record. */
export declare class DomainInventoryStore implements InventoryStore {
    private readonly snapshots;
    constructor(snapshots: KvTableLike<unknown>);
    load(): Promise<InventorySnapshot | undefined>;
    save(snapshot: InventorySnapshot): Promise<void>;
}
/**
 * Durable inventory with serialized mutations and an operation log.
 *
 * Every mutation goes through one internal write chain (no torn snapshots),
 * validates records at the boundary, and keeps operations durable so a crash
 * between "requested" and "settled" is visible to reconciliation.
 */
export declare class Inventory {
    private readonly store;
    private snapshot;
    private chain;
    private initialized;
    constructor(store: InventoryStore);
    /**
     * Load and validate the persisted snapshot. Fail-closed: an invalid record
     * rejects initialization; the manager must not run on a half-read inventory.
     * @returns this inventory, ready for use.
     */
    initialize(): Promise<this>;
    /** All inventory descriptors, ordered by creation time. */
    list(): readonly EnvironmentDescriptor[];
    /** Read one descriptor by durable id. */
    get(id: EnvironmentId): EnvironmentDescriptor | undefined;
    /** Read one descriptor by immutable container id (never by name). */
    getByContainerId(containerId: string): EnvironmentDescriptor | undefined;
    /** Read one operation by identity. */
    operation(id: string): PersistedOperation | undefined;
    /** Operations for one environment, oldest first. */
    operationsFor(environmentId: EnvironmentId): readonly PersistedOperation[];
    /** Find an operation by caller idempotency key (dedup of duplicate requests). */
    findByIdempotencyKey(key: string): PersistedOperation | undefined;
    /** All durable operation records, including unresolved create intents. */
    allOperations(): readonly PersistedOperation[];
    /** Operations left unsettled by an interruption; reconciliation input. */
    pendingOperations(): readonly PersistedOperation[];
    /**
     * Operations settled `completed` but whose outcome may not have reached the
     * descriptor table (a legacy split write interrupted in between): the
     * recovery pass re-applies their durable outcome deterministically.
     * @returns completed operations, oldest first.
     */
    completedOperations(): readonly PersistedOperation[];
    /**
     * Apply one mutation to the snapshot and persist it, serialized behind all
     * earlier mutations. The mutator sees the current snapshot and returns the
     * next one; it must not mutate the input.
     * @param mutate - pure snapshot transition.
     * @returns the snapshot the mutation landed with.
     */
    transact(mutate: (snapshot: InventorySnapshot) => InventorySnapshot): Promise<InventorySnapshot>;
    /** Insert or replace one descriptor (validated). */
    putDescriptor(descriptor: EnvironmentDescriptor): Promise<void>;
    /** Remove one descriptor (its operation log is pruned by the caller). */
    deleteDescriptor(id: EnvironmentId): Promise<void>;
    /** Persist one operation record (validated). */
    putOperation(operation: PersistedOperation): Promise<void>;
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
    commitSettlement(operation: PersistedOperation, outcome?: {
        readonly apply?: (environments: Record<string, EnvironmentDescriptor>) => Record<string, EnvironmentDescriptor>;
        readonly pruneOperationsFor?: EnvironmentId;
    }): Promise<void>;
    /** Drop the operation log of a removed environment. */
    pruneOperations(environmentId: EnvironmentId): Promise<void>;
    private assertReady;
}
//# sourceMappingURL=inventory.d.ts.map