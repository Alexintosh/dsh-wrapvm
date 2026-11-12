/** Adapt the implemented read-only Typert methods to the UI face. */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { VmInventorySnapshot, VmResourceUpdate, VmSessionView, VmViewerLink } from '../types.ts'
import type { ClientStream } from './v02.ts'
/** Generated client signatures for the v0.2 methods currently provided by the host. */
export interface ReadWire {
  v02Snapshot(sessionKey: string | null): Promise<RemoteResult<VmInventorySnapshot>>
  v02WatchSession?(sessionKey: string, signal?: AbortSignal): RemoteStreamHandle<VmSessionView, never>
  v02WatchResources?(environmentIds: string[], signal?: AbortSignal): RemoteStreamHandle<VmResourceUpdate, never>
  v02ViewerUrl?(sessionKey: string, epoch: string, revision: number): Promise<RemoteResult<VmViewerLink | null>>
}
/** Read-only capabilities with RemoteResult errors surfaced as rejections. */
export interface ReadV02 {
  v02Snapshot(sessionKey: string | null): Promise<VmInventorySnapshot>
  v02WatchSession?(sessionKey: string): ClientStream<VmSessionView>
  v02WatchResources?(environmentIds: string[]): ClientStream<VmResourceUpdate>
  v02ViewerUrl?(sessionKey: string, epoch: string, revision: number): Promise<VmViewerLink | null>
}
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
/** Preserve the generated streams and unwrap unary replies. */
export function adaptReadV02(wire: ReadWire): ReadV02 {
  const result: ReadV02 = { v02Snapshot: async session => unwrap(await wire.v02Snapshot(session)) }
  if (wire.v02WatchSession) result.v02WatchSession = session => wire.v02WatchSession!(session)
  if (wire.v02WatchResources) result.v02WatchResources = ids => wire.v02WatchResources!(ids)
  if (wire.v02ViewerUrl) result.v02ViewerUrl = async (session, epoch, revision) => unwrap(await wire.v02ViewerUrl!(session, epoch, revision))
  return result
}

/** Check whether the mounted contribution exposes all four read operations. */
export function hasReadWire(value: object): value is object & ReadWire {
  return 'v02Snapshot' in value && typeof value.v02Snapshot === 'function'

}

import type { RemoteV02 } from './v02.ts'
type MutationName = Exclude<keyof RemoteV02, keyof ReadV02>
type WireMutations = { [K in MutationName]-?: NonNullable<RemoteV02[K]> extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<RemoteResult<R>> : never }
/** Adapt each available management operation independently. */
export function adaptV02(wire: ReadWire & Partial<WireMutations>): RemoteV02 {
  const result: RemoteV02 = { ...adaptReadV02(wire) }
  if (wire.v02Create) result.v02Create = async (input, key) => unwrap(await wire.v02Create!(input, key))
  if (wire.v02Start) result.v02Start = async (id, key) => unwrap(await wire.v02Start!(id, key))
  if (wire.v02Stop) result.v02Stop = async (id, key) => unwrap(await wire.v02Stop!(id, key))
  if (wire.v02Pause) result.v02Pause = async (id, key) => unwrap(await wire.v02Pause!(id, key))
  if (wire.v02Resume) result.v02Resume = async (id, key) => unwrap(await wire.v02Resume!(id, key))
  if (wire.v02Bind) result.v02Bind = async (session, id, key) => unwrap(await wire.v02Bind!(session, id, key))
  if (wire.v02Unbind) result.v02Unbind = async (session, key) => unwrap(await wire.v02Unbind!(session, key))
  if (wire.v02UpdateLimits) result.v02UpdateLimits = async (id, limits, key) => unwrap(await wire.v02UpdateLimits!(id, limits, key))
  if (wire.v02PreviewRemoval) result.v02PreviewRemoval = async (id, volumes) => unwrap(await wire.v02PreviewRemoval!(id, volumes))
  if (wire.v02ConfirmRemoval) result.v02ConfirmRemoval = async (id, token, volumes, key) => unwrap(await wire.v02ConfirmRemoval!(id, token, volumes, key))
  return result
}
