/**
 * Canonical host-mount policy for protected-mode guests.
 *
 * The Phase-1 screen was a fixed string list: it blocked every `/Users/...`
 * mount (even one the user explicitly chose) while missing canonicalized
 * paths, symlink escapes, and control-plane directories like the DSH profile.
 * This module replaces it with a real decision procedure:
 *
 * 1. an explicit approval intent is required — a mount is allowed only under
 *    a root the user explicitly approved;
 * 2. paths are canonicalized before any comparison (`~` expansion, `..`
 *    normalization, realpath of the nearest existing ancestor), so
 *    path-prefix tricks (`/Users-evil`, `/etcx`) and symlink detours through
 *    blocked roots cannot slip past;
 * 3. runtime-safe checks: broad roots (`/`, `/Users`, `/home`, the home
 *    directory itself) are refused as mounts because they expose every home
 *    or every control file, and control subtrees (DSH profile, SSH, cloud
 *    credentials, Docker config, macOS Library, the system tree) are refused
 *    wherever they resolve;
 * 4. a mount that would CONTAIN a blocked root (an ancestor of it) is refused
 *    too — read-only access does not relax any rule, since reading the DSH
 *    profile or SSH keys is exactly the leak.
 *
 * Residual risk, stated honestly: a not-yet-existing leaf can later be
 * replaced by a symlink into a blocked root. The manager canonicalizes at
 * admission and the Docker backend re-checks before `create`; live acceptance
 * must verify the mount inside the guest.
 * @module
 */
import type { EnvironmentMount } from './environments.ts';
/** Context the policy evaluates against; injected so tests need no real filesystem. */
export interface MountPolicyContext {
    /** Canonical resolution of an existing path (symlinks fully resolved). */
    readonly realpath: (path: string) => string;
    /** Whether a path exists (used to find the nearest existing ancestor). */
    readonly exists: (path: string) => boolean;
    /** The host user's home directory (absolute, canonical). */
    readonly homedir: string;
    /**
     * Roots the user explicitly approved sharing, as host paths. A mount is
     * allowed only when its canonical path sits inside one of these. An empty
     * list means nothing was approved and every host mount is refused.
     */
    readonly approvedRoots: readonly string[];
    /** Additional blocked subtrees from configuration (e.g. the installed app path). */
    readonly extraBlockedSubtrees?: readonly string[];
}
/** Outcome of evaluating one mount against the policy. */
export interface MountDecision {
    readonly ok: boolean;
    /** Canonical host path when allowed. */
    readonly canonicalPath?: string;
    /** Precise refusal reason when denied. */
    readonly reason?: string;
}
/**
 * Canonicalize a host path: expand `~`, normalize, then resolve symlinks for
 * the nearest existing ancestor so a symlinked directory above the target
 * cannot smuggle the path into a blocked root. A path whose every ancestor is
 * missing fails closed.
 * @param path - the raw host path from configuration or user input.
 * @param context - policy context providing realpath/exists/homedir.
 * @returns the canonical absolute path.
 * @throws when the path is relative or no ancestor exists.
 */
export declare function canonicalizeHostPath(path: string, context: MountPolicyContext): string;
/**
 * Decide whether one host mount may be shared with a protected-mode guest.
 * @param mount - the requested mount with its visible access mode.
 * @param context - policy context (approval roots, canonicalization, home).
 * @returns the decision with a precise reason when denied.
 */
export declare function evaluateHostMount(mount: EnvironmentMount, context: MountPolicyContext): MountDecision;
/**
 * Aggregate refusals for a mount set under the canonical policy.
 * @param mounts - requested mounts.
 * @param context - policy context.
 * @returns one precise reason per denied mount (empty when every mount passes).
 */
export declare function mountPolicyRefusals(mounts: readonly EnvironmentMount[], context: MountPolicyContext): string[];
/**
 * Fail-closed static fallback for {@link protectedModeRefusal} callers without
 * a {@link MountPolicyContext}. It catches the obvious control paths but is
 * NOT the real enforcement: only the canonical policy resolves symlinks and
 * honors explicit approval.
 * @param mount - the mount to screen.
 * @returns a refusal reason, or undefined when the static screen passes it.
 */
export declare function staticMountRefusal(mount: EnvironmentMount): string | undefined;
/**
 * Build a policy context backed by the real filesystem.
 * @param options - approved roots, extra blocked subtrees, home override.
 * @returns a context usable by {@link evaluateHostMount}.
 */
export declare function makeFsMountPolicyContext(options: {
    approvedRoots: readonly string[];
    extraBlockedSubtrees?: readonly string[];
    homedir?: string;
}): MountPolicyContext;
//# sourceMappingURL=mount-policy.d.ts.map