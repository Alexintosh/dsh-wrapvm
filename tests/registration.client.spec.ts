/** Browser registration waits for Remote availability and unloads its UI contributions. */
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createElement, Fragment } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { WrapvmSection } from '../src/client/panel.tsx'

function SettingsFrame({ renderSlot }: PropsRenderSlots<'settings.section' | 'settings.section.icon'>) {
  return createElement(Fragment, null,
    renderSlot('settings.section', { close: () => {} }),
    renderSlot('settings.section.icon', { size: 16, active: false }))
}

it('waits for the Remote mount and disposes the settings section, icon and locales', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
    },
  }, SettingsFrame)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.locale.setLocale('en')
  const mounted = Promise.withResolvers<() => Promise<void>>()
  const mount = vi.fn(() => mounted.promise)
  const actions = { status: vi.fn(), start: vi.fn(), stop: vi.fn(), viewerUrl: vi.fn() }
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    $mount() { return mount() }
  }
  new Remote()
  ctx.provide('remote.wrapvmIsolate', actions)
  const fiber = ctx.plugin({ inject, apply })
  await vi.waitFor(() => { expect(mount).toHaveBeenCalledOnce() })
  expect(slots.entries('settings.section')).toHaveLength(0)
  mounted.resolve(async () => {})
  await fiber.await()
  expect(slots.entries('settings.section')[0]?.component).toBe(WrapvmSection)
  expect(slots.entries('settings.section')[0]?.options).toMatchObject({ id: 'wrapvm-isolate' })
  expect(slots.entries('settings.section')[0]?.locale).toBe('wrapvm_isolate')
  expect(slots.entries('settings.section.icon')).toHaveLength(1)
  expect(ctx.locale.bind('wrapvm_isolate')('title')).toBe('Wrapvm desktop')
  ctx.locale.setLocale('zh')
  expect(ctx.locale.bind('wrapvm_isolate')('title')).toBe('Wrapvm 桌面')
  await fiber.dispose()
  expect(slots.entries('settings.section')).toHaveLength(0)
  expect(slots.entries('settings.section.icon')).toHaveLength(0)
  expect(ctx.locale.bind('wrapvm_isolate')('title')).toBe('title')
})


it('registers and withdraws both v0.2 seats and the desktop type after mount', async () => {
  const { SidebarRightTabRegistry } = await import('../../../client/ui-sidebar-right/src/client/tab-registry.ts')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  } }, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const tabs = new SidebarRightTabRegistry(ctx)
  ctx.provide('sidebarRightTabs', tabs)
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount() { return async () => {} }
  }
  new Remote()
  const snapshot = { environments: [], policy: null, binding: null, bindingComplete: false }
  const wire = {
    status: vi.fn(), start: vi.fn(), stop: vi.fn(), viewerUrl: vi.fn(),
    v02Snapshot: vi.fn().mockResolvedValue({ ok: true, value: snapshot }),
    v02WatchSession: vi.fn(), v02WatchResources: vi.fn(), v02ViewerUrl: vi.fn(),
  }
  ctx.provide('remote.wrapvmIsolate', wire)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  await vi.waitFor(() => { expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(1) })
  expect(ctx.slots.entries('main')).toHaveLength(1)
  expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(1)
  expect(tabs.entries().some(entry => entry.kind === 'wrapvm-desktop')).toBe(true)
  const face = ctx.slots.entries('settings.section')[0]?.inject?.()
  expect(face?.readRemote).toBeTruthy()
  await expect(face?.readRemote?.v02Snapshot(null)).resolves.toEqual(snapshot)
  expect(wire.v02Snapshot).toHaveBeenCalledWith(null)
  await fiber.dispose()
  expect(ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  expect(ctx.slots.entries('main')).toHaveLength(0)
  expect(ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
  expect(tabs.entries().some(entry => entry.kind === 'wrapvm-desktop')).toBe(false)
})
