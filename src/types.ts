/** Values exchanged by the wrapvm tools and settings panel. */

/** One shell command result as the VM tool and Remote face report it. */
export interface ExecResult {
  readonly output: string
  readonly stderr: string
  readonly exitCode: number
}

/** Status snapshot for the UI panel and `vm_status`. */
export interface VmStatus {
  readonly containerName: string
  readonly image: string
  readonly state: string
  readonly running: boolean
  readonly viewerPort: number
  readonly cdpPort: number
  /** Workspace mount path inside the VM, or null when unset. */
  readonly workspaceDir: string | null
  /** Legacy field; always null. Viewer credentials use the separate UI action. */
  readonly viewerUrl: string | null
}

/** One CDP DevTools target as the vm_browser tool reports it. */
export interface CdpTarget {
  readonly id: string
  readonly title: string
  readonly url: string
}


/** One shared sampler update, with unknown measurements represented by null. */
export interface VmResourceUpdate {
  readonly environmentId: string
  readonly resources: {
    readonly takenAt: number
    readonly stale: boolean
    readonly cpuPercent: number | null
    readonly memoryUsedBytes: number | null
    readonly memoryLimitBytes: number | null
    readonly writableLayerBytes: number | null
    readonly volumeUsedBytes: number | null
  }
}

/** Policy shown for the selected conversation. */
export interface VmPolicy {
  readonly sessionKey: string
  readonly mode: 'normal' | 'activating' | 'protected' | 'protected-unavailable'
  readonly generation: number
  readonly stage: string
  readonly environmentId: string | null
  readonly reason: string | null
}

/** Durable conversation binding. */
export interface VmBinding {
  readonly sessionKey: string
  readonly environmentId: string
  readonly generation: number
  readonly history: readonly string[]
}

/** Core policy and binding visibility for one conversation. */
export interface VmSessionView {
  readonly epoch: string
  readonly revision: number
  readonly policy: VmPolicy
  readonly binding: VmBinding | null
  readonly bindingComplete: boolean
}

/** One observable environment operation. */
export interface VmOperationView {
  readonly id: string
  readonly environmentId: string
  readonly kind: string
  readonly state: 'requested' | 'running' | 'completed' | 'failed'
  readonly error: string | null
  readonly errorCode: string | null
  readonly requestedAt: number | null
  readonly settledAt: number | null
}

/** Availability of a guest capability or host isolation check. */
export type VmAvailability = { readonly kind: 'available' | 'unavailable'; readonly reason: null } | { readonly kind: 'unknown'; readonly reason: string }

/** Managed environment and the observations available to the client. */
export interface VmEnvironmentView {
  readonly id: string
  readonly displayName: string
  readonly backend: 'docker'
  readonly ownership: 'plugin' | 'imported'
  readonly image: string
  readonly digest: string
  readonly createdAt: number
  readonly mounts: readonly { readonly hostPath: string; readonly guestPath: string; readonly access: 'read-only' | 'read-write' }[]
  readonly limits: { readonly cpuMillis: number; readonly memoryBytes: number; readonly diskBytes: number | null }
  readonly internetAccess: boolean
  readonly desiredPhase: 'running' | 'stopped' | 'paused' | null
  readonly observed: {
    readonly phase: 'missing' | 'created' | 'running' | 'paused' | 'stopped' | 'error'
    readonly shell: VmAvailability
    readonly browser: VmAvailability
    readonly desktop: VmAvailability
    readonly hostControlPlane: VmAvailability
    readonly observedAt: number | null
  } | null
  readonly resources: VmResourceUpdate['resources'] | null
  readonly bindings: readonly VmBinding[]
  readonly bindingsComplete: boolean
  readonly operations: readonly VmOperationView[]
  readonly uncertainty: string | null
}

/** Read-only inventory and selected-conversation state. */
export interface VmInventorySnapshot {
  readonly environments: readonly VmEnvironmentView[]
  readonly policy: VmPolicy | null
  readonly binding: VmBinding | null
  readonly bindingComplete: boolean
}

/** A viewer credential is returned only after a verified binding is available. */
export interface VmViewerLink {
  readonly url: string
  readonly expiresAt: number | null
  readonly epoch: string
  readonly revision: number
}

/** Details shown before removing an environment. */
export interface VmRemovalPreview {
  environmentId: string
  containerId: string
  volumeName: string
  networkName: string
  displayName: string | null
  hostMounts: string[]
  deleteVolumes: boolean
  confirmToken: string
  expiresAt: number
}
