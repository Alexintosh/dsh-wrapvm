/** Client-facing v0.2 values. The Host owns their implementation and authorization. */
import type { VmBinding, VmEnvironmentView, VmInventorySnapshot, VmOperationView, VmPolicy, VmResourceUpdate, VmSessionView } from '../types.ts';
export interface Limits {
    cpuMillis: number;
    memoryBytes: number;
    diskBytes: number | null;
}
export interface Mount {
    hostPath: string;
    guestPath: string;
    access: 'read-only' | 'read-write';
}
export type Resources = VmResourceUpdate['resources'];
export type Policy = VmPolicy;
export type Binding = VmBinding;
export type Operation = VmOperationView;
export type Environment = VmEnvironmentView;
export type Snapshot = VmInventorySnapshot;
export type ResourceUpdate = VmResourceUpdate;
export type SessionView = VmSessionView;
export interface RemovalPreview {
    environmentId: string;
    containerId: string;
    volumeName: string;
    networkName: string;
    displayName: string | null;
    hostMounts: string[];
    deleteVolumes: boolean;
    confirmToken: string;
    expiresAt: number;
}
export interface ApprovalRequest {
    id: string;
    sessionKey: string;
    agentId: string;
    generation: number;
    operation: 'import' | 'export';
    source: string;
    destination: string;
    expiresAt: number;
    status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
}
/** Host operations consumed by the VM user interface. */
export interface ClientStream<T> extends AsyncIterable<T> {
    dispose(): void;
}
/** Unwrapped UI face. Its adapter must unwrap RemoteResult values and preserve stream disposal. */
export interface RemoteV02 {
    v02Snapshot(this: void, sessionKey: string | null): Promise<Snapshot>;
    v02Create?(this: void, input: {
        displayName: string;
        image: string;
        limits: Limits;
        internetAccess: boolean;
        mounts: Mount[];
    }, key: string): Promise<Operation>;
    v02Start?(this: void, id: string, key: string): Promise<Operation>;
    v02Stop?(this: void, id: string, key: string): Promise<Operation>;
    v02Pause?(this: void, id: string, key: string): Promise<Operation>;
    v02Resume?(this: void, id: string, key: string): Promise<Operation>;
    v02Bind?(this: void, session: string, id: string, key: string): Promise<Operation>;
    v02Unbind?(this: void, session: string, key: string): Promise<Operation>;
    v02UpdateLimits?(this: void, id: string, limits: Limits, key: string): Promise<Operation>;
    v02PreviewRemoval?(this: void, id: string, deleteVolumes: boolean): Promise<RemovalPreview>;
    v02ConfirmRemoval?(this: void, id: string, token: string, deleteVolumes: boolean, key: string): Promise<Operation>;
    v02WatchSession?(this: void, session: string): ClientStream<SessionView>;
    v02ViewerUrl?(this: void, session: string, epoch: string, revision: number): Promise<{
        url: string;
        expiresAt: number | null;
        epoch: string;
        revision: number;
    } | null>;
    v02WatchResources?(this: void, ids: string[]): ClientStream<ResourceUpdate>;
}
//# sourceMappingURL=v02.d.ts.map