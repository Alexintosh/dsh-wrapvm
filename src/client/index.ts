/** Register the wrapvm settings section and its generated Remote contribution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import remote from 'dsh-wrapvm-isolate/remote'
import { WrapvmSection } from './panel.tsx'
import { WrapvmSectionIcon } from './icon.tsx'
import { registerV02Ui } from './register-v02.tsx'
import { adaptV02, hasReadWire } from './remote-adapter.ts'
import { en, zh, type LocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Wrapvm settings copy. */
    wrapvm_isolate: LocaleKey
  }
}

/** Loader identity. */
export const name = 'wrapvmIsolate'
/** Required browser services. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the Remote descriptors before registering the settings controls.
 * @param ctx - client plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(remote)
  await ctx.inject(['remote.wrapvmIsolate'], scope => {
    const remote = hasReadWire(scope.remote.wrapvmIsolate) ? adaptV02(scope.remote.wrapvmIsolate) : null
    registerSettings(scope, remote)
    scope.inject(['sidebarRightTabs'], nested => { registerV02Ui(nested, remote, remote) })
  })
}

function registerSettings(ctx: Context, readRemote: ReturnType<typeof adaptV02> | null): void {
  ctx.effect(() => ctx.locale.register('wrapvm_isolate', { en, zh }), 'wrapvm-isolate: locales')
  const t = ctx.locale.bind('wrapvm_isolate')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'wrapvm-isolate', order: 5,
    label: () => t('title'), locale: 'wrapvm_isolate',
    inject: () => ({
      readRemote,
    }),
  }, WrapvmSection))
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon', id: 'wrapvm-isolate',
  }, WrapvmSectionIcon))
}
