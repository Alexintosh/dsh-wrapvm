/** Mount the per-session host admission fences supplied by the owning runtimes. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { QuiescenceContributor, ToolSafetyLatch } from '@deepseek-ai/dsh-tools'

/** Required host subsystems for a protected Session. */
export const HOST_CONTRIBUTOR_IDS = ['jobs', 'schedule', 'subagents', 'subprocess'] as const

/** A closed admission gate and its live activity observer, owned by a runtime. */
export interface HostAdmissionLease {
  readonly contributor: QuiescenceContributor
  /** Reopen admission only after an authorized release or owner shutdown. */
  dispose(): void
}

/** Runtime-owned, atomic admission cutoff for one Session and its existing work. */
export interface HostAdmissionOwner {
  /**
   * Close admission synchronously before returning an observer that covers all
   * already accepted work, including pending starts and cleanup. A failure must
   * not reopen an admission gate the owner already closed.
   * @param sessionId - Session whose host work is fenced.
   * @returns The closed gate and its observer.
   */
  closeAdmission(sessionId: SessionId): HostAdmissionLease
}

/** All required real host owners, including terminal process ownership. */
export type HostAdmissionOwners = { readonly [K in typeof HOST_CONTRIBUTOR_IDS[number]]: HostAdmissionOwner }

/** A failed mount retains any successfully closed gates for controlled release. */
export class HostContributorMountError extends Error {
  /** @param cause - failure to close or register an owner.
   * @param dispose - release the retained gates after an authorized release or shutdown.
   */
  constructor(cause: unknown, readonly dispose: () => void) {
    super('Unable to mount all host admission contributors', { cause })
    this.name = 'HostContributorMountError'
  }
}

/**
 * Close all four owner gates synchronously and register their observers. A
 * partial failure retains closed gates in the thrown error; absence never means
 * idle. Owners must cover direct calls, not just calls made through this module.
 * @param latch - core safety latch receiving the contributors.
 * @param sessionId - Session being protected.
 * @param owners - actual runtime owners with complete attribution.
 * @returns An idempotent release function; retain it until authorized release or shutdown.
 */
export function mountHostContributors(
  latch: Pick<ToolSafetyLatch, 'registerQuiescenceContributor'>,
  sessionId: SessionId,
  owners: HostAdmissionOwners,
): () => void {
  const releases: (() => void)[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const release of releases.reverse()) release()
  }
  try {
    for (const id of HOST_CONTRIBUTOR_IDS) {
      const lease = owners[id].closeAdmission(sessionId)
      releases.push(() => lease.dispose())
      releases.push(latch.registerQuiescenceContributor(sessionId, id, lease.contributor))
    }
  } catch (error: unknown) {
    throw new HostContributorMountError(error, dispose)
  }
  return dispose
}
