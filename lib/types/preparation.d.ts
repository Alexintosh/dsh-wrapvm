import { z } from 'zod';
import type { EnvironmentCreateInput, EnvironmentDescriptor, EnvironmentId, EnvironmentOperation } from './environments.ts';
import type { BindingRegistry } from './binding.ts';
import { type WorkspaceSnapshot } from './workspace-copy.ts';
export declare const preparationSchema: z.ZodObject<{
    id: z.ZodString;
    session: z.ZodString;
    sourceRoot: z.ZodNullable<z.ZodString>;
    mode: z.ZodEnum<{
        copy: "copy";
        empty: "empty";
        "bind-readonly": "bind-readonly";
        "bind-readwrite": "bind-readwrite";
    }>;
    environmentId: z.ZodNullable<z.ZodString>;
    containerId: z.ZodNullable<z.ZodString>;
    guestPath: z.ZodString;
    phase: z.ZodEnum<{
        preparing: "preparing";
        ready: "ready";
    }>;
    input: z.ZodObject<{
        displayName: z.ZodString;
        image: z.ZodString;
        internetAccess: z.ZodBoolean;
        limits: z.ZodObject<{
            cpuMillis: z.ZodNumber;
            memoryBytes: z.ZodNumber;
        }, z.core.$strip>;
        mounts: z.ZodArray<z.ZodObject<{
            hostPath: z.ZodString;
            guestPath: z.ZodString;
            access: z.ZodEnum<{
                "read-only": "read-only";
                "read-write": "read-write";
            }>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    files: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        hash: z.ZodString;
        size: z.ZodNumber;
        executable: z.ZodBoolean;
    }, z.core.$strip>>;
    snapshot: z.ZodString;
    excluded: z.ZodArray<z.ZodString>;
    excludedCount: z.ZodNumber;
}, z.core.$strip>;
export type Preparation = z.infer<typeof preparationSchema>;
export type WorkspaceMode = Preparation['mode'];
export interface PreparationStore {
    get(key: string): Preparation | undefined;
    put(key: string, value: Preparation): Promise<void>;
}
export interface PreparationPorts {
    store: PreparationStore;
    bindings: BindingRegistry;
    defaults: {
        image: string;
        cpuMillis: number;
        memoryBytes: number;
        internetAccess: boolean;
    };
    get(id: EnvironmentId): EnvironmentDescriptor | undefined;
    create(input: EnvironmentCreateInput, key: string, signal: AbortSignal): Promise<EnvironmentOperation>;
    running(id: EnvironmentId, signal: AbortSignal): Promise<string>;
    install(record: Preparation, initial: WorkspaceSnapshot | undefined, signal: AbortSignal): Promise<void>;
    approveMount(root: string, mode: WorkspaceMode, signal: AbortSignal): Promise<void>;
}
/** Shared with GUI bind/unbind so a late prepare cannot overwrite a newer user selection. */
export declare class SessionOperations {
    private readonly pending;
    run<T>(session: string, work: () => Promise<T>): Promise<T>;
}
export declare function preparationKey(session: string, root: string | null, mode: WorkspaceMode, environmentId?: string): string;
export declare const snapshotIdentity: (files: Preparation["files"]) => string;
/** Caller holds the session operation queue. Persist intent BEFORE any Docker effects. */
export declare function prepareEnvironment(ports: PreparationPorts, session: string, root: string | null, requested: {
    environmentId?: string;
    workspaceMode?: WorkspaceMode;
}, signal: AbortSignal): Promise<Preparation>;
//# sourceMappingURL=preparation.d.ts.map