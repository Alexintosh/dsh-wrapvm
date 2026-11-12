/** Adapt the implemented read-only Typert methods to the UI face. */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import type { VmInventorySnapshot, VmResourceUpdate, VmSessionView, VmViewerLink } from '../types.ts';
import type { ClientStream } from './v02.ts';
/** Generated client signatures for the v0.2 methods currently provided by the host. */
export interface ReadWire {
    v02Snapshot(sessionKey: string | null): Promise<RemoteResult<VmInventorySnapshot>>;
    v02WatchSession?(sessionKey: string, signal?: AbortSignal): RemoteStreamHandle<VmSessionView, never>;
    v02WatchResources?(environmentIds: string[], signal?: AbortSignal): RemoteStreamHandle<VmResourceUpdate, never>;
    v02ViewerUrl?(sessionKey: string, epoch: string, revision: number): Promise<RemoteResult<VmViewerLink | null>>;
}
/** Read-only capabilities with RemoteResult errors surfaced as rejections. */
export interface ReadV02 {
    v02Snapshot(sessionKey: string | null): Promise<VmInventorySnapshot>;
    v02WatchSession?(sessionKey: string): ClientStream<VmSessionView>;
    v02WatchResources?(environmentIds: string[]): ClientStream<VmResourceUpdate>;
    v02ViewerUrl?(sessionKey: string, epoch: string, revision: number): Promise<VmViewerLink | null>;
}
/** Preserve the generated streams and unwrap unary replies. */
export declare function adaptReadV02(wire: ReadWire): ReadV02;
/** Check whether the mounted contribution exposes all four read operations. */
export declare function hasReadWire(value: object): value is object & ReadWire;
import type { RemoteV02 } from './v02.ts';
type MutationName = Exclude<keyof RemoteV02, keyof ReadV02>;
type WireMutations = {
    [K in MutationName]-?: NonNullable<RemoteV02[K]> extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<RemoteResult<R>> : never;
};
/** Adapt each available management operation independently. */
export declare function adaptV02(wire: ReadWire & Partial<WireMutations>): RemoteV02;
export {};
//# sourceMappingURL=remote-adapter.d.ts.map