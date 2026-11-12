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

import { randomUUID } from 'node:crypto'
import { z as validate } from 'zod'
import type {
  Availability,
  EnvironmentBackendDriver,
  EnvironmentDescriptor,
  EnvironmentHealth,
  EnvironmentId,
  EnvironmentOperation,
  EnvironmentPorts,
  EnvironmentTarget,
  ResourceVerification,
  TargetAcquisition,
  TargetVerification,
} from './environments.ts'
import { asEnvironmentId } from './environments.ts'
import { containerNameFor, OWNERSHIP_LABEL, ENVIRONMENT_ID_LABEL } from './inventory.ts'
import { evaluateHostMount, type MountPolicyContext } from './mount-policy.ts'

/** Outcome of one engine invocation (never throws for non-zero exit). */
export interface EngineRunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Bounded engine command port. Throws only when the process could not run. */
export type EngineRunner = (argv: readonly string[], signal: AbortSignal) => Promise<EngineRunResult>

/** Static configuration of the Docker backend. */
export interface DockerBackendConfig {
  /** Engine binary (`docker`). */
  readonly binary: string
  /** Default guest workspace path the persistent volume is mounted at. */
  readonly guestWorkspace: string
  /** Guest viewer port. */
  readonly viewerGuestPort: number
  /** Guest CDP forwarder port. */
  readonly cdpGuestPort: number
  /** Image entrypoint that selects the configured desktop user. */
  readonly guestEntrypoint: string
  /** Reserved endpoint configuration for a future trusted host-side isolation check; guest probes are not trusted. */
  readonly controlPlaneProbes: readonly string[]
  /** Process cap per environment. */
  readonly pidsLimit: number
  /** Per-command timeout for engine calls, in milliseconds. */
  readonly commandTimeoutMs: number
}

export const defaultDockerBackendConfig: DockerBackendConfig = {
  binary: 'docker',
  guestWorkspace: '/home/user/workspace',
  viewerGuestPort: 6080,
  cdpGuestPort: 9223,
  guestEntrypoint: '/opt/wrap/bin/wrap-entrypoint',
  controlPlaneProbes: ['http://172.17.0.1:8765/', 'http://host.docker.internal:8765/'],
  pidsLimit: 512,
  commandTimeoutMs: 120_000,
}

/**
 * Creation-incarnation token label. Minted per volume create and carried on
 * the volume: a recreated volume gets a fresh token, invalidating targets and
 * removal previews captured against the old incarnation. Docker volumes have
 * no immutable id, so this plus the inspected `CreatedAt` is the identity.
 */
export const VOLUME_TOKEN_LABEL = 'dsh.wrapvm.volume-token'

/** Reject paths that cannot be represented unambiguously in mount options. */
function hasUnsafePathCharacters(path: string): boolean {
  return /[\u0000-\u001f\u007f,:"\\]/.test(path)
}

/** Explicit bind-mount argv with validated options. */
function bindMountArgv(src: string, dst: string, readOnly: boolean): string[] {
  const readonlyOption = readOnly ? ',readonly' : ''
  return ['--mount', `type=bind,src=${src},dst=${dst}${readonlyOption}`]
}

function cores(cpuMillis: number): string {
  return (cpuMillis / 1000).toFixed(3)
}

function volumeNameFor(id: EnvironmentId): string {
  return `dsh-wrapvm-${id}-data`
}

function networkNameFor(id: EnvironmentId): string {
  return `dsh-wrapvm-${id}`
}

const dockerInspectSchema = validate.object({
  Id: validate.string(),
  Image: validate.string(),
  State: validate.object({ Status: validate.string() }),
  Config: validate.object({
    Image: validate.string(),
    Entrypoint: validate.array(validate.string()).nullable().optional(),
    Cmd: validate.array(validate.string()).nullable().optional(),
    Env: validate.array(validate.string()).nullable().optional(),
    User: validate.string().optional(),
    Labels: validate.record(validate.string(), validate.string()).optional(),
  }),
  HostConfig: validate.object({
    Memory: validate.number().optional(),
    NanoCpus: validate.number().optional(),
    MemorySwap: validate.number().optional(),
    PidsLimit: validate.number().nullable().optional(),
    Privileged: validate.boolean().optional(),
    CapAdd: validate.array(validate.string()).nullable().optional(),
    CapDrop: validate.array(validate.string()).nullable().optional(),
    SecurityOpt: validate.array(validate.string()).nullable().optional(),
    PidMode: validate.string().optional(),
    IpcMode: validate.string().optional(),
    UsernsMode: validate.string().optional(),
    UTSMode: validate.string().optional(),
    CgroupnsMode: validate.string().optional(),
    Devices: validate.array(validate.unknown()).nullable().optional(),
    DeviceRequests: validate.array(validate.unknown()).nullable().optional(),
    DeviceCgroupRules: validate.array(validate.string()).nullable().optional(),
    NetworkMode: validate.string().optional(),
    PortBindings: validate.record(validate.string(), validate.array(validate.object({
      HostIp: validate.string(), HostPort: validate.string(),
    })).nullable()).optional(),
  }).optional(),
  NetworkSettings: validate.object({
    Networks: validate.record(validate.string(), validate.object({ NetworkID: validate.string().optional() }).optional()).optional(),
    Ports: validate.record(validate.string(),
      validate.array(validate.object({ HostIp: validate.string(), HostPort: validate.string() })).nullable().optional()).optional(),
  }).optional(),
  Mounts: validate.array(validate.object({
    Type: validate.string().optional(),
    Name: validate.string().optional(),
    Source: validate.string().optional(),
    Destination: validate.string().optional(),
    RW: validate.boolean().optional(),
  }).optional()).optional(),
})

type InspectedContainer = validate.infer<typeof dockerInspectSchema>

const imageInspectSchema = validate.object({
  Id: validate.string(),
  Config: validate.object({
    Entrypoint: validate.array(validate.string()).nullable(),
    Cmd: validate.array(validate.string()).nullable(),
    Env: validate.array(validate.string()).nullable(),
    User: validate.string(),
  }),
})

const dockerPsEntrySchema = validate.object({
  ID: validate.string(),
  State: validate.string(),
  Image: validate.string(),
})

const networkInspectSchema = validate.object({
  Name: validate.string(),
  Id: validate.string(),
  Internal: validate.boolean().optional(),
  Labels: validate.record(validate.string(), validate.string()).optional(),
})

const volumeInspectSchema = validate.object({
  Name: validate.string(),
  Driver: validate.string(),
  CreatedAt: validate.string().optional(),
  Labels: validate.record(validate.string(), validate.string()).optional(),
})

/** Observed-or-not outcome: `missing` is definitive, `unknown` must never be assumed away. */
type Observed<T> = { kind: 'found'; value: T } | { kind: 'missing' } | { kind: 'unknown'; reason: string }

/** Volume creation identity captured for a target (see VOLUME_TOKEN_LABEL trust model). */
interface VolumeIdentity {
  readonly driver: string
  readonly createdAt?: string
  readonly token?: string
}

/** Backend-side view of the inventory (structural slice, no import cycle). */
export interface InventoryView {
  list(): readonly EnvironmentDescriptor[]
}

/** Outcome of one reconciliation pass, with the honest three-way split. */
export interface ReconciliationReport {
  /** Inventory records the backend confirms (container present, labels match). */
  readonly confirmed: readonly EnvironmentDescriptor[]
  /** Containers owned by our labels with no inventory record — surfaced, never adopted or deleted. */
  readonly unregistered: readonly EnvironmentDescriptor[]
  /** Inventory records with no matching container (phase 'missing' territory). */
  readonly missing: readonly EnvironmentId[]
  /** Containers claiming an environment id that contradicts the inventory (id reuse conflict). */
  readonly conflicts: readonly { containerId: string; environmentId: string; reason: string }[]
}

/** Refusal codes surfaced on failed operations (machine-readable). */
export const DOCKER_BACKEND_ERROR_CODES = {
  diskQuotaUnsupported: 'disk-quota-unsupported',
  mountDenied: 'mount-denied',
  privilegedDenied: 'privileged-denied',
  portConflict: 'port-conflict',
  containerMissing: 'container-missing',
  invalidTransition: 'invalid-transition',
  engineUnavailable: 'engine-unavailable',
  /** Observed labels contradict plugin ownership of the target environment. */
  resourceForeign: 'resource-foreign',
  /** Identity conflict: multiple claimants, or a resource replaced since capture. */
  resourceConflict: 'resource-conflict',
  /** Ownership could not be confirmed (ambiguous engine answer): fail closed. */
  resourceUnverified: 'resource-unverified',
} as const

/**
 * The Docker implementation of {@link EnvironmentBackendDriver}.
 */
export class DockerEnvironmentBackend implements EnvironmentBackendDriver {
  private lastReport: ReconciliationReport | undefined

  constructor(
    private readonly runner: EngineRunner,
    readonly config: DockerBackendConfig,
    private mountPolicy: MountPolicyContext,
    private readonly inventory: InventoryView,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record host paths explicitly selected in a create request. */
  approveMounts(mounts: readonly { hostPath: string }[]): void {
    this.mountPolicy = { ...this.mountPolicy, approvedRoots: [...this.mountPolicy.approvedRoots, ...mounts.map(mount => mount.hostPath)] }
  }

  /** The most recent reconciliation report, if reconcile() has run. */
  get reconciliationReport(): ReconciliationReport | undefined {
    return this.lastReport
  }

  private async engineRun(argv: readonly string[], signal: AbortSignal): Promise<EngineRunResult> {
    const deadline = AbortSignal.timeout(this.config.commandTimeoutMs)
    const bounded = AbortSignal.any([signal, deadline])
    bounded.throwIfAborted()
    const result = await this.runner([this.config.binary, ...argv], bounded)
    bounded.throwIfAborted()
    return result
  }

  /** Fail-closed engine health check used before any mutation batch. */
  async engineAvailable(signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.engineRun(['version', '--format', '{{.Server.Version}}'], signal)
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------- observation

  private async inspectContainer(containerId: string, signal: AbortSignal): Promise<Observed<InspectedContainer>> {
    const result = await this.engineRun(['inspect', '--format', '{{json .}}', containerId], signal)
    if (result.exitCode !== 0) {
      if (/No such (container|object)/i.test(result.stderr)) return { kind: 'missing' }
      return { kind: 'unknown', reason: `container inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` }
    }
    try {
      return { kind: 'found', value: dockerInspectSchema.parse(JSON.parse(result.stdout.trim())) }
    } catch (error) {
      return { kind: 'unknown', reason: `container inspect output is unparsable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async inspectNetwork(networkName: string, signal: AbortSignal): Promise<Observed<validate.infer<typeof networkInspectSchema>>> {
    const result = await this.engineRun(['network', 'inspect', '--format', '{{json .}}', networkName], signal)
    if (result.exitCode !== 0) {
      if (/No such network|not found/i.test(result.stderr)) return { kind: 'missing' }
      return { kind: 'unknown', reason: `network inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` }
    }
    try {
      return { kind: 'found', value: networkInspectSchema.parse(JSON.parse(result.stdout.trim())) }
    } catch (error) {
      return { kind: 'unknown', reason: `network inspect output is unparsable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async inspectVolume(volumeName: string, signal: AbortSignal): Promise<Observed<validate.infer<typeof volumeInspectSchema>>> {
    const result = await this.engineRun(['volume', 'inspect', '--format', '{{json .}}', volumeName], signal)
    if (result.exitCode !== 0) {
      if (/No such volume/i.test(result.stderr)) return { kind: 'missing' }
      return { kind: 'unknown', reason: `volume inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` }
    }
    try {
      return { kind: 'found', value: volumeInspectSchema.parse(JSON.parse(result.stdout.trim())) }
    } catch (error) {
      return { kind: 'unknown', reason: `volume inspect output is unparsable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Reason the labels contradict plugin ownership of `id`, or undefined when they confirm it. */
  private ownershipMismatch(labels: Record<string, string> | undefined, id: EnvironmentId): string | undefined {
    if (labels?.[OWNERSHIP_LABEL] !== '1') return `the ${OWNERSHIP_LABEL}=1 ownership label is absent`
    const claimed = labels[ENVIRONMENT_ID_LABEL]
    if (claimed !== id) return `the environment id label claims ${claimed ?? 'nothing'}, not ${id}`
    return undefined
  }

  // ---------------------------------------------------------------- reconcile

  /**
   * Reconcile durable inventory against observed backend state via labels and
   * immutable container ids. Never adopts by name, never touches foreign
   * containers, never deletes anything.
   */
  async reconcile(signal: AbortSignal): Promise<readonly EnvironmentDescriptor[]> {
    const report = await this.reconcileReport(signal)
    this.lastReport = report
    return report.confirmed
  }

  /** Full three-way reconciliation split (confirmed / unregistered / missing / conflicts). */
  async reconcileReport(signal: AbortSignal): Promise<ReconciliationReport> {
    // --no-trunc: the listed id must be the full immutable id, or matching
    // against stored inspect ids would spuriously conflict on healthy containers.
    const listed = await this.engineRun(
      ['ps', '-a', '--no-trunc', '--filter', `label=${OWNERSHIP_LABEL}=1`, '--format', '{{json .}}'],
      signal,
    )
    if (listed.exitCode !== 0) {
      throw new Error(`wrapvm-isolate: cannot list owned containers: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`)
    }
    const entries = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => dockerPsEntrySchema.parse(JSON.parse(line)))
    const inventoryRecords = this.inventory.list()
    const byEnvId = new Map<string, EnvironmentDescriptor>()
    for (const record of inventoryRecords) byEnvId.set(record.id, record)

    const confirmed: EnvironmentDescriptor[] = []
    const unregistered: EnvironmentDescriptor[] = []
    const conflicts: { containerId: string; environmentId: string; reason: string }[] = []
    const seenContainers = new Map<EnvironmentId, string>()

    for (const entry of entries) {
      const observed = await this.inspectContainer(entry.ID, signal)
      if (observed.kind === 'missing') continue
      if (observed.kind === 'unknown') {
        conflicts.push({ containerId: entry.ID, environmentId: '', reason: `ownership could not be confirmed: ${observed.reason}` })
        continue
      }
      // The inspected id is authoritative over any listing cell.
      const containerId = observed.value.Id
      const labels = observed.value.Config.Labels
      if (labels?.[OWNERSHIP_LABEL] !== '1') {
        conflicts.push({ containerId, environmentId: '', reason: 'the ownership label claim is contradicted by the inspected container' })
        continue
      }
      const claimedId = labels[ENVIRONMENT_ID_LABEL]
      if (claimedId === undefined) {
        // Owned by label but not id-labeled: foreign-shaped, leave untouched.
        conflicts.push({ containerId, environmentId: '', reason: 'owned label without environment id label' })
        continue
      }
      const environmentId = asEnvironmentId(claimedId)
      const record = byEnvId.get(environmentId)
      if (record === undefined) {
        unregistered.push(this.observedDescriptor(environmentId, containerId, observed.value))
        continue
      }
      if (seenContainers.has(environmentId)) {
        conflicts.push({ containerId, environmentId, reason: 'a second container claims the same environment id' })
        continue
      }
      seenContainers.set(environmentId, containerId)
      if (record.containerId !== containerId && record.containerId !== '') {
        conflicts.push({ containerId, environmentId, reason: `inventory binds container ${record.containerId}, backend shows ${containerId}` })
        continue
      }
      confirmed.push(this.observedDescriptor(environmentId, containerId, observed.value, record))
    }

    const missing = inventoryRecords.filter(record => !seenContainers.has(record.id)).map(record => record.id)
    return { confirmed, unregistered, missing, conflicts }
  }

  private observedDescriptor(
    id: EnvironmentId,
    containerId: string,
    inspected: InspectedContainer,
    base?: EnvironmentDescriptor,
  ): EnvironmentDescriptor {
    const networks = Object.keys(inspected.NetworkSettings?.Networks ?? {})
    const ports = this.parsePublishedPorts(inspected)
    return {
      ...(base ?? {
        id,
        backend: 'docker' as const,
        ownership: 'plugin' as const,
        image: inspected.Config.Image,
        digest: inspected.Image,
        createdAt: this.now(),
        mounts: [],
        limits: {
          cpuMillis: Math.round((inspected.HostConfig?.NanoCpus ?? 0) / 1e6) || 2_000,
          memoryBytes: inspected.HostConfig?.Memory || 4 * 2 ** 30,
        },
        internetAccess: true,
      }),
      id,
      containerId,
      image: inspected.Config.Image,
      digest: inspected.Image,
      ...(networks.length > 0 ? { networkName: networks[0] } : {}),
      ...(ports !== undefined ? { ports } : {}),
    }
  }

  private matchesPortBindings(
    bindings: Record<string, Array<{ HostIp: string; HostPort: string }> | null | undefined> | undefined,
    requested: EnvironmentPorts | undefined,
    configured: boolean,
  ): boolean {
    if (bindings === undefined) return false
    const expected = [[`${this.config.viewerGuestPort}/tcp`, requested?.viewerPort],
      [`${this.config.cdpGuestPort}/tcp`, requested?.cdpPort]] as const
    if (Object.entries(bindings).some(([key, value]) => value != null && !expected.some(([port]) => port === key))) return false
    return expected.every(([key, port]) => {
      const values = bindings[key]
      if (values?.length !== 1 || values[0]?.HostIp !== '127.0.0.1') return false
      const actual = values[0].HostPort
      if (port !== undefined) return actual === String(port)
      if (configured) return actual === '' || actual === '0'
      return /^[0-9]+$/.test(actual) && Number(actual) > 0 && Number(actual) <= 65535
    })
  }

  private parsePublishedPorts(inspected: InspectedContainer): EnvironmentPorts | undefined {
    const ports = inspected.NetworkSettings?.Ports
    if (ports === undefined) return undefined
    const read = (guestPort: number): number | undefined => {
      const bindings = ports[`${guestPort}/tcp`]
      const binding = bindings?.[0]
      if (binding === undefined || binding.HostPort === '') return undefined
      return Number(binding.HostPort)
    }
    const viewerPort = read(this.config.viewerGuestPort)
    const cdpPort = read(this.config.cdpGuestPort)
    if (viewerPort === undefined || cdpPort === undefined) return undefined
    return { viewerPort, cdpPort }
  }

  private networkIdOf(inspected: InspectedContainer, networkName: string): string | undefined {
    return inspected.NetworkSettings?.Networks?.[networkName]?.NetworkID
  }

  // ------------------------------------------------------- target verification

  /**
   * Acquire a verified target for one environment id: labels plus full
   * immutable ids plus observed network/volume identity, read from the
   * inspected descriptors. Foreign or multiple claimants fail closed.
   */
  async captureTarget(environmentId: EnvironmentId, signal: AbortSignal): Promise<TargetAcquisition> {
    const listing = await this.listOwnedContainerIds(environmentId, signal)
    if (listing.kind === 'unknown') return { kind: 'unknown', reason: listing.reason }
    if (listing.ids.length > 1) {
      return { kind: 'conflicting', reason: `${listing.ids.length} containers claim environment id ${environmentId}` }
    }
    if (listing.ids.length === 0) return { kind: 'absent' }
    const listingId = listing.ids[0]
    if (listingId === undefined) return { kind: 'unknown', reason: 'container listing was empty' }
    const observed = await this.inspectContainer(listingId, signal)
    if (observed.kind === 'missing') return { kind: 'unknown', reason: 'the listing claimed a container the inspect cannot find' }
    if (observed.kind === 'unknown') return { kind: 'unknown', reason: observed.reason }
    const inspected = observed.value
    if (inspected.Id !== listingId) {
      return { kind: 'conflicting', reason: `the listing id ${listingId} resolves to inspected id ${inspected.Id}` }
    }
    const mismatch = this.ownershipMismatch(inspected.Config.Labels, environmentId)
    if (mismatch !== undefined) return { kind: 'foreign', reason: `container ${inspected.Id}: ${mismatch}` }

    const networkName = networkNameFor(environmentId)
    const volumeName = volumeNameFor(environmentId)
    const network = await this.inspectNetwork(networkName, signal)
    if (network.kind !== 'found') return { kind: 'unknown', reason: network.kind === 'missing' ? `network ${networkName} is missing` : network.reason }
    const networkMismatch = this.ownershipMismatch(network.value.Labels, environmentId)
    if (networkMismatch !== undefined) return { kind: 'foreign', reason: `network ${networkName}: ${networkMismatch}` }
    const volume = await this.inspectVolume(volumeName, signal)
    if (volume.kind !== 'found') return { kind: 'unknown', reason: volume.kind === 'missing' ? `volume ${volumeName} is missing` : volume.reason }
    const volumeMismatch = this.ownershipMismatch(volume.value.Labels, environmentId)
    if (volumeMismatch !== undefined) return { kind: 'foreign', reason: `volume ${volumeName}: ${volumeMismatch}` }

    const running = inspected.State.Status === 'running' || inspected.State.Status === 'paused'
    const attachedId = this.networkIdOf(inspected, networkName)
    const networkMatches = running ? attachedId === network.value.Id
      : (attachedId ? attachedId === network.value.Id : inspected.HostConfig?.NetworkMode === networkName || Object.hasOwn(inspected.NetworkSettings?.Networks ?? {}, networkName))
    if (!networkMatches || !(inspected.Mounts ?? []).some(m => m?.Type === 'volume' && m.Name === volumeName && m.Destination === this.config.guestWorkspace)) {
      return { kind: 'conflicting', reason: 'container network or workspace volume does not match inspected resources' }
    }
    let ports: EnvironmentPorts
    if (running) {
      const livePorts = this.parsePublishedPorts(inspected)
      if (livePorts === undefined || !this.matchesPortBindings(inspected.NetworkSettings?.Ports, livePorts, false)) return { kind: 'unknown', reason: 'loopback viewer and CDP ports are unavailable' }
      ports = livePorts
    } else {
      if (!this.matchesPortBindings(inspected.HostConfig?.PortBindings, undefined, true) && !this.matchesPortBindings(inspected.HostConfig?.PortBindings, undefined, false)) return { kind: 'unknown', reason: 'configured viewer and CDP ports are not loopback-published' }
      ports = { viewerPort: 0, cdpPort: 0 }
    }
    const target = this.target(environmentId, inspected.Id, inspected, ports, {
      networkId: network.value.Id,
      volumeDriver: volume.value.Driver,
      ...(volume.value.CreatedAt !== undefined ? { volumeCreatedAt: volume.value.CreatedAt } : {}),
      ...(volume.value.Labels?.[VOLUME_TOKEN_LABEL] !== undefined ? { volumeToken: volume.value.Labels[VOLUME_TOKEN_LABEL] } : {}),
    })
    return { kind: 'captured', target }
  }

  /**
   * Re-verify container/network/volume ownership and identity for a captured
   * target. Read-only; every mutation in this backend runs the container
   * verification itself before touching the engine, and removal re-verifies
   * network and volume immediately before their own removals.
   */
  async verifyTarget(target: EnvironmentTarget, signal: AbortSignal): Promise<TargetVerification> {
    const container = await this.verifyContainer(target, signal)
    const network = await this.verifyNetwork(target, signal)
    const volume = await this.verifyVolume(target, signal)
    return { container, network, volume }
  }

  /** Container verification paired with the inspected payload (status reads reuse it). */
  private async verifiedContainer(
    target: EnvironmentTarget,
    signal: AbortSignal,
  ): Promise<{ kind: 'owned'; inspected: InspectedContainer } | { kind: 'missing' } | { kind: 'refused'; verification: ResourceVerification }> {
    const observed = await this.inspectContainer(target.containerId, signal)
    if (observed.kind === 'missing') return { kind: 'missing' }
    if (observed.kind === 'unknown') return { kind: 'refused', verification: { kind: 'unknown', reason: observed.reason } }
    const inspected = observed.value
    if (inspected.Id !== target.containerId) {
      return { kind: 'refused', verification: { kind: 'conflicting', reason: `container ${target.containerId} resolves to inspected id ${inspected.Id}` } }
    }
    const mismatch = this.ownershipMismatch(inspected.Config.Labels, target.environmentId)
    if (mismatch !== undefined) {
      return { kind: 'refused', verification: { kind: 'foreign', reason: `container ${target.containerId}: ${mismatch}` } }
    }
    if (target.imageDigest !== undefined && inspected.Image !== target.imageDigest) {
      return {
        kind: 'refused',
        verification: { kind: 'conflicting', reason: `the container image id changed since capture (now ${inspected.Image})` },
      }
    }
    return { kind: 'owned', inspected }
  }

  private async verifyContainer(target: EnvironmentTarget, signal: AbortSignal): Promise<ResourceVerification> {
    const result = await this.verifiedContainer(target, signal)
    if (result.kind === 'owned') return { kind: 'owned' }
    return result.kind === 'missing' ? { kind: 'missing' } : result.verification
  }

  private async verifyNetwork(target: EnvironmentTarget, signal: AbortSignal): Promise<ResourceVerification> {
    if (target.networkName !== networkNameFor(target.environmentId)) return { kind: 'conflicting', reason: 'network name does not match the environment' }
    const observed = await this.inspectNetwork(target.networkName, signal)
    if (observed.kind === 'missing') return { kind: 'missing' }
    if (observed.kind === 'unknown') return { kind: 'unknown', reason: observed.reason }
    if (observed.value.Name !== target.networkName) return { kind: 'conflicting', reason: 'inspected network name differs from the target' }
    if (target.networkId === undefined || target.networkId === '') return { kind: 'unknown', reason: 'network id was not captured' }
    const mismatch = this.ownershipMismatch(observed.value.Labels, target.environmentId)
    if (mismatch !== undefined) return { kind: 'foreign', reason: `network ${target.networkName}: ${mismatch}` }
    if (observed.value.Id !== target.networkId) {
      return {
        kind: 'conflicting',
        reason: `network ${target.networkName} was recreated since capture (id ${observed.value.Id}, captured ${target.networkId})`,
      }
    }
    return { kind: 'owned' }
  }

  private async verifyVolume(target: EnvironmentTarget, signal: AbortSignal): Promise<ResourceVerification> {
    if (target.volumeName !== volumeNameFor(target.environmentId)) return { kind: 'conflicting', reason: 'volume name does not match the environment' }
    const observed = await this.inspectVolume(target.volumeName, signal)
    if (observed.kind === 'missing') return { kind: 'missing' }
    if (observed.kind === 'unknown') return { kind: 'unknown', reason: observed.reason }
    const volume = observed.value
    if (volume.Name !== target.volumeName) return { kind: 'conflicting', reason: 'inspected volume name differs from the target' }
    const mismatch = this.ownershipMismatch(volume.Labels, target.environmentId)
    if (mismatch !== undefined) return { kind: 'foreign', reason: `volume ${target.volumeName}: ${mismatch}` }
    if (target.volumeDriver !== undefined && volume.Driver !== target.volumeDriver) {
      return { kind: 'conflicting', reason: `volume ${target.volumeName} reports driver ${volume.Driver}, captured ${target.volumeDriver}` }
    }
    const liveToken = volume.Labels?.[VOLUME_TOKEN_LABEL]
    if (target.volumeToken !== undefined && liveToken !== target.volumeToken) {
      return {
        kind: 'conflicting',
        reason: `volume ${target.volumeName} is a different creation incarnation (token ${liveToken ?? 'absent'}, captured ${target.volumeToken})`,
      }
    }
    if (target.volumeCreatedAt !== undefined && volume.CreatedAt === undefined) return { kind: 'unknown', reason: 'volume creation timestamp is unavailable' }
    if (target.volumeCreatedAt !== undefined && volume.CreatedAt !== target.volumeCreatedAt) {
      return {
        kind: 'conflicting',
        reason: `volume ${target.volumeName} was created ${volume.CreatedAt}, captured ${target.volumeCreatedAt}`,
      }
    }
    return { kind: 'owned' }
  }

  // -------------------------------------------------------------------- run

  /**
   * Execute one mutation against the captured target. Validation refusals
   * settle the operation as `failed` with a precise code; they never reach
   * the engine. Cancellation propagates.
   */
  async run(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation> {
    if (operation.target !== undefined && operation.target.environmentId !== operation.environmentId) return this.fail(operation, 'target belongs to a different environment', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
    switch (operation.kind) {
      case 'create': return await this.runCreate(operation, signal)
      case 'start': return await this.runState(operation, ['start'], signal)
      case 'stop': return await this.runState(operation, ['stop'], signal)
      case 'pause': return await this.runPause(operation, signal)
      case 'resume': return await this.runResume(operation, signal)
      case 'update-limits': return await this.runUpdateLimits(operation, signal)
      case 'remove': return await this.runRemove(operation, signal)
      case 'bind':
      case 'unbind':
        // Session-level mutations: no backend work, the target is untouched.
        return { ...operation, state: 'completed', settledAt: this.now() }
      default: {
        const kind: string = operation.kind
        return { ...operation, state: 'failed', error: `unknown operation kind ${kind}`, errorCode: 'invalid-transition', settledAt: this.now() }
      }
    }
  }

  private fail(operation: EnvironmentOperation, error: string, errorCode: string): EnvironmentOperation {
    return { ...operation, state: 'failed', error, errorCode, settledAt: this.now() }
  }

  /** Settle a verification outcome that blocks a mutation. */
  private refuseVerification(operation: EnvironmentOperation, resource: string, verification: ResourceVerification): EnvironmentOperation {
    if (verification.kind === 'foreign') return this.fail(operation, `${resource} is not ours: ${verification.reason}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign)
    if (verification.kind === 'conflicting') return this.fail(operation, `${resource} contradicts the captured target: ${verification.reason}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict)
    return this.fail(operation, `${resource} ownership could not be confirmed: ${verification.kind === 'unknown' ? verification.reason : 'unknown'}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
  }

  private async listOwnedContainerIds(id: EnvironmentId, signal: AbortSignal): Promise<{ kind: 'listed'; ids: string[] } | { kind: 'unknown'; reason: string }> {
    const result = await this.engineRun(
      [
        'ps', '-a', '--no-trunc',
        '--filter', `label=${OWNERSHIP_LABEL}=1`,
        '--filter', `label=${ENVIRONMENT_ID_LABEL}=${id}`,
        '--format', '{{.ID}}',
      ],
      signal,
    )
    if (result.exitCode !== 0) {
      return { kind: 'unknown', reason: `listing owned containers failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` }
    }
    return { kind: 'listed', ids: result.stdout.split('\n').map(line => line.trim()).filter(Boolean) }
  }

  private target(
    id: EnvironmentId,
    containerId: string,
    inspected: InspectedContainer,
    ports: EnvironmentPorts | undefined,
    identity: { networkId?: string; volumeDriver?: string; volumeCreatedAt?: string; volumeToken?: string } = {},
  ): EnvironmentTarget {
    const networkName = networkNameFor(id)
    return {
      environmentId: id,
      containerId,
      containerName: containerNameFor(id),
      networkName,
      volumeName: volumeNameFor(id),
      ports: ports ?? { viewerPort: this.config.viewerGuestPort, cdpPort: this.config.cdpGuestPort },
      imageDigest: inspected.Image,
      capturedAt: this.now(),
      ...(identity.networkId !== undefined ? { networkId: identity.networkId } : {}),
      ...(identity.volumeDriver !== undefined ? { volumeDriver: identity.volumeDriver } : {}),
      ...(identity.volumeCreatedAt !== undefined ? { volumeCreatedAt: identity.volumeCreatedAt } : {}),
      ...(identity.volumeToken !== undefined ? { volumeToken: identity.volumeToken } : {}),
    }
  }

  private async runCreate(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation> {
    const input = operation.payload?.kind === 'create' ? operation.payload.input : undefined
    if (input === undefined) return this.fail(operation, 'create operation without a create payload', 'invalid-transition')
    if (input.limits.diskBytes !== undefined) {
      return this.fail(operation, 'the Docker backend cannot enforce per-container disk quotas on this host (overlay2); use the reported usage field instead', DOCKER_BACKEND_ERROR_CODES.diskQuotaUnsupported)
    }
    const requested = input.ports
    if (requested !== undefined && (requested.viewerPort === requested.cdpPort || requested.viewerPort === 0 || requested.cdpPort === 0)) {
      return this.fail(operation, 'requested viewer and CDP host ports must be distinct non-zero ports', DOCKER_BACKEND_ERROR_CODES.portConflict)
    }
    const bindArgs: string[] = []
    const requestedMounts: { source: string; destination: string; writable: boolean }[] = []
    for (const mount of input.mounts) {
      if (mount.guestPath === this.config.guestWorkspace) {
        return this.fail(operation, `the mount guest path ${mount.guestPath} would shadow the persistent workspace volume`, DOCKER_BACKEND_ERROR_CODES.mountDenied)
      }
      const decision = evaluateHostMount(mount, this.mountPolicy)
      if (!decision.ok) return this.fail(operation, decision.reason ?? 'mount refused', DOCKER_BACKEND_ERROR_CODES.mountDenied)
      const canonical = decision.canonicalPath ?? ''
      if (hasUnsafePathCharacters(canonical) || hasUnsafePathCharacters(mount.guestPath)) {
        return this.fail(operation, 'the mount paths contain ambiguous separators or control characters', DOCKER_BACKEND_ERROR_CODES.mountDenied)
      }
      bindArgs.push(...bindMountArgv(canonical, mount.guestPath, mount.access === 'read-only'))
      requestedMounts.push({ source: canonical, destination: mount.guestPath, writable: mount.access === 'read-write' })
    }
    const id = operation.environmentId
    const name = containerNameFor(id)
    const networkName = networkNameFor(id)
    const volumeName = volumeNameFor(id)

    // Idempotence: a container already claiming this environment id is adopted
    // — but only after its FULL identity and configuration are inspected and
    // confirmed. Foreign, multiple, or conflicting claimants fail closed.
    const listing = await this.listOwnedContainerIds(id, signal)
    if (listing.kind === 'unknown') {
      return this.fail(operation, `cannot check for an existing container: ${listing.reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
    }
    if (listing.ids.length > 1) {
      return this.fail(
        operation,
        `${listing.ids.length} containers claim environment id ${id} (${listing.ids.join(', ')}); refusing to adopt any of them`,
        DOCKER_BACKEND_ERROR_CODES.resourceConflict,
      )
    }
    if (listing.ids.length === 1) {
      const listingId = listing.ids[0]
      if (listingId === undefined) return this.fail(operation, 'container listing was empty', DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
      const observed = await this.inspectContainer(listingId, signal)
      if (observed.kind !== 'found') {
        const reason = observed.kind === 'missing' ? 'the listing claimed a container the inspect cannot find' : observed.reason
        return this.fail(operation, `existing container cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
      }
      const inspected = observed.value
      if (inspected.Id !== listingId) {
        return this.fail(operation, `the listing id ${listingId} resolves to inspected id ${inspected.Id}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      const mismatch = this.ownershipMismatch(inspected.Config.Labels, id)
      if (mismatch !== undefined) {
        return this.fail(operation, `the existing container is not ours: ${mismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign)
      }
      if (inspected.Config.Image !== input.image) {
        return this.fail(
          operation,
          `the existing container runs image ${inspected.Config.Image}, not the requested ${input.image}; refusing to adopt a different configuration`,
          DOCKER_BACKEND_ERROR_CODES.resourceConflict,
        )
      }
      const imageResult = await this.engineRun(['image', 'inspect', '--format', '{{json .}}', inspected.Image], signal)
      let image: validate.infer<typeof imageInspectSchema>
      try {
        if (imageResult.exitCode !== 0) throw new Error('image inspect failed')
        image = imageInspectSchema.parse(JSON.parse(imageResult.stdout))
      } catch {
        return this.fail(operation, 'the container image configuration cannot be verified', DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
      }
      if (image.Id !== inspected.Image || inspected.Config.Entrypoint === undefined || inspected.Config.Cmd === undefined ||
        inspected.Config.Env === undefined || inspected.Config.User === undefined ||
        inspected.Config.User !== image.Config.User || JSON.stringify(inspected.Config.Env) !== JSON.stringify(image.Config.Env) ||
        JSON.stringify(inspected.Config.Entrypoint) !== JSON.stringify(image.Config.Entrypoint) ||
        JSON.stringify(inspected.Config.Cmd) !== JSON.stringify(image.Config.Cmd)) {
        return this.fail(operation, 'existing container user, environment, entrypoint or command differs from its image', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      if (inspected.State.Status !== 'running' && inspected.State.Status !== 'created') {
        return this.fail(operation, 'only running or never-started containers can be adopted', DOCKER_BACKEND_ERROR_CODES.invalidTransition)
      }
      const networkNames = Object.keys(inspected.NetworkSettings?.Networks ?? {})
      if (networkNames.length !== 1 || !networkNames.includes(networkName)) {
        return this.fail(operation, `the existing container is not attached to the environment network ${networkName}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      if (!(inspected.Mounts ?? []).some(mount => mount?.Type === 'volume' && mount.Name === volumeName && mount.Destination === this.config.guestWorkspace && mount.RW === true)) {
        return this.fail(operation, `the existing container does not attach the environment volume ${volumeName}`, DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      if ((inspected.Mounts ?? []).some(mount => mount === undefined || (mount.Type !== 'bind' && !(mount.Type === 'volume' && mount.Name === volumeName && mount.Destination === this.config.guestWorkspace))) || (inspected.Mounts ?? []).filter(mount => mount?.Type === 'volume').length !== 1) {
        return this.fail(operation, 'existing container has unexpected mounts', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      const actualBinds = (inspected.Mounts ?? []).filter(mount => mount?.Type === 'bind')
      if (actualBinds.length !== requestedMounts.length || requestedMounts.some(expected => !actualBinds.some(actual =>
        actual?.Source === expected.source && actual.Destination === expected.destination && actual.RW === expected.writable))) {
        return this.fail(operation, 'existing container bind mounts differ from the requested configuration', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      if (inspected.HostConfig?.Memory !== input.limits.memoryBytes || inspected.HostConfig.NanoCpus !== input.limits.cpuMillis * 1e6) {
        return this.fail(operation, 'existing container limits differ from the requested configuration', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      const host = inspected.HostConfig
      const expectedCaps = ['CHOWN', 'FOWNER', 'SETUID', 'SETGID', 'KILL']
      const caps = host.CapAdd?.map(cap => cap.replace(/^CAP_/, ''))
      if (host.MemorySwap !== input.limits.memoryBytes || host.PidsLimit !== this.config.pidsLimit || host.Privileged !== false ||
        host.CapDrop?.length !== 1 || host.CapDrop[0] !== 'ALL' || caps?.length !== expectedCaps.length ||
        expectedCaps.some(cap => !caps.includes(cap)) || host.SecurityOpt?.length !== 1 ||
        !['no-new-privileges', 'no-new-privileges:true'].includes(host.SecurityOpt[0] ?? '') ||
        host.PidMode !== '' || !['', 'private'].includes(host.IpcMode ?? 'unknown') || host.UsernsMode !== '' ||
        host.UTSMode !== '' || !['', 'private'].includes(host.CgroupnsMode ?? 'unknown') ||
        host.Devices === undefined || (host.Devices !== null && host.Devices.length !== 0) ||
        host.DeviceRequests === undefined || (host.DeviceRequests !== null && host.DeviceRequests.length !== 0) ||
        host.DeviceCgroupRules === undefined || (host.DeviceCgroupRules !== null && host.DeviceCgroupRules.length !== 0) ||
        host.NetworkMode !== networkName) {
        return this.fail(operation, 'existing container security settings differ from the required configuration', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      if (!this.matchesPortBindings(host.PortBindings, requested, true)) {
        return this.fail(operation, 'existing container configured port bindings differ from the request', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      const volume = await this.inspectVolume(volumeName, signal)
      if (volume.kind !== 'found') {
        const reason = volume.kind === 'missing' ? `the claimed container mounts volume ${volumeName} but the inspect cannot find it` : volume.reason
        return this.fail(operation, `existing volume cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
      }
      const volumeMismatch = this.ownershipMismatch(volume.value.Labels, id)
      if (volumeMismatch !== undefined) {
        return this.fail(operation, `the existing volume is not ours: ${volumeMismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign)
      }
      const network = await this.inspectNetwork(networkName, signal)
      if (network.kind !== 'found') {
        const reason = network.kind === 'missing' ? `the claimed container is attached to network ${networkName} but the inspect cannot find it` : network.reason
        return this.fail(operation, `existing network cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
      }
      const networkMismatch = this.ownershipMismatch(network.value.Labels, id)
      if (networkMismatch !== undefined) {
        return this.fail(operation, `the existing network is not ours: ${networkMismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign)
      }
      const attachedNetworkId = this.networkIdOf(inspected, networkName)
      if ((inspected.State.Status === 'running' && attachedNetworkId !== network.value.Id) ||
        (inspected.State.Status === 'created' && attachedNetworkId !== undefined && attachedNetworkId !== '' && attachedNetworkId !== network.value.Id) ||
        network.value.Internal !== !input.internetAccess) {
        return this.fail(operation, 'existing network identity or internet configuration differs from the request', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      let runtime = inspected
      if (inspected.State.Status === 'created') {
        signal.throwIfAborted()
        const start = await this.engineRun(['start', inspected.Id], signal)
        if (start.exitCode !== 0) return this.fail(operation, `start after recovery failed: ${start.stderr.trim()}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
        const started = await this.inspectContainer(inspected.Id, signal)
        if (started.kind !== 'found' || started.value.Id !== inspected.Id || started.value.Image !== inspected.Image ||
          this.ownershipMismatch(started.value.Config.Labels, id) !== undefined || started.value.State.Status !== 'running' ||
          this.networkIdOf(started.value, networkName) !== network.value.Id) {
          return this.fail(operation, 'recovered container could not be verified after start', DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
        }
        runtime = started.value
      }
      if (!this.matchesPortBindings(runtime.NetworkSettings?.Ports, requested, false)) {
        return this.fail(operation, 'existing container runtime port bindings differ from the request', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      }
      const ports = this.parsePublishedPorts(runtime)
      if (ports === undefined) return this.fail(operation, 'published ports could not be resolved', DOCKER_BACKEND_ERROR_CODES.portConflict)
      return {
        ...operation,
        state: 'completed',
        settledAt: this.now(),
        target: this.target(id, runtime.Id, runtime, ports, {
          networkId: network.value.Id,
          volumeDriver: volume.value.Driver,
          ...(volume.value.CreatedAt !== undefined ? { volumeCreatedAt: volume.value.CreatedAt } : {}),
          ...(volume.value.Labels?.[VOLUME_TOKEN_LABEL] !== undefined ? { volumeToken: volume.value.Labels[VOLUME_TOKEN_LABEL] } : {}),
        }),
      }
    }

    // Fresh create. The volume token is minted now and carried as a label: it
    // is this volume's creation-incarnation identity (volumes have no id).
    const volumeToken = randomUUID()
    const networkArgv = ['network', 'create', '--label', `${OWNERSHIP_LABEL}=1`, '--label', `${ENVIRONMENT_ID_LABEL}=${id}`, '--driver', 'bridge']
    if (!input.internetAccess) networkArgv.push('--internal')
    networkArgv.push(networkName)
    const volumeArgv = [
      'volume', 'create',
      '--label', `${OWNERSHIP_LABEL}=1`,
      '--label', `${ENVIRONMENT_ID_LABEL}=${id}`,
      '--label', `${VOLUME_TOKEN_LABEL}=${volumeToken}`,
      volumeName,
    ]

    let networkId: string | undefined
    const network = await this.engineRun(networkArgv, signal)
    if (network.exitCode === 0) {
      networkId = network.stdout.trim() || undefined
    } else if (/already exists/i.test(network.stderr)) {
      // "already exists" is only idempotence when the existing network is OURS.
      const existing = await this.inspectNetwork(networkName, signal)
      if (existing.kind !== 'found') {
        const reason = existing.kind === 'missing' ? 'the create reported the network exists but the inspect cannot find it' : existing.reason
        return this.fail(operation, `existing network cannot be verified: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
      }
      const mismatch = this.ownershipMismatch(existing.value.Labels, id)
      if (mismatch !== undefined) {
        return this.fail(operation, `network ${networkName} already exists and is not ours: ${mismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign)
      }
      if (existing.value.Internal !== !input.internetAccess) return this.fail(operation, 'existing network internet configuration differs from the request', DOCKER_BACKEND_ERROR_CODES.resourceConflict)
      networkId = existing.value.Id
    } else {
      return this.fail(operation, `backend setup failed (network create): ${network.stderr.trim() || `exit ${network.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    }

    const volume = await this.engineRun(volumeArgv, signal)
    if (volume.exitCode !== 0 && !/already exists/i.test(volume.stderr)) {
      return this.fail(operation, `backend setup failed (volume create): ${volume.stderr.trim() || `exit ${volume.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    }
    // `docker volume create` SILENTLY reuses an existing volume of the same
    // name (exit 0, our labels never applied), so success proves nothing: the
    // inspected labels are the only ownership evidence, fresh either way.
    const existingVolume = await this.inspectVolume(volumeName, signal)
    if (existingVolume.kind !== 'found') {
      const reason = existingVolume.kind === 'missing' ? 'the volume create reported success but the inspect cannot find it' : existingVolume.reason
      return this.fail(operation, `volume identity cannot be established: ${reason}`, DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
    }
    const volumeMismatch = this.ownershipMismatch(existingVolume.value.Labels, id)
    if (volumeMismatch !== undefined) {
      return this.fail(operation, `volume ${volumeName} exists and is not ours: ${volumeMismatch}`, DOCKER_BACKEND_ERROR_CODES.resourceForeign)
    }
    const liveToken = existingVolume.value.Labels?.[VOLUME_TOKEN_LABEL]
    const volumeIdentity: VolumeIdentity = {
      driver: existingVolume.value.Driver,
      ...(existingVolume.value.CreatedAt !== undefined ? { createdAt: existingVolume.value.CreatedAt } : {}),
      // The live token is the incarnation identity: a crash-retry reusing its
      // own earlier volume keeps the token that attempt minted.
      ...(liveToken !== undefined ? { token: liveToken } : {}),
    }

    const publish = (hostPort: number | undefined, guestPort: number): string[] =>
      hostPort === undefined ? ['-p', '127.0.0.1::' + String(guestPort)] : ['-p', `127.0.0.1:${hostPort}:${guestPort}`]

    const createArgv = [
      'create',
      '--name', name,
      '--label', `${OWNERSHIP_LABEL}=1`,
      '--label', `${ENVIRONMENT_ID_LABEL}=${id}`,
      '--network', networkName,
      '--volume', `${volumeName}:${this.config.guestWorkspace}`,
      ...bindArgs,
      ...publish(requested?.viewerPort, this.config.viewerGuestPort),
      ...publish(requested?.cdpPort, this.config.cdpGuestPort),
      '--cpus', cores(input.limits.cpuMillis),
      '--memory', String(input.limits.memoryBytes),
      '--memory-swap', String(input.limits.memoryBytes),
      '--pids-limit', String(this.config.pidsLimit),
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      // The image entrypoint starts as uid 0 and setpriv's down to uid/gid 1000
      // (needs SETUID/SETGID); CHOWN/FOWNER cover volume ownership fixups and
      // user-side installs; KILL lets the desktop supervisor manage its own
      // processes. Anything beyond this set needs evidence, not convenience.
      '--cap-add', 'CHOWN',
      '--cap-add', 'FOWNER',
      '--cap-add', 'SETUID',
      '--cap-add', 'SETGID',
      '--cap-add', 'KILL',
      '--restart', 'no',
      input.image,
    ]
    const created = await this.engineRun(createArgv, signal)
    if (created.exitCode !== 0) {
      if (/Conflict. The container name|is already in use/i.test(created.stderr)) {
        return this.fail(operation, `container name ${name} is taken by a container this plugin does not own`, DOCKER_BACKEND_ERROR_CODES.portConflict)
      }
      return this.fail(operation, `create failed: ${created.stderr.trim() || `exit ${created.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    }
    const createdId = created.stdout.trim()
    const createdInspection = await this.inspectContainer(createdId, signal)
    if (createdInspection.kind !== 'found' || createdInspection.value.Id !== createdId || this.ownershipMismatch(createdInspection.value.Config.Labels, id) !== undefined) {
      return this.fail(operation, 'created container identity and ownership could not be verified before start', DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
    }
    const started = await this.engineRun(['start', createdId], signal)
    if (started.exitCode !== 0) {
      return this.fail(operation, `start after create failed: ${started.stderr.trim() || `exit ${started.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    }
    const observed = await this.inspectContainer(created.stdout.trim(), signal)
    if (observed.kind !== 'found') {
      const reason = observed.kind === 'missing' ? 'created container vanished before inspection' : observed.reason
      return this.fail(operation, reason, DOCKER_BACKEND_ERROR_CODES.containerMissing)
    }
    const inspected = observed.value
    const ports = this.parsePublishedPorts(inspected) ?? requested
    if (ports === undefined) return this.fail(operation, 'ephemeral loopback ports could not be resolved after create', DOCKER_BACKEND_ERROR_CODES.portConflict)
    return {
      ...operation,
      state: 'completed',
      settledAt: this.now(),
      target: this.target(id, inspected.Id, inspected, ports, {
        ...(networkId !== undefined ? { networkId } : {}),
        volumeDriver: volumeIdentity.driver,
        ...(volumeIdentity.createdAt !== undefined ? { volumeCreatedAt: volumeIdentity.createdAt } : {}),
        ...(volumeIdentity.token !== undefined ? { volumeToken: volumeIdentity.token } : {}),
      }),
    }
  }

  /**
   * State transitions address the captured FULL container id, but only after
   * the container was re-inspected and confirmed ours: a stale or forged
   * target never stops, starts, pauses, or unpauses a foreign container.
   */
  private async runState(operation: EnvironmentOperation, argv: readonly string[], signal: AbortSignal): Promise<EnvironmentOperation> {
    const target = operation.target
    if (target === undefined) return this.fail(operation, 'state operation without a captured target', 'invalid-transition')
    const verified = await this.verifiedContainer(target, signal)
    if (verified.kind === 'missing') return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing)
    if (verified.kind === 'refused') return this.refuseVerification(operation, 'the container', verified.verification)
    const status = verified.inspected.State.Status
    if (operation.kind === 'start' && status === 'running') return { ...operation, state: 'completed', settledAt: this.now() }
    if (operation.kind === 'start' && status === 'paused') return this.fail(operation, 'the environment is paused; use resume, which keeps the paused-session contract', DOCKER_BACKEND_ERROR_CODES.invalidTransition)
    if (operation.kind === 'stop' && (status === 'exited' || status === 'created')) return { ...operation, state: 'completed', settledAt: this.now() }
    const result = await this.engineRun([...argv, target.containerId], signal)
    if (result.exitCode !== 0) return this.fail(operation, `${operation.kind} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    return { ...operation, state: 'completed', settledAt: this.now() }
  }

  private async runPause(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation> {
    const target = operation.target
    if (target === undefined) return this.fail(operation, 'pause operation without a captured target', 'invalid-transition')
    const verified = await this.verifiedContainer(target, signal)
    if (verified.kind === 'missing') return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing)
    if (verified.kind === 'refused') return this.refuseVerification(operation, 'the container', verified.verification)
    const status = verified.inspected.State.Status
    if (status === 'paused') return { ...operation, state: 'completed', settledAt: this.now() }
    if (status !== 'running') return this.fail(operation, `cannot pause an environment in state ${status}`, DOCKER_BACKEND_ERROR_CODES.invalidTransition)
    const result = await this.engineRun(['pause', target.containerId], signal)
    if (result.exitCode !== 0) return this.fail(operation, `pause failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    return { ...operation, state: 'completed', settledAt: this.now() }
  }

  private async runResume(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation> {
    const target = operation.target
    if (target === undefined) return this.fail(operation, 'resume operation without a captured target', 'invalid-transition')
    const verified = await this.verifiedContainer(target, signal)
    if (verified.kind === 'missing') return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing)
    if (verified.kind === 'refused') return this.refuseVerification(operation, 'the container', verified.verification)
    const status = verified.inspected.State.Status
    if (status === 'running') return { ...operation, state: 'completed', settledAt: this.now() }
    if (status !== 'paused') return this.fail(operation, `cannot resume an environment in state ${status}; start it instead`, DOCKER_BACKEND_ERROR_CODES.invalidTransition)
    const result = await this.engineRun(['unpause', target.containerId], signal)
    if (result.exitCode !== 0) return this.fail(operation, `resume failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    return { ...operation, state: 'completed', settledAt: this.now() }
  }

  private async runUpdateLimits(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation> {
    const target = operation.target
    const limits = operation.payload?.kind === 'update-limits' ? operation.payload.limits : undefined
    if (target === undefined || limits === undefined) return this.fail(operation, 'update-limits operation without target or limits payload', 'invalid-transition')
    if (limits.diskBytes !== undefined) {
      return this.fail(operation, 'the Docker backend cannot enforce per-container disk quotas on this host (overlay2)', DOCKER_BACKEND_ERROR_CODES.diskQuotaUnsupported)
    }
    const verified = await this.verifiedContainer(target, signal)
    if (verified.kind === 'missing') return this.fail(operation, `container ${target.containerId} no longer exists`, DOCKER_BACKEND_ERROR_CODES.containerMissing)
    if (verified.kind === 'refused') return this.refuseVerification(operation, 'the container', verified.verification)
    const result = await this.engineRun(
      [
        'update',
        '--cpus', cores(limits.cpuMillis),
        '--memory', String(limits.memoryBytes),
        // Swap stays pinned to the memory limit, exactly as on create: an
        // update that moved memory without swap would silently re-open
        // swap headroom the create deliberately closed.
        '--memory-swap', String(limits.memoryBytes),
        target.containerId,
      ],
      signal,
    )
    if (result.exitCode !== 0) return this.fail(operation, `update failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
    return { ...operation, state: 'completed', settledAt: this.now() }
  }

  /**
   * Removal re-verifies every resource immediately before its own mutation.
   * A foreign, replaced, or unverifiable resource is never deleted; host
   * directories are never deleted under any choice. Volume deletion requires
   * the captured creation identity (token or inspected CreatedAt): without it
   * the volume's incarnation cannot be established, so the destructive choice
   * refuses until a fresh {@link captureTarget} verifies it.
   */
  private async runRemove(operation: EnvironmentOperation, signal: AbortSignal): Promise<EnvironmentOperation> {
    const target = operation.target
    const deleteVolumes = operation.payload?.kind === 'remove' ? operation.payload.deleteVolumes : undefined
    if (target === undefined || deleteVolumes === undefined) {
      return this.fail(operation, 'remove requires a captured target and an explicit deleteVolumes choice', 'invalid-transition')
    }
    if (deleteVolumes && target.volumeToken === undefined && target.volumeCreatedAt === undefined) {
      return this.fail(
        operation,
        `volume deletion needs the captured creation identity of ${target.volumeName}: re-capture the target from the inspected descriptor before removing volumes`,
        DOCKER_BACKEND_ERROR_CODES.resourceUnverified,
      )
    }

    const container = await this.verifyContainer(target, signal)
    if (container.kind === 'foreign' || container.kind === 'conflicting' || container.kind === 'unknown') {
      return this.refuseVerification(operation, 'the container', container)
    }
    if (container.kind === 'owned') {
      const removed = await this.engineRun(['rm', '-f', target.containerId], signal)
      if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) {
        return this.fail(operation, `remove failed: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
      }
    }

    const network = await this.verifyNetwork(target, signal)
    if (network.kind === 'owned' && target.networkId === undefined) return this.fail(operation, 'network deletion requires captured network id', DOCKER_BACKEND_ERROR_CODES.resourceUnverified)
    if (network.kind === 'foreign' || network.kind === 'conflicting' || network.kind === 'unknown') {
      return this.refuseVerification(operation, 'the network', network)
    }
    if (network.kind === 'owned') {
      const result = await this.engineRun(['network', 'rm', target.networkId ?? target.networkName], signal)
      if (result.exitCode !== 0 && !/No such network|not found/i.test(result.stderr)) {
        return this.fail(operation, `network removal failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
      }
    }

    if (deleteVolumes) {
      const volume = await this.verifyVolume(target, signal)
      if (volume.kind === 'foreign' || volume.kind === 'conflicting' || volume.kind === 'unknown') {
        return this.refuseVerification(operation, 'the volume', volume)
      }
      if (volume.kind === 'owned') {
        const result = await this.engineRun(['volume', 'rm', target.volumeName], signal)
        if (result.exitCode !== 0 && !/No such volume/i.test(result.stderr)) {
          return this.fail(operation, `volume removal failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`, DOCKER_BACKEND_ERROR_CODES.engineUnavailable)
        }
      }
    }
    return { ...operation, state: 'completed', settledAt: this.now() }
  }

  // ------------------------------------------------------------------- probe

  /**
   * Probe guest services and host control-plane reachability for one target.
   * Every answer is observed or honestly unknown: a probe that could not run
   * never reports availability or isolation.
   */
  async probe(target: EnvironmentTarget, signal: AbortSignal): Promise<EnvironmentHealth> {
    const observedAt = this.now()
    const observed = await this.inspectContainer(target.containerId, signal)
    if (observed.kind === 'unknown') {
      const unknown: Availability = { kind: 'unknown', reason: observed.reason }
      return {
        phase: 'error',
        shell: unknown,
        browser: unknown,
        desktop: unknown,
        hostControlPlane: { kind: 'unknown', reason: `the container state could not be observed: ${observed.reason}` },
        observedAt,
        target,
      }
    }
    const phase = observed.kind === 'missing' ? 'missing' as const : this.phaseOf(observed.value.State.Status)
    if (phase !== 'running') {
      const unavailable: Availability = { kind: 'unavailable' }
      const unknown: Availability = { kind: 'unknown', reason: `the container is ${phase}, not running` }
      return {
        phase,
        shell: phase === 'paused' || phase === 'stopped' || phase === 'missing' ? unavailable : unknown,
        browser: phase === 'paused' || phase === 'stopped' || phase === 'missing' ? unavailable : unknown,
        desktop: phase === 'paused' || phase === 'stopped' || phase === 'missing' ? unavailable : unknown,
        hostControlPlane: { kind: 'unknown', reason: `the container is ${phase}; isolation cannot be observed` },
        observedAt,
        target,
      }
    }
    const shell = await this.probeExec(target, ['true'], signal)
    const browser = await this.probeExec(target, ['curl', '-fsS', '--connect-timeout', '2', 'http://127.0.0.1:9222/json/version'], signal)
    const desktop = await this.probeExec(target, ['curl', '-fsS', '--connect-timeout', '2', `http://127.0.0.1:${this.config.viewerGuestPort}/`], signal)
    const hostControlPlane: Availability = { kind: 'unknown', reason: 'guest-controlled probes cannot verify host control-plane isolation; a trusted host-side check is required' }
    return { phase, shell, browser, desktop, hostControlPlane, observedAt, target }
  }

  private phaseOf(status: string | undefined): EnvironmentHealth['phase'] {
    switch (status) {
      case 'running': return 'running'
      case 'paused': return 'paused'
      case 'restarting': case 'removing': case 'dead': return 'error'
      case undefined: return 'missing'
      default: return 'stopped'
    }
  }

  /** One guest exec probe: exit 0 available, non-zero unavailable, unable-to-run unknown. */
  private async probeExec(target: EnvironmentTarget, argv: readonly string[], signal: AbortSignal): Promise<Availability> {
    try {
      const result = await this.engineRun(['exec', target.containerId, this.config.guestEntrypoint, ...argv], signal)
      if (result.exitCode === 0) return { kind: 'available' }
      if (result.exitCode === 127) return { kind: 'unknown', reason: 'the probe command is not present in the guest image' }
      return { kind: 'unavailable' }
    } catch (error) {
      return { kind: 'unknown', reason: `guest probe could not run: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  // ------------------------------------------------------------------- stats

  /**
   * One bounded `docker stats` batch for the given containers. Rows are only
   * accepted when their (full, `--no-trunc`) id is one of the requested ids.
   * Missing or unparsable values stay null — never zero.
   */
  async stats(
    containerIds: readonly string[], signal: AbortSignal,
  ): Promise<Map<string, { memoryUsedBytes: number | null; memoryLimitBytes: number | null; cpuPercent: number | null }>> {
    const out = new Map<string, { memoryUsedBytes: number | null; memoryLimitBytes: number | null; cpuPercent: number | null }>()
    if (containerIds.length === 0) return out
    const result = await this.engineRun(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...containerIds], signal)
    if (result.exitCode !== 0) return out
    const requested = new Set(containerIds)
    for (const line of result.stdout.split('\n').map(line => line.trim()).filter(Boolean)) {
      try {
        const row = validate.object({
          ID: validate.string(),
          MemUsage: validate.string(),
          CPUPerc: validate.string(),
        }).parse(JSON.parse(line))
        if (!requested.has(row.ID)) continue
        const [used, limit] = row.MemUsage.split('/')
        out.set(row.ID, {
          memoryUsedBytes: parseDockerBytes(used?.trim() ?? ''),
          memoryLimitBytes: parseDockerBytes(limit?.trim() ?? ''),
          cpuPercent: parseDockerPercent(row.CPUPerc),
        })
      } catch {
        // An unparsable row is an absent measurement, not a zero.
      }
    }
    return out
  }

  /** Writable-layer size of one container, or null when unreported. */
  async writableLayerSize(containerId: string, signal: AbortSignal): Promise<number | null> {
    const result = await this.engineRun(['ps', '-a', '-s', '--no-trunc', '--filter', `id=${containerId}`, '--format', '{{.Size}}'], signal)
    if (result.exitCode !== 0) return null
    const size = result.stdout.trim().split(' ')[0]
    return parseDockerBytes(size ?? '')
  }
}

/** Parse a Docker byte expression ("1.234GiB", "12.3MB", "0B") into bytes. */
export function parseDockerBytes(text: string): number | null {
  const match = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)?$/u.exec(text)
  if (match === null) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const units: Record<string, number> = {
    B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
    kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
  }
  const factor = match[2] === undefined ? 1 : units[match[2]]
  if (factor === undefined) return null
  return Math.round(value * factor)
}

/** Parse a Docker percentage cell ("12.34%") into a number, or null. */
export function parseDockerPercent(text: string): number | null {
  const match = /^([\d.]+)%$/u.exec(text.trim())
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}
