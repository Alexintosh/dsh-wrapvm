/**
 * Docker backend driver.
 *
 * One environment is one container plus a persistent named volume and a
 * per-environment isolated network. The driver speaks the Docker CLI through
 * an injected {@link EngineRunner} (production wires `ctx.subprocess.spawn`;
 * tests script a fake engine), so no live daemon is required to exercise it.
 *
 * Guarantees this backend actually enforces, and refuses to claim otherwise:
 * - workspace persists in a named volume; host directories attach only as
 *   explicitly approved mounts validated by the canonical mount policy, and
 *   they are passed with explicit `--mount type=bind` grammar (never the
 *   ambiguous `-v host:guest,ro` form, which mounts read-WRITE at a path
 *   ending in `,ro`); ambiguous separators and control characters are refused;
 * - every published port binds the host loopback interface only;
 * - each environment uses a separate bridge network; when an
 *   environment declares no Internet access the network is `--internal`, so
 *   Docker itself enforces the absence of egress;
 * - `--security-opt no-new-privileges`, `--cap-drop ALL` with the minimal
 *   add set the desktop image needs, and a pids limit;
 * - CPU/RAM map to `--cpus`/`--memory`, with `--memory-swap` pinned to the
 *   memory limit on create AND on update (an update that moved memory without
 *   swap would silently re-open swap headroom);
 * - disk quotas are NOT enforced by overlay2 on macOS/Windows: any attempt to
 *   set one fails closed with `disk-quota-unsupported`, never silently ignored.
 *
 * Capability contract (inspected from the sibling wrap image sources, not
 * guessed): the image entrypoint `/opt/wrap/bin/wrap-entrypoint` starts as
 * uid 0 and `exec setpriv --reuid --regid --init-groups` down to uid/gid 1000
 * — that requires CAP_SETUID/CAP_SETGID, so `--cap-drop ALL` alone would make
 * the container fail to start and the add set below is the minimum that keeps
 * the image's own startup contract working. Chrome runs with `--no-sandbox`
 * per the image's own `/etc/wrap/chrome-flags.conf` (Docker's default seccomp
 * refuses the unprivileged namespaces Chrome's sandbox needs), so the SUID
 * sandbox helper is not part of the contract. DECLARED DEVIATION: the image
 * advertises passwordless `sudo` for in-guest root, and `no-new-privileges`
 * makes setuid escalation impossible — guest package installs must run as the
 * configured user (the image's mise/npm path); nothing here promises `sudo`
 * works, and isolation is never weakened to restore it. Final compatibility
 * still requires live acceptance on a real engine.
 *
 * Ownership is labels plus immutable ids, verified at every decision point:
 * - listings used for id matching run `--no-trunc`; the authoritative id is
 *   always the inspected `.Id`, never a truncated `docker ps` cell;
 * - create adoption inspects the full container (labels, id, image, attached
 *   network and volume) and fails closed on foreign, multiple, or conflicting
 *   claimants instead of adopting the first row;
 * - `already exists` on network/volume create is only tolerated after the
 *   existing resource is inspected and its ownership labels confirmed;
 * - every mutation re-verifies container (and, for removal, network/volume)
 *   ownership and identity immediately before the CLI mutation, so a forged
 *   or stale target never deletes or stops a foreign resource;
 * - volumes have no immutable id. Identity is the derived name, the ownership
 *   labels, the driver, the inspected `CreatedAt`, and a creation-incarnation
 *   token label this backend mints at volume create. Removal with an explicit
 *   volume choice refuses until that identity was captured (fresh
 *   `captureTarget`); a recreated volume is invalidated by token/CreatedAt
 *   mismatch. The modeled threat is stale state, crashes, and name collision
 *   — a hostile local daemon can lie about any inspection and is out of scope.
 * - reconciliation reports unregistered owned containers instead of adopting
 *   or deleting them, and never controls a container it cannot match to an
 *   inventory record.
 *
 * Guest-controlled processes cannot establish control-plane isolation: health
 * reports unknown until a trusted host-side mechanism can verify it.
 * @module
 */
import type { EnvironmentBackendDriver, EnvironmentDescriptor, EnvironmentHealth, EnvironmentId, EnvironmentOperation, EnvironmentTarget, TargetAcquisition, TargetVerification } from './environments.ts';
import { type MountPolicyContext } from './mount-policy.ts';
/** Outcome of one engine invocation (never throws for non-zero exit). */
export interface EngineRunResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
/** Bounded engine command port. Throws only when the process could not run. */
export type EngineRunner = (argv: readonly string[], signal: AbortSignal) => Promise<EngineRunResult>;
/** Static configuration of the Docker backend. */
export interface DockerBackendConfig {
    /** Engine binary (`docker`). */
    readonly binary: string;
    /** Default guest workspace path the persistent volume is mounted at. */
    readonly guestWorkspace: string;
    /** Guest viewer port. */
    readonly viewerGuestPort: number;
    /** Guest CDP forwarder port. */
    readonly cdpGuestPort: number;
    /** Image entrypoint that selects the configured desktop user. */
    readonly guestEntrypoint: string;
    /** Reserved endpoint configuration for a future trusted host-side isolation check; guest probes are not trusted. */
    readonly controlPlaneProbes: readonly string[];
    /** Process cap per environment. */
    readonly pidsLimit: number;
    /** Per-command timeout for engine calls, in milliseconds. */
    readonly commandTimeoutMs: number;
}
export declare const defaultDockerBackendConfig: DockerBackendConfig;
/**
 * Creation-incarnation token label. Minted per volume create and carried on
 * the volume: a recreated volume gets a fresh token, invalidating targets and
 * removal previews captured against the old incarnation. Docker volumes have
 * no immutable id, so this plus the inspected `CreatedAt` is the identity.
 */
export declare const VOLUME_TOKEN_LABEL = "dsh.wrapvm.volume-token";
/** Backend-side view of the inventory (structural slice, no import cycle). */
export interface InventoryView {
    list(): readonly EnvironmentDescriptor[];
}
/** Outcome of one reconciliation pass, with the honest three-way split. */
export interface ReconciliationReport {
    /** Inventory records the backend confirms (container present, labels match). */
    readonly confirmed: readonly EnvironmentDescriptor[];
    /** Containers owned by our labels with no inventory record — surfaced, never adopted or deleted. */
    readonly unregistered: readonly EnvironmentDescriptor[];
    /** Inventory records with no matching container (phase 'missing' territory). */
    readonly missing: readonly EnvironmentId[];
    /** Containers claiming an environment id that contradicts the inventory (id reuse conflict). */
    readonly conflicts: readonly {
        containerId: string;
        environmentId: string;
        reason: string;
    }[];
}
/** Refusal codes surfaced on failed operations (machine-readable). */
export declare const DOCKER_BACKEND_ERROR_CODES: {
    readonly diskQuotaUnsupported: "disk-quota-unsupported";
    readonly mountDenied: "mount-denied";
    readonly privilegedDenied: "privileged-denied";
    readonly portConflict: "port-conflict";
    readonly containerMissing: "container-missing";
    readonly invalidTransition: "invalid-transition";
    readonly engineUnavailable: "engine-unavailable";
    /** Observed labels contradict plugin ownership of the target environment. */
    readonly resourceForeign: "resource-foreign";
    /** Identity conflict: multiple claimants, or a resource replaced since capture. */
    readonly resourceConflict: "resource-conflict";
    /** Ownership could not be confirmed (ambiguous engine answer): fail closed. */
    readonly resourceUnverified: "resource-unverified";
};
/**
 * The Docker implementation of {@link EnvironmentBackendDriver}.
 */
export declare class DockerEnvironmentBackend implements EnvironmentBackendDriver {
    private readonly runner;
    readonly config: DockerBackendConfig;
    private mountPolicy;
    private readonly inventory;
    private readonly now;
    private lastReport;
    constructor(runner: EngineRunner, config: DockerBackendConfig, mountPolicy: MountPolicyContext, inventory: InventoryView, now?: () => number);
    /** Record host paths explicitly selected in a create request. */
    approveMounts(mounts: readonly {
        hostPath: string;
    }[]): void;
    /** The most recent reconciliation report, if reconcile() has run. */
    get reconciliationReport(): ReconciliationReport | undefined;
    private engineRun;
    /** Fail-closed engine health check used before any mutation batch. */
    engineAvailable(signal: AbortSignal): Promise<boolean>;
    private inspectContainer;
    private inspectNetwork;
    private inspectVolume;
    /** Reason the labels contradict plugin ownership of `id`, or undefined when they confirm it. */
    private ownershipMismatch;
    /**
     * Reconcile durable inventory against observed backend state via labels and
     * immutable container ids. Never adopts by name, never touches foreign
     * containers, never deletes anything.
     */
    reconcile(signal: AbortSignal): Promise<readonly EnvironmentDescriptor[]>;
    /** Full three-way reconciliation split (confirmed / unregistered / missing / conflicts). */
    reconcileReport(signal: AbortSignal): Promise<ReconciliationReport>;
    private observedDescriptor;
    private matchesPortBindings;
    private parsePublishedPorts;
    private networkIdOf;
    /**
     * Acquire a verified target for one environment id: labels plus full
     * immutable ids plus observed network/volume identity, read from the
     * inspected descriptors. Foreign or multiple claimants fail closed.
     */
    captureTarget(environmentId: EnvironmentId, signal: AbortSignal): Promise<TargetAcquisition>;
    /**
     * Re-verify container/network/volume ownership and identity for a captured
     * target. Read-only; every mutation in this backend runs the container
     * verification itself before touching the engine, and removal re-verifies
     * network and volume immediately before their own removals.
     */
    verifyTarget(target: EnvironmentTarget, signal: AbortSignal): Promise<TargetVerification>;
    /** Container verification paired with the inspected payload (status reads reuse it). */
    private verifiedContainer;
    private verifyContainer;
    private verifyNetwork;
    private verifyVolume;
    /**
     * Execute one mutation against the captured target. Validation refusals
     * settle the operation as `failed` with a precise code; they never reach
     * the engine. Cancellation propagates.
     */
    run(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation>;
    private fail;
    /** Settle a verification outcome that blocks a mutation. */
    private refuseVerification;
    private listOwnedContainerIds;
    private target;
    private runCreate;
    /**
     * State transitions address the captured FULL container id, but only after
     * the container was re-inspected and confirmed ours: a stale or forged
     * target never stops, starts, pauses, or unpauses a foreign container.
     */
    private runState;
    private runPause;
    private runResume;
    private runUpdateLimits;
    /**
     * Removal re-verifies every resource immediately before its own mutation.
     * A foreign, replaced, or unverifiable resource is never deleted; host
     * directories are never deleted under any choice. Volume deletion requires
     * the captured creation identity (token or inspected CreatedAt): without it
     * the volume's incarnation cannot be established, so the destructive choice
     * refuses until a fresh {@link captureTarget} verifies it.
     */
    private runRemove;
    /**
     * Probe guest services and host control-plane reachability for one target.
     * Every answer is observed or honestly unknown: a probe that could not run
     * never reports availability or isolation.
     */
    probe(target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentHealth>;
    private phaseOf;
    /** One guest exec probe: exit 0 available, non-zero unavailable, unable-to-run unknown. */
    private probeExec;
    /**
     * One bounded `docker stats` batch for the given containers. Rows are only
     * accepted when their (full, `--no-trunc`) id is one of the requested ids.
     * Missing or unparsable values stay null — never zero.
     */
    stats(containerIds: readonly string[], signal: AbortSignal): Promise<Map<string, {
        memoryUsedBytes: number | null;
        memoryLimitBytes: number | null;
        cpuPercent: number | null;
    }>>;
    /** Writable-layer size of one container, or null when unreported. */
    writableLayerSize(containerId: string, signal: AbortSignal): Promise<number | null>;
}
/** Parse a Docker byte expression ("1.234GiB", "12.3MB", "0B") into bytes. */
export declare function parseDockerBytes(text: string): number | null;
/** Parse a Docker percentage cell ("12.34%") into a number, or null. */
export declare function parseDockerPercent(text: string): number | null;
//# sourceMappingURL=docker-backend.d.ts.map