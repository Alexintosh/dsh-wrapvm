/**
 * Negative security proofs for the Wrapvm protected-mode contract, driven
 * through the real tool registry and execution pipeline.
 *
 * Tests marked `it.fails` are intentional baseline failures: they pin the
 * acceptance criteria from the 0.2 plan that the current DSH runtime cannot
 * satisfy yet (final-dispatch admission and the core-owned latch). They flip
 * to passing tests when the runtime phase lands, and start failing loudly if
 * the runtime regresses. Passing tests here pin properties the runtime already
 * provides and must preserve, plus the plugin-side admission that works today
 * through the existing guard stage.
 */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution, ToolExecutionInput, ToolSafetyAdmission } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createProtectedAdmission, InFlightLedger, type ProtectedAdmissionProvider } from '../src/admission.ts'
import { pinTrustedCapabilities } from '../src/capabilities.ts'
import type { SafetyMode } from '../src/policy.ts'

const TEST_MODEL_SELECTION = { provider: 'test', model: 'test' }
const testToolSignal = new AbortController().signal

/** Mount the registry (with its systemPrompt dependency) on a fresh context. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Mint an agent scope whose key doubles as a minimal Agent-like object. */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; key: Agent }> {
  const key = { id: SessionId(name) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  return { scope, key }
}

function tool(name: string, onExecute?: () => void): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => {
      onExecute?.()
      return Promise.resolve(`ran:${name}`)
    },
  }
}

async function run(ctx: Context, name: string, agent?: Agent, toolSet?: ToolExecutionInput['toolSet']): Promise<string> {
  const result = await executeToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: {},
    ...agent === undefined ? {} : { agent },
    ...toolSet === undefined ? {} : { toolSet },
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/**
 * Infrastructure probe: this checkout carries stale in-place build artifacts,
 * so `@deepseek-ai/dsh-scope` can resolve to two module copies (a stale `src`
 * build for the test file, the bundled `lib` for the registry source), giving
 * each a distinct scope tag. Scope-layered proofs are only meaningful when the
 * registry and this file share one copy; the same mismatch fails the core
 * registry's own scoped suites in this tree.
 */
const scopeHealthy = await (async (): Promise<boolean> => {
  const ctx = await mount()
  const { scope, key } = await mintAgentScope(ctx, 'session-probe')
  ctx.tools.register(tool('probe-global'))
  try {
    scope.ctx.tools.restrict({ deny: ['probe-global'] })
  } catch {
    return false
  }
  const result = await run(ctx, 'probe-global', key)
  await ctx.fiber.dispose()
  return result.includes('unknown tool')
})()

it('denies host tools and admits pinned VM tools through the real pipeline while the guard stage is authoritative', async () => {
  const ctx = await mount()
  const { key } = await mintAgentScope(ctx, 'session-guard')
  const vmShell = tool('vm_shell')
  ctx.tools.register(vmShell)
  ctx.tools.register(tool('host_shell'))
  const ledger = new InFlightLedger()
  let mode: SafetyMode = 'normal'
  const admission: ProtectedAdmissionProvider = createProtectedAdmission(
    { mode: () => mode, generation: () => 1 },
    pinTrustedCapabilities([{ capability: 'vm_shell', definition: vmShell, ownerPlugin: 'dsh-wrapvm-isolate' }]),
    ledger,
  )
  // The provider must stay structurally compatible with the core contract.
  const _asCoreAdmission: ToolSafetyAdmission = admission
  void _asCoreAdmission
  // Test-local registry resolution for this legacy guard-stage fixture: the
  // production contract hands `check` the exact dispatched definition, so the
  // provider itself has no lookup — the fixture supplies it explicitly here.
  const resolveDefinition = (exec: Readonly<ToolExecution>): ToolDefinition | undefined =>
    ctx.tools.executable(exec.name, exec.agent)
  ctx.tools.guard(exec => {
    const decision = admission.check(exec, resolveDefinition(exec))
    if (decision.kind === 'deny') return decision.reason
    admission.admitted(exec)
    return undefined
  })
  ctx.on('tools/result', exec => { admission.settled(exec) })

  expect(await run(ctx, 'host_shell', key)).toBe('ran:host_shell')
  mode = 'protected'
  expect(await run(ctx, 'host_shell', key)).toMatch(/not a trusted VM capability/)
  expect(await run(ctx, 'run_code', key)).toMatch(/run_code/)
  expect(await run(ctx, 'vm_shell', key)).toBe('ran:vm_shell')
  expect(ledger.inFlight()).toBe(0)
  mode = 'protected-unavailable'
  expect(await run(ctx, 'vm_shell', key)).toMatch(/does not fall back/)
})

it.fails('refuses a host tool prepared before activation whose middleware suspends past the arming point', async () => {
  // Acceptance: "Un tool host preparato prima dell'attivazione e sospeso in un
  // intermediario asincrono non arriva al proprio corpo dopo il blocco."
  const ctx = await mount()
  let bodyStarted = false
  ctx.tools.register(tool('host_shell', () => { bodyStarted = true }))
  let releaseMiddleware!: () => void
  const gate = new Promise<void>(resolve => { releaseMiddleware = resolve })
  ctx.on('tools/execute', async (_exec, next) => {
    await gate
    return next()
  })
  let mode: SafetyMode = 'normal'
  ctx.tools.guard(() => mode === 'normal' ? undefined : 'protected mode denies host tools')

  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare({
    signal: testToolSignal,
    callId: ToolCallId('race'),
    name: 'host_shell',
    arguments: {},
  })
  expect(prepared.kind).toBe('dispatch')
  // Activation arms the protection while the call sits between prepare and body.
  mode = 'protected'
  const dispatching = pipeline.dispatch(prepared.exec)
  releaseMiddleware()
  const outcome = await dispatching
  await pipeline.complete(prepared.exec, outcome)
  expect(bodyStarted).toBe(false)
})

it.fails('keeps denying after the protection provider is disposed (core-owned latch)', async () => {
  // Acceptance: "Riavvio, HMR, disinstallazione del provider, dati incoerenti
  // e VM assente non riportano la sessione a normale." Today the only denial
  // mechanism is the plugin-registered guard, and disposing the plugin removes
  // it, reopening the conversation to host tools.
  const ctx = await mount()
  const { key } = await mintAgentScope(ctx, 'session-dispose')
  ctx.tools.register(tool('host_shell'))
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    inner.tools.guard(() => 'the VM provider denies host tools')
  }, { inject: ['tools'], name: 'wrapvm-provider' }))
  expect(await run(ctx, 'host_shell', key)).toMatch(/denies host tools/)
  await fiber.dispose()
  expect(await run(ctx, 'host_shell', key)).toMatch(/denies host tools/)
})

it.skipIf(!scopeHealthy).fails('refuses own-scope tools that bypass the allowlist restriction', async () => {
  // Acceptance: "Strumenti locali, nuovi strumenti, nomi contraffatti,
  // registrazioni sostituite e selezioni già catturate non aggirano la policy."
  // tools.restrict() exempts registrations made in the agent's own scope, so a
  // locally registered (or shadowing) host tool stays executable under an
  // allowlist restriction.
  const ctx = await mount()
  const { scope, key } = await mintAgentScope(ctx, 'session-local')
  ctx.tools.register(tool('vm_shell'))
  ctx.tools.register(tool('host_shell'))
  scope.ctx.tools.restrict({ allow: ['vm_shell'] })
  scope.ctx.tools.register(tool('host_shell'))
  expect(await run(ctx, 'host_shell', key)).toMatch(/not available|denies|unknown tool/)
})

it.skipIf(!scopeHealthy)('cannot name the reserved PTC transport in a restriction, so only final-dispatch admission can deny run_code', async () => {
  // Documents why the contract needs the core latch: restrict() refuses to
  // name run_code, and no visibility filter reaches the transport itself.
  const ctx = await mount()
  const { scope } = await mintAgentScope(ctx, 'session-transport')
  expect(() => scope.ctx.tools.restrict({ deny: ['run_code'] })).toThrow(/reserved/)
})

it('keeps a captured step selection honest against replaced registrations', async () => {
  // The plan requires preserving this property: the selection captured for a
  // step re-checks availability and registration identity at dispatch.
  const ctx = await mount()
  const { key } = await mintAgentScope(ctx, 'session-capture')
  const original = tool('vm_shell')
  const dispose = ctx.tools.register(original)
  const toolSet = await ctx.tools.resolve({ agent: key, modelSelection: TEST_MODEL_SELECTION, signal: testToolSignal })
  expect(toolSet.view(key).get('vm_shell')).toBe(original)
  dispose()
  ctx.tools.register(tool('vm_shell'))
  expect(toolSet.view(key).get('vm_shell')).toBeUndefined()
  expect(await run(ctx, 'vm_shell', key, toolSet)).toMatch(/unknown tool/)
})