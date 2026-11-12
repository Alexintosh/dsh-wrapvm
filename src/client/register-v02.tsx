/** Slot registrations for the v0.2 UI, activated after the Remote face is available. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ReadInventory } from './read-inventory.tsx'
import { Environments } from './environments.tsx'
import { SessionDesktop } from './session.tsx'
import type { RemoteV02 } from './v02.ts'
import { VmViewer } from './viewer.tsx'
import { WrapvmSectionIcon } from './icon.tsx'
import type { ReadV02 } from './remote-adapter.ts'

const PANEL_ID = 'wrapvm-environments' as MainPanelId
const TAB_ID = '@deepseek-ai/dsh-wrapvm-isolate/desktop'
type MainProps = PropsRuntime<'main'> & PropsLocale<'wrapvm_isolate'> & InjectFace<{ remote: ReadV02 | null; full: RemoteV02 | null }>
type DesktopProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'wrapvm_isolate'> & InjectFace<{ remote: ReadV02 | null; full: RemoteV02 | null }>
function Page({ remote, full, t }: MainProps) { return full ? <Environments remote={full} t={t} /> : remote ? <ReadInventory remote={remote} t={t} /> : <p role="status">{t('sessionUnavailable')}</p> }
function Desktop({ remote, full, t, sessionId }: DesktopProps) { return full ? <SessionDesktop sessionKey={sessionId} remote={full} t={t} /> : remote ? <VmViewer sessionKey={sessionId} remote={remote} t={t} /> : <p role="status">{t('sessionUnavailable')}</p> }
/** Register and dispose the inventory and desktop seats with their context. */
export function registerV02Ui(ctx: Context, remote: ReadV02 | null, full: RemoteV02 | null): void {
  const t = ctx.locale.bind('wrapvm_isolate')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: 'wrapvm-desktop', title: () => t('desktopTitle'), guide: [{ id: 'open', order: 40, title: () => t('desktopTitle') }] }), 'wrapvm-isolate: desktop type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: 'wrapvm_isolate', inject: () => ({ remote, full }) }, Desktop)), 'wrapvm-isolate: desktop')
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: 'wrapvm_isolate', inject: () => ({ remote, full }) }, Page)), 'wrapvm-isolate: environments')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 1, locale: 'wrapvm_isolate', label: () => t('environments') }, WrapvmSectionIcon)), 'wrapvm-isolate: navigation')
}
