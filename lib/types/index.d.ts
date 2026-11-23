/**
 * dsh-wrapvm-isolate — isolated wrapvm desktop VM for DeepSeek Harness.
 *
 * Host half: container lifecycle (start/stop/status/exec/innerUrl) and agent
 * tools (vm_shell, vm_browser, vm_desktop, vm_status) driven through the docker
 * CLI via `ctx.subprocess.spawn`, plus the Remote face the settings panel calls.
 *
 * The VM image is `ghcr.io/tobi/wrapvm:desktop` (wrap's desktop image: Xvfb +
 * XFCE, one persistent Chrome with CDP forwarded to all guest interfaces at
 * 9223, voxl viewer on 6080, agent-browser and agent-desktop preinstalled).
 */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import z from '@deepseek-ai/schemastery';
import { type EnvironmentTarget } from './environments.ts';
import type { ExecResult, VmResourceUpdate, VmSessionView, VmViewerLink, VmInventorySnapshot, VmOperationView, VmRemovalPreview } from './types.ts';
export type { ExecResult, VmStatus, CdpTarget, VmResourceUpdate, VmSessionView, VmViewerLink, VmPolicy, VmBinding, VmOperationView, VmEnvironmentView, VmInventorySnapshot } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Configured wrapvm container lifecycle and tools. */
        wrapvmIsolate: WrapvmIsolateService;
    }
}
/** Configuration schema for the wrapvm isolate service. */
export interface Config {
    /** Docker executable. */
    backend: string;
    /** Locally installed desktop image for automatic creation; never implicitly pulled. */
    agentImage?: string;
    /** CPU allocation for new agent environments (1000 = one core). */
    agentCpuMillis?: number;
    /** Memory allocation for new agent environments, in bytes. */
    agentMemoryBytes?: number;
    /** Explicit network default for automatic creation; offline creation is unsupported. */
    agentInternetAccess?: boolean;
    /** Shared resource sampling cadence in milliseconds. */
    metricsCadenceMs: number;
    /** Age after which resource samples are stale. */
    metricsStalenessMs: number;
}
/** One bounded subprocess run through the configured container backend. */
export declare class WrapvmIsolateService extends TypertRemoteService {
    private readonly config;
    static inject: string[];
    static Config: z<Schemastery.ObjectS<NoInfer<{
        backend: z<string, string, "defined">;
        agentImage: z<string, string, "defined">;
        agentCpuMillis: z<number, number, "defined">;
        agentMemoryBytes: z<number, number, "defined">;
        agentInternetAccess: z<boolean, boolean, "defined">;
        metricsCadenceMs: z<number, number, "defined">;
        metricsStalenessMs: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        backend: z<string, string, "defined">;
        agentImage: z<string, string, "defined">;
        agentCpuMillis: z<number, number, "defined">;
        agentMemoryBytes: z<number, number, "defined">;
        agentInternetAccess: z<boolean, boolean, "defined">;
        metricsCadenceMs: z<number, number, "defined">;
        metricsStalenessMs: z<number, number, "defined">;
    }>>, "plain">;
    private readonly hostLifetime;
    private readonly hostEpoch;
    private manager;
    private backend;
    private bindings;
    private preparationStore;
    private activePreparations;
    private readonly sessionOperations;
    private readonly leases;
    private managerReady;
    private revision;
    private readonly listeners;
    private inventory;
    private sampler;
    private resourceLifetime;
    constructor(ctx: Context, config: Config);
    private run;
    private owner;
    private managed;
    private operation;
    private policy;
    v02Snapshot(sessionKey: string | null): Promise<VmInventorySnapshot>;
    v02Create(input: {
        displayName: string;
        image: string;
        limits: {
            cpuMillis: number;
            memoryBytes: number;
            diskBytes: number | null;
        };
        internetAccess: boolean;
        mounts: {
            hostPath: string;
            guestPath: string;
            access: 'read-only' | 'read-write';
        }[];
    }, key: string): Promise<VmOperationView>;
    private limits;
    v02Start(id: string, key: string): Promise<VmOperationView>;
    v02Stop(id: string, key: string): Promise<VmOperationView>;
    v02Pause(id: string, key: string): Promise<VmOperationView>;
    v02Resume(id: string, key: string): Promise<VmOperationView>;
    v02UpdateLimits(id: string, limits: {
        cpuMillis: number;
        memoryBytes: number;
        diskBytes: number | null;
    }, key: string): Promise<VmOperationView>;
    v02PreviewRemoval(id: string, deleteVolumes: boolean): Promise<VmRemovalPreview>;
    v02ConfirmRemoval(id: string, token: string, deleteVolumes: boolean, key: string): Promise<VmOperationView>;
    v02Bind(session: string, id: string, _key: string): Promise<VmOperationView>;
    v02Unbind(session: string, _key: string): Promise<VmOperationView>;
    v02WatchSession(sessionKey: string, signal: AbortSignal): AsyncIterable<VmSessionView>;
    v02ViewerUrl(sessionKey: string, epoch: string, revision: number): Promise<VmViewerLink | null>;
    private withTarget;
    /** Watch shared resource samples for managed environments until cancellation. */
    v02WatchResources(environmentIds: string[], signal: AbortSignal): AsyncIterable<VmResourceUpdate>;
    /** Run one command as the image's configured user in its login environment. */
    exec(target: EnvironmentTarget, args: {
        command: string;
        workdir?: string;
        timeoutMs?: number;
    }, signal?: AbortSignal): Promise<ExecResult>;
    /** Run `agent-desktop` as the image's user with its desktop session environment. */
    desktop(target: EnvironmentTarget, args: {
        argv: readonly string[];
        timeoutMs?: number;
    }, signal?: AbortSignal): Promise<ExecResult>;
    /** List CDP DevTools targets of the running VM. */
    cdpTargets(target: EnvironmentTarget, signal?: AbortSignal): Promise<Record<string, unknown>[]>;
    /** Open one CDP target on a fresh page. */
    cdpOpen(target: EnvironmentTarget, url: string, signal?: AbortSignal): Promise<{
        id: string;
    }>;
    /** Close one CDP target. */
    cdpClose(target: EnvironmentTarget, targetId: string, signal?: AbortSignal): Promise<{
        id: string;
    }>;
    /** Evaluate one JS expression in one CDP target over WebSocket. */
    cdpEval(target: EnvironmentTarget, targetId: string, expression: string, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>;
    private cdpNavigate;
    private sessionKey;
    private workspaceView;
    private currentPreparation;
    private workspaceRuntime;
    private registerTools;
}
export default WrapvmIsolateService;
//# sourceMappingURL=index.d.ts.map