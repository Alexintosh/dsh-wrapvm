/**
 * Environment management API boundary agreed between the Wrapvm bundle, the
 * runtime, and the client. The Phase-3 environment manager implements these
 * interfaces; consumers (adapter wiring, Remote face, UI) depend on them.
 *
 * Three layers stay distinct: durable inventory (what exists), conversation
 * binding (which environment a protected conversation uses), and operational
 * state (what the backend currently reports). The browser's local state is
 * never authoritative.
 *
 * Phase-3 revision (not frozen): the independent review found the Phase-1
 * surface too thin for real Docker work and `protectedModeRefusal` too weak.
 * Additions are optional fields or new types so existing consumers keep
 * compiling; the eligibility decision now requires every guest service to be
 * verified available and delegates mount checks to the canonical policy when
 * one is supplied.
 * @module
 */

import type { MountPolicyContext } from './mount-policy.ts'
import { mountPolicyRefusals, staticMountRefusal } from './mount-policy.ts'

declare const environmentIdBrand: unique symbol

/** Opaque durable environment identity (never a container name). */
export type EnvironmentId = string & { readonly [environmentIdBrand]: true }

/** Mint an environment id from a generated raw string (single brand site). */
export function asEnvironmentId(raw: string): EnvironmentId {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(raw)) throw new Error(`wrapvm-isolate: invalid environment id '${raw}'`)
  return raw as EnvironmentId
}

/** Backend that hosts an environment. The first release ships Docker only. */
export type EnvironmentBackendKind = 'docker'

/** Host ports published for one environment. Always bound to 127.0.0.1. */
export interface EnvironmentPorts {
  /** Host port forwarded to the guest desktop viewer. */
  readonly viewerPort: number
  /** Host port forwarded to the guest CDP forwarder. */
  readonly cdpPort: number
}

/** Durable inventory record for one managed environment. */
export interface EnvironmentDescriptor {
  readonly id: EnvironmentId
  readonly backend: EnvironmentBackendKind
  /** Immutable container id reported by the backend; never the mutable name. */
  readonly containerId: string
  /** Ownership label distinguishing plugin-created from explicitly imported environments. */
  readonly ownership: 'plugin' | 'imported'
  /** Image reference plus resolved digest at creation. */
  readonly image: string
  readonly digest: string
  readonly createdAt: number
  /** Desired configuration; mounts require an explicit user choice. */
  readonly mounts: readonly EnvironmentMount[]
  readonly limits: EnvironmentLimits
  /** Whether the descriptor declares outbound Internet access. */
  readonly internetAccess: boolean
  /** Human-facing name shown in the UI; never used for identity or control. */
  readonly displayName?: string
  /** Persistent named volume holding the guest workspace (survives stop/start). */
  readonly volumeName?: string
  /** Per-environment isolated Docker network name. */
  readonly networkName?: string
  /** Loopback host ports this environment publishes. */
  readonly ports?: EnvironmentPorts
  /**
   * Phase the user last asked for. Reconciliation never contradicts it:
   * a manual pause is never auto-resumed, a stopped environment never auto-starts.
   */
  readonly desiredPhase?: 'running' | 'stopped' | 'paused'
}

/** One host directory shared with a guest, with its visible access mode. */
export interface EnvironmentMount {
  readonly hostPath: string
  readonly guestPath: string
  readonly access: 'read-only' | 'read-write'
}

/** CPU/RAM budget. Disk quota is offered only when the backend enforces it. */
export interface EnvironmentLimits {
  /** CPU budget in millicores (1000 = one core). */
  readonly cpuMillis: number
  readonly memoryBytes: number
  /**
   * Undefined means the backend does not enforce a disk quota here. The
   * Docker backend rejects any attempt to set one: overlay2 on macOS/Windows
   * does not apply per-container quotas, so promising one would be a lie.
   */
  readonly diskBytes?: number
}

/** Options for creating one environment. Ports default to the backend's pool. */
export interface EnvironmentCreateInput {
  readonly displayName: string
  readonly image: string
  readonly limits: EnvironmentLimits
  readonly internetAccess: boolean
  /** Explicit user-chosen host mounts; validated against the mount policy. */
  readonly mounts: readonly EnvironmentMount[]
  /** Requested host ports; the backend assigns free loopback ports when absent. */
  readonly ports?: EnvironmentPorts
}

/**
 * Observed backend target captured at operation admission. Every mutation
 * keeps this snapshot until it settles: re-selection never retargets an
 * in-flight call, and commands address the immutable container id.
 */
export interface EnvironmentTarget {
  readonly environmentId: EnvironmentId
  /**
   * Full immutable container id from the authoritative `docker inspect .Id` —
   * never a truncated `docker ps` id. Every CLI listing used for matching
   * runs with `--no-trunc`.
   */
  readonly containerId: string
  readonly containerName: string
  readonly networkName: string
  readonly volumeName: string
  readonly ports: EnvironmentPorts
  /**
   * Image id (digest) observed by the backend when the target was captured.
   * Absent means unobserved: pre-mutation verification then runs in its
   * weaker form (labels and id only), so capture sites should record it.
   */
  readonly imageDigest?: string
  readonly capturedAt: number
  /**
   * Immutable Docker network id (`NetworkSettings.Networks[<name>].NetworkID`)
   * observed at capture. Detects network replacement: delete+recreate keeps
   * the name but changes the id.
   */
  readonly networkId?: string
  /**
   * Volume driver observed at capture. Docker volumes carry NO immutable id:
   * their identity is the derived name plus the ownership labels, re-verified
   * on `volume inspect` immediately before every mutation. Accidental
   * recreation preserves name and labels, so the creation-incarnation fields
   * below (`volumeToken`, `volumeCreatedAt`) are what invalidate stale
   * targets and removal previews. A hostile local daemon can lie about any
   * inspection and is explicitly out of the modeled threat scope.
   */
  readonly volumeDriver?: string
  /**
   * Creation-incarnation token label observed on the volume (minted by this
   * backend at volume create). A recreated volume carries a fresh token, so a
   * stale target or preview is invalidated. Absent means never observed.
   */
  readonly volumeToken?: string
  /**
   * `volume inspect .CreatedAt` observed at capture: the creation timestamp
   * backing the token for volumes created before the token label existed.
   * Absent means never observed.
   */
  readonly volumeCreatedAt?: string
}

/**
 * Per-resource ownership/identity verification of one captured target.
 * `foreign` means observed labels contradict plugin ownership; `conflicting`
 * means an identity mismatch (the resource was replaced or recreated, or
 * several claimants exist); `unknown` means the engine could not confirm —
 * callers must treat it exactly like a refusal.
 */
export type ResourceVerification =
  | { kind: 'owned' }
  | { kind: 'missing' }
  | { kind: 'foreign'; reason: string }
  | { kind: 'conflicting'; reason: string }
  | { kind: 'unknown'; reason: string }

/** Verification of every resource one captured target addresses. */
export interface TargetVerification {
  readonly container: ResourceVerification
  readonly network: ResourceVerification
  readonly volume: ResourceVerification
}

/** Result of acquiring a verified target for one environment id from the live backend. */
export type TargetAcquisition =
  | { kind: 'captured'; target: EnvironmentTarget }
  | { kind: 'absent' }
  | { kind: 'foreign'; reason: string }
  | { kind: 'conflicting'; reason: string }
  | { kind: 'unknown'; reason: string }

/** Conversation-to-environment binding projected from Session events. */
export interface EnvironmentBinding {
  readonly sessionKey: string
  readonly environmentId: EnvironmentId
  /** Policy generation the binding was committed under. */
  readonly generation: number
  /** Selection history visible to the model (most recent last). */
  readonly history: readonly EnvironmentId[]
}

/** Observed operational state of one environment. */
export type EnvironmentPhase = 'missing' | 'created' | 'running' | 'paused' | 'stopped' | 'error'

/** Health of the guest services protected mode requires. */
export interface EnvironmentHealth {
  readonly phase: EnvironmentPhase
  readonly shell: Availability
  readonly browser: Availability
  readonly desktop: Availability
  /** Trusted control-plane reachability observation; protected mode requires 'unavailable'. Guest-reported refusal is not trusted. */
  readonly hostControlPlane: Availability
  /** When the observation was taken; consumers treat old observations as stale. */
  readonly observedAt?: number
  /** The target this observation was taken against, when known. */
  readonly target?: EnvironmentTarget
}

/** Whether an observed fact is known, or why it is not. */
export type Availability =
  | { kind: 'available' }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; reason: string }

/** One resource measurement. Stale, unknown, or unsupported values never become zero. */
export interface ResourceSample {
  readonly takenAt: number
  readonly memoryUsedBytes: number | null
  readonly memoryLimitBytes: number | null
  readonly cpuPercent: number | null
  /** Writable-layer size; distinct from mounted volume usage. */
  readonly writableLayerBytes: number | null
  readonly volumeUsedBytes: number | null
  /** True when the sampler could not refresh this value within its staleness bound. */
  readonly stale?: boolean
}

/** Per-kind mutation payload carried by an operation record. */
export type EnvironmentOperationPayload =
  | { readonly kind: 'create'; readonly input: EnvironmentCreateInput }
  | { readonly kind: 'start' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'bind'; readonly sessionKey: string; readonly generation: number }
  | { readonly kind: 'unbind'; readonly sessionKey: string }
  | { readonly kind: 'update-limits'; readonly limits: EnvironmentLimits }
  | { readonly kind: 'remove'; readonly deleteVolumes: boolean }

/** Result of one serialized environment mutation, observable by identity. */
export interface EnvironmentOperation {
  readonly id: string
  readonly environmentId: EnvironmentId
  readonly kind: 'create' | 'start' | 'stop' | 'pause' | 'resume' | 'bind' | 'unbind' | 'update-limits' | 'remove'
  readonly state: 'requested' | 'running' | 'completed' | 'failed'
  readonly error?: string
  /** Machine-readable failure code, when the failure came from a known refusal. */
  readonly errorCode?: string
  /** Caller-supplied dedup key: a repeated request with the same key returns the same operation. */
  readonly idempotencyKey?: string
  readonly payload?: EnvironmentOperationPayload
  /** Target captured when the operation was admitted. */
  readonly target?: EnvironmentTarget
  readonly requestedAt?: number
  readonly settledAt?: number
}

/**
 * Backend driver contract. Every mutation captures the target environment at
 * admission and keeps that destination until the call settles; re-selection
 * never retargets an in-flight call. Duplicate requests are deduplicated by
 * operation identity, and the driver reconciles with the backend after an
 * interruption without deciding ownership from container names.
 */
export interface EnvironmentBackendDriver {
  /**
   * Reconcile durable inventory against observed backend state.
   * @param signal - cancellation.
   * @returns descriptors the backend confirms this plugin owns.
   */
  reconcile(signal: AbortSignal): Promise<readonly EnvironmentDescriptor[]>
  /**
   * Run one mutation through the backend.
   * @param operation - the durable operation record (identity dedup, captured target).
   * @param signal - cancellation.
   * @returns the settled operation.
   */
  run(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation>
  /**
   * Probe the guest services and host control-plane reachability for one target.
   * Unknown is a valid answer: a probe that could not run never reports
   * 'available' or 'unavailable' for the control plane.
   * @param target - the captured target to probe.
   * @param signal - cancellation.
   * @returns the observed health with its observation timestamp.
   */
  probe(target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentHealth>
  /**
   * Acquire a verified target for one environment id from the live backend:
   * labels plus full immutable ids plus observed network/volume identity,
   * read from the inspected descriptor. Backends that cannot verify refuse
   * with `foreign`/`conflicting`/`unknown` instead of guessing. Optional so
   * minimal drivers keep compiling; managers should prefer this over
   * reconstructing a target from inventory records alone.
   * @param environmentId - the durable environment identity.
   * @param signal - cancellation.
   */
  captureTarget?(environmentId: EnvironmentId, signal: AbortSignal): Promise<TargetAcquisition>
  /**
   * Re-verify container/network/volume ownership and identity for a captured
   * target. Read-only. Call immediately before any mutation: a stale or
   * forged target must never produce a mutation against foreign or replaced
   * resources. Backends also self-verify before their own destructive calls.
   * @param target - the captured target to verify.
   * @param signal - cancellation.
   */
  verifyTarget?(target: EnvironmentTarget, signal: AbortSignal): Promise<TargetVerification>
}

/**
 * Durable inventory and binding store. Inventory lives in DSH storage domain;
 * bindings and model-visible transitions are Session events.
 */
export interface EnvironmentRegistry {
  /**
   * List managed and explicitly imported environments.
   * @param signal - cancellation.
   * @returns inventory descriptors, never foreign containers.
   */
  list(signal: AbortSignal): Promise<readonly EnvironmentDescriptor[]>
  /**
   * Read one inventory descriptor.
   * @param id - the environment identity.
   * @returns the descriptor, or undefined when unknown.
   */
  get(id: EnvironmentId): EnvironmentDescriptor | undefined
  /**
   * Read the binding for one conversation.
   * @param sessionKey - the conversation.
   * @returns the binding, or undefined when unbound.
   */
  binding(sessionKey: string): EnvironmentBinding | undefined
}

/**
 * Shared host-side resource sampler. One sampler serves all views with
 * subscriber sharing, configurable cadence, and reduced work while no view is
 * visible; components never poll independently.
 */
export interface TelemetrySampler {
  /**
   * Subscribe to resource samples for one environment.
   * @param environmentId - the environment to sample.
   * @param listener - receives every new sample with its timestamp.
   * @returns the disposer that unsubscribes this view.
   */
  subscribe(environmentId: EnvironmentId, listener: (sample: ResourceSample) => void): () => void
  /**
   * Latest cached sample for one environment, if any. Consumers decide
   * staleness from `takenAt`; absent means never sampled, not zero.
   * @param environmentId - the environment to read.
   * @returns the last sample, or undefined.
   */
  latest(environmentId: EnvironmentId): ResourceSample | undefined
  /** Stop the sampler and drop every subscription (disposal/cancellation). */
  dispose(): void
}

/**
 * Decide whether an environment may host protected mode.
 *
 * Every required guarantee must be VERIFIED, not merely un-refuted:
 * - the environment is running;
 * - shell, browser, and desktop are each observed `available` (unknown or
 *   unavailable refuses — protected mode needs all three services);
 * - host control-plane reachability is observed `unavailable` (unknown refuses);
 * - every mount passes the canonical mount policy when one is supplied, or
 *   the static control-path screen otherwise. The canonical policy is the
 *   real enforcement; the static screen is a fail-closed fallback for callers
 *   without filesystem context.
 * @param descriptor - the durable inventory record.
 * @param health - the latest observed health.
 * @param mountPolicy - canonical mount policy context; without it mounts are
 * only screened statically and the caller must treat the result as provisional.
 * @returns a refusal reason, or undefined when the environment is eligible.
 */
export function protectedModeRefusal(
  descriptor: EnvironmentDescriptor,
  health: EnvironmentHealth,
  mountPolicy?: MountPolicyContext,
): string | undefined {
  if (health.phase !== 'running') return `the environment is ${health.phase}, not running`
  for (const service of ['shell', 'browser', 'desktop'] as const) {
    const availability = health[service]
    if (availability.kind === 'available') continue
    if (availability.kind === 'unknown') return `the guest ${service} service could not be verified: ${availability.reason}`
    return `the guest ${service} service is not available`
  }
  if (health.hostControlPlane.kind !== 'unavailable') {
    if (health.hostControlPlane.kind === 'unknown') {
      return `host control-plane isolation could not be verified: ${health.hostControlPlane.reason}`
    }
    return 'the guest can reach a host control-plane service'
  }
  if (mountPolicy !== undefined) {
    for (const reason of mountPolicyRefusals(descriptor.mounts, mountPolicy)) return reason
  } else {
    for (const mount of descriptor.mounts) {
      const reason = staticMountRefusal(mount)
      if (reason !== undefined) return reason
    }
  }
  return undefined
}
