/** Durable Wrapvm Session event declarations; core tool safety remains authoritative. */
import type {
  ActivationRequestedEvent, EnvironmentLostEvent, EnvironmentRestoredEvent,
  GrantConsumedEvent, PolicyCommittedEvent, PolicyReleasedEvent,
} from './projection.ts'
import type { BindingEvent } from './binding.ts'

type Payload<T> = T extends { type: string } ? Omit<T, 'type'> : never

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Activation intent for one policy generation. */
    'wrapvm/activation-requested': Payload<ActivationRequestedEvent>
    /** Environment and policy metadata committed for one generation. */
    'wrapvm/policy-committed': Payload<PolicyCommittedEvent>
    /** Bound environment became unavailable. */
    'wrapvm/environment-lost': Payload<EnvironmentLostEvent>
    /** Bound environment became available again. */
    'wrapvm/environment-restored': Payload<EnvironmentRestoredEvent>
    /** One limited host grant was consumed. */
    'wrapvm/grant-consumed': Payload<GrantConsumedEvent>
    /** User-authorized release metadata; core policy decides admission. */
    'wrapvm/policy-released': Payload<PolicyReleasedEvent>
    /** A conversation was bound to an environment. */
    'wrapvm/environment-bound': Payload<Extract<BindingEvent, { type: 'wrapvm/environment-bound' }>>
    /** A conversation was unbound from an environment. */
    'wrapvm/environment-unbound': Payload<Extract<BindingEvent, { type: 'wrapvm/environment-unbound' }>>
  }
}
