/**
 * Exact trusted tool identity for protected mode.
 *
 * Admission is an allowlist of capability identities, never a name-prefix
 * rule: a tool named `vm_*` that is not the pinned registration is denied, and
 * a trusted name re-resolved to a different registration object (scoped shadow,
 * replaced registration, late re-registration) is denied. The host PTC
 * transport `run_code` is never trusted — allowing VM tools inside its nested
 * calls would still let the program use the host Node runtime directly.
 *
 * The trusted surface is not only the `vm_*` tools: the plan admits the
 * verified DSH user-question operation and the plugin's bundled VM skill
 * loads. Both are identity-pinned like every other capability, and both carry
 * constrained parameters — a skill load may name only a skill id distributed
 * with this bundle, never an arbitrary host skill or file. Actual tool
 * registration wiring lands with the runtime adapter; this module owns the
 * identity and parameter constraints the adapter must enforce.
 * @module
 */
import { RUN_CODE_NAME, type ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Guest-side capabilities the protected mode may admit, each pinned to one registration. */
export const VM_CAPABILITIES = [
  'vm_status',
  'vm_shell',
  'vm_browser',
  'vm_desktop',
  'vm_process',
  'vm_enter',
] as const

/** One admitted guest capability name. */
export type VmCapability = (typeof VM_CAPABILITIES)[number]

/**
 * Host-side operations the plan admits under exact verified identities with
 * constrained parameters: `ask_user_question` is the DSH-verified user
 * question transport; `load_vm_skill` loads only the VM skills distributed
 * with this bundle. Neither is reachable by name alone — both must be pinned
 * to a registration, and both require parameter constraints at pin time.
 */
export const TRUSTED_HOST_CAPABILITIES = ['ask_user_question', 'load_vm_skill'] as const

/** One trusted host capability name. */
export type TrustedHostCapability = (typeof TRUSTED_HOST_CAPABILITIES)[number]

/** Every capability name the protected mode may ever admit. */
export const TRUSTED_CAPABILITY_IDS = [...VM_CAPABILITIES, ...TRUSTED_HOST_CAPABILITIES] as const

/** One admitted capability name. */
export type TrustedCapabilityId = (typeof TRUSTED_CAPABILITY_IDS)[number]

/**
 * Parameter constraint evaluated at final dispatch on the call's parsed
 * arguments. Returns a denial reason, or undefined when the arguments are
 * within the constraint. Constraints must be pure and total: they never throw.
 */
export type CapabilityConstraints = (args: unknown) => string | undefined

/** One capability pinned to the exact registration that provides it. */
export interface TrustedCapabilityRegistration {
  readonly capability: TrustedCapabilityId
  /** Exact registration object; identity, not name, decides admission. */
  readonly definition: ToolDefinition
  /** Plugin id that owns the registration (the Wrapvm bundle or the verified DSH provider). */
  readonly ownerPlugin: string
  /**
   * Optional constrained-parameter check. The host capabilities
   * (`ask_user_question`, `load_vm_skill`) may not be pinned without one:
   * their parameters decide what the host actually does.
   */
  readonly constraints?: CapabilityConstraints
}

/** Pinned capability identities for one session, keyed by capability name. */
export type TrustedCapabilitySet = ReadonlyMap<TrustedCapabilityId, TrustedCapabilityRegistration>

/**
 * Freeze the pinned registrations for one protected session.
 *
 * The retained state is fully defensive: each registration is copied into a
 * frozen record, so mutating a caller-held registration object after pinning
 * (or the retained record) can never swap in a different definition or drop
 * the constraints. The returned lookup is an immutable facade, not the
 * backing Map: `Object.freeze` on a Map would NOT prevent `set`/`delete`
 * (entries live in internal slots, not properties), so the facade simply
 * exposes no mutators and never leaks the Map through iteration.
 * @param registrations - one registration per admitted capability.
 * @returns an immutable lookup used by final-dispatch admission.
 */
export function pinTrustedCapabilities(registrations: readonly TrustedCapabilityRegistration[]): TrustedCapabilitySet {
  const pinned = new Map<TrustedCapabilityId, TrustedCapabilityRegistration>()
  for (const registration of registrations) {
    if (!(TRUSTED_CAPABILITY_IDS as readonly string[]).includes(registration.capability)) {
      throw new Error(`wrapvm-isolate: "${registration.capability}" is not a trusted capability id`)
    }
    if (typeof registration.ownerPlugin !== 'string' || registration.ownerPlugin.length === 0) {
      throw new Error(`wrapvm-isolate: capability "${registration.capability}" needs a non-empty ownerPlugin`)
    }
    if (registration.definition === null || typeof registration.definition !== 'object') {
      throw new Error(`wrapvm-isolate: capability "${registration.capability}" needs the exact definition object`)
    }
    if ((TRUSTED_HOST_CAPABILITIES as readonly string[]).includes(registration.capability) && registration.constraints === undefined) {
      throw new Error(`wrapvm-isolate: host capability "${registration.capability}" must be pinned with parameter constraints`)
    }
    if (pinned.has(registration.capability)) {
      throw new Error(`wrapvm-isolate: capability "${registration.capability}" pinned twice`)
    }
    // Defensive copy: the retained record must not alias the caller's object.
    pinned.set(registration.capability, Object.freeze({
      capability: registration.capability,
      definition: registration.definition,
      ownerPlugin: registration.ownerPlugin,
      ...registration.constraints !== undefined ? { constraints: registration.constraints } : {},
    }))
  }
  const view: TrustedCapabilitySet = {
    size: pinned.size,
    get: key => pinned.get(key),
    has: key => pinned.has(key),
    forEach: (callback, thisArg) => {
      for (const [key, registration] of pinned) callback.call(thisArg, registration, key, view)
    },
    keys: () => pinned.keys(),
    values: () => pinned.values(),
    entries: () => pinned.entries(),
    [Symbol.iterator]: () => pinned.entries(),
  }
  return Object.freeze(view)
}

/**
 * Build the constraint for the bundled-skill load capability: the call may
 * only name one of the skill ids distributed with this bundle, and may carry
 * no other parameter. Arbitrary host skill or file reads are never admitted.
 * @param bundledSkillIds - the skill ids shipped with this plugin.
 * @returns a constraint rejecting anything else.
 */
export function bundledSkillConstraints(bundledSkillIds: readonly string[]): CapabilityConstraints {
  const allowed = new Set(bundledSkillIds)
  return (args: unknown): string | undefined => {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'load_vm_skill requires an object with a single skill parameter'
    const record = args as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length !== 1 || keys[0] !== 'skill') return 'load_vm_skill accepts only the skill parameter'
    const skill = record.skill
    if (typeof skill !== 'string' || !allowed.has(skill)) {
      return 'load_vm_skill may only load the VM skills distributed with the Wrapvm bundle'
    }
    return undefined
  }
}

/**
 * Decide one call under protected admission by exact identity.
 * @param name - the invoked tool name.
 * @param definition - the definition the registry resolves for the call, or
 *   undefined when the name resolves to nothing.
 * @param pinned - the session's pinned capability identities.
 * @param args - the call's parsed arguments; required to evaluate a pinned
 *   capability's parameter constraints (fail-closed when unavailable).
 * @returns a denial reason, or undefined when the call is the pinned registration.
 */
export function admitTrustedCall(
  name: string,
  definition: ToolDefinition | undefined,
  pinned: TrustedCapabilitySet,
  args?: unknown,
): string | undefined {
  if (name === RUN_CODE_NAME) {
    return 'the host program transport run_code is not available in protected mode; guest work runs through the VM tools'
  }
  if (definition === undefined) return `tool "${name}" is not available in protected mode`
  const registration = (TRUSTED_CAPABILITY_IDS as readonly string[]).includes(name)
    ? pinned.get(name as TrustedCapabilityId)
    : undefined
  if (registration === undefined) return `tool "${name}" is not a trusted VM capability`
  if (registration.definition !== definition) {
    return `tool "${name}" does not match the pinned ${registration.ownerPlugin} registration`
  }
  if (registration.constraints !== undefined) {
    if (args === undefined) return `tool "${name}" requires argument constraint checking; arguments were unavailable`
    return registration.constraints(args)
  }
  return undefined
}