/**
 * Protected-mode vocabulary for Wrapvm Isolate conversations.
 *
 * The mode union is core-owned (`SafetyMode` from `@deepseek-ai/dsh-tools`);
 * this module only adds the plugin-side helpers that decide what each mode
 * permits. Mode state is never inferred from container liveness: a running
 * container does not prove protection, and a stopped container never returns
 * a protected conversation to `normal`.
 * @module
 */
import type { SafetyMode, SafetyTransitionStage } from '@deepseek-ai/dsh-tools'

export type { SafetyMode, SafetyTransitionStage }

/**
 * Plugin-side policy record for one conversation. The runtime adapter maps it
 * to the core `SafetyPolicyRecord` (whose session key is a branded `SessionId`)
 * when installing it on the core-owned latch.
 */
export interface PolicyRecord {
  readonly sessionKey: string
  readonly mode: SafetyMode
  /** Monotonic policy generation; 0 means never protected. */
  readonly generation: number
  readonly stage: SafetyTransitionStage
  /** Environment the session is bound to; absent until the binding commits. */
  readonly environmentId?: string
}

/**
 * Whether host tool work is refused in this mode (all non-`normal` modes).
 * @param mode - the conversation's protection mode.
 * @returns true when host tools must not execute.
 */
export function blocksHostWork(mode: SafetyMode): boolean {
  return mode !== 'normal'
}

/**
 * Whether the mode admits only the session's pinned trusted capabilities.
 * @param mode - the conversation's protection mode.
 * @returns true when trusted VM capabilities may still run.
 */
export function admitsTrustedOnly(mode: SafetyMode): boolean {
  return mode === 'activating' || mode === 'protected'
}

/**
 * Whether the bound environment is currently usable for guest work.
 * @param mode - the conversation's protection mode.
 * @returns true only in `protected`.
 */
export function environmentUsable(mode: SafetyMode): boolean {
  return mode === 'protected'
}