import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { VmActivationController } from '../src/activation.ts'
import { registerUseVmCommand } from '../src/vm-command.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'wrapvm-command-guest': { readonly kind: 'wrapvm-command-guest' } }
}

it('only starts the receiving Session from an authenticated owner Gateway command', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('vm-command-session'))
  const agent = { id: session.id, session } as Agent
  ctx.typert.lookups.register('agent', { parameter: 'agent', wire: 'agentId', resource: 'session',
    hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent', wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId', resolve: id => id === session.id ? agent : undefined })
  ctx.remoteAccess.registerPolicy('wrapvm-command-guest', {
    bindings: () => [{ role: { name: 'test', resource: 'session', actions: ['commands/execute'] }, resource: { kind: 'session', id: session.id } }],
  })
  const armed: string[] = []
  const activation = new VmActivationController({
    arm: async record => { armed.push(record.sessionKey) }, persistIntent: async () => {}, commit: async () => {},
    awaitQuiescence: async () => {}, bindEnvironment: async () => 'env-1', verifyEnvironment: async () => {}, quiescenceTimeoutMs: 1000, now: () => 1,
  })
  registerUseVmCommand(ctx.commands, activation)
  const owner = new Peer(ctx, { principal: { kind: 'owner' } })
  const guest = new Peer(ctx, { principal: { kind: 'wrapvm-command-guest' } })
  const invoke = (peer: Peer, line = '/use-vm') => ctx.typertGateway.invoke({ namespace: 'commands', method: 'execute', args: { agentId: session.id, line, submittedAttachments: [] }, peer })
  expect(await invoke(guest)).toMatchObject({ result: { kind: 'error' } })
  expect(await ctx.commands.execute(agent, '/use-vm', [], new AbortController().signal)).toMatchObject({ result: { kind: 'error' } })
  expect(await invoke(owner, '/use-vm arbitrary-env')).toMatchObject({ result: { kind: 'error' } })
  expect(armed).toEqual([])
  expect(await invoke(owner)).toMatchObject({ result: { kind: 'success' } })
  expect(armed).toEqual([session.id])
  activation.dispose()
  await owner.dispose()
  await guest.dispose()
  await ctx.fiber.dispose()
})

it('cancels only the exact running activation handle and does not report success', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SessionId('vm-command-cancel'))
  const agent = { id: session.id, session } as Agent
  const gate = Promise.withResolvers<void>()
  const activation = new VmActivationController({
    arm: async () => {}, persistIntent: async () => {}, commit: async () => {},
    awaitQuiescence: async () => await gate.promise, bindEnvironment: async () => 'env-1', verifyEnvironment: async () => {}, quiescenceTimeoutMs: 1000, now: () => 1,
  })
  let handler!: Parameters<Parameters<typeof registerUseVmCommand>[0]['register']>[0]['handler']
  registerUseVmCommand({ register: definition => { handler = definition.handler; return () => {} } }, activation)
  const abort = new AbortController()
  const pending = handler({ ownerGateway: true, agent, rawInput: '', signal: abort.signal })
  abort.abort()
  expect(await pending).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
  expect(activation.mode(session.id)).toBe('protected-unavailable')
  gate.resolve()
  activation.dispose()
  await ctx.fiber.dispose()
})
