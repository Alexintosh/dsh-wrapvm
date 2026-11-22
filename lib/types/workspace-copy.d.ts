export interface WorkspaceFile {
    path: string;
    hash: string;
    size: number;
    executable: boolean;
}
export interface WorkspacePayload extends WorkspaceFile {
    data: string;
}
export interface WorkspaceSnapshot {
    files: WorkspacePayload[];
    excluded: string[];
    excludedCount: number;
    bytes: number;
}
export declare const COPY_LIMITS: {
    files: number;
    bytes: number;
    fileBytes: number;
};
export declare function excludedPath(path: string): boolean;
export declare function filePath(value: string): string;
export declare const hashBytes: (bytes: Uint8Array) => string;
export declare function projectRoot(path: string): Promise<string>;
/** Revalidate all ancestors and use O_NOFOLLOW for the final file. */
export declare function readProjectFile(root: string, name: string): Promise<WorkspacePayload>;
export declare function snapshotProject(root: string | null, signal: AbortSignal, paths?: readonly string[]): Promise<WorkspaceSnapshot>;
/** Export to a NEW review directory. Never overwrite the host project's original files. */
export declare function exportReview(root: string, files: WorkspacePayload[], baseline: readonly WorkspaceFile[], signal: AbortSignal): Promise<{
    directory: string;
    conflicts: string[];
}>;
//# sourceMappingURL=workspace-copy.d.ts.map