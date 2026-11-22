/** Agent entry point: session-derived projects and shared manager operations. */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { BindingRegistry } from './binding.ts';
import type { EnvironmentManager, ExecutionLeaseRegistry } from './lifecycle.ts';
import type { DockerEnvironmentBackend } from './docker-backend.ts';
import { type Preparation, type PreparationStore, type WorkspaceMode } from './preparation.ts';
export interface WorkspaceRuntime {
    manager: EnvironmentManager;
    backend: DockerEnvironmentBackend;
    bindings: BindingRegistry;
    leases: ExecutionLeaseRegistry;
    store: PreparationStore;
    defaults: {
        image: string;
        cpuMillis: number;
        memoryBytes: number;
        internetAccess: boolean;
    };
    current(session: string): Preparation | undefined;
    select(record: Preparation): Promise<void>;
    run(argv: readonly string[], options: {
        signal: AbortSignal;
        stdin?: string;
        maxBytes?: number;
    }): Promise<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
    }>;
    lifetime: AbortSignal;
    binary: string;
}
export declare function currentProject(ctx: Context, execution: ToolRunContext): string | null;
export declare function workspaceInfo(record: Preparation | undefined): {
    phase: "preparing" | "ready";
    mode: "copy" | "empty" | "bind-readonly" | "bind-readwrite";
    sourceRoot: string | null;
    guestPath: string;
    snapshot: string;
    files: number;
    excluded: string[];
    excludedCount: number;
} | null;
export declare function prepareForAgent(ctx: Context, runtime: WorkspaceRuntime, execution: ToolRunContext, args: {
    environmentId?: string;
    workspaceMode?: WorkspaceMode;
}): Promise<{
    ready: boolean;
    environmentId: string | null;
    action: string;
    internetAccess: boolean;
    workspace: {
        phase: "preparing" | "ready";
        mode: "copy" | "empty" | "bind-readonly" | "bind-readwrite";
        sourceRoot: string | null;
        guestPath: string;
        snapshot: string;
        files: number;
        excluded: string[];
        excludedCount: number;
    } | null;
    next: string;
}>;
export declare function workspaceForAgent(ctx: Context, runtime: WorkspaceRuntime, execution: ToolRunContext, args: {
    action: string;
    paths?: string[];
}): Promise<{
    imported: string[];
    unchanged: string[];
    conflicts: string[];
} | {
    files: string[];
    appliedToOriginals: boolean;
    next: string;
    directory: string;
    conflicts: string[];
} | {
    workspace: {
        phase: "preparing" | "ready";
        mode: "copy" | "empty" | "bind-readonly" | "bind-readwrite";
        sourceRoot: string | null;
        guestPath: string;
        snapshot: string;
        files: number;
        excluded: string[];
        excludedCount: number;
    } | null;
}>;
//# sourceMappingURL=agent-workspaces.d.ts.map