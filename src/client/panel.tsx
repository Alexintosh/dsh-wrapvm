/** Settings access to the conversation desktop. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { RemoteV02 } from './v02.ts'
import { SessionDesktop } from './session.tsx'
import styles from './panel.module.css'
type Props = PropsRuntime<'settings.section'> & PropsLocale<'wrapvm_isolate'> & InjectFace<{ readRemote: RemoteV02 | null }>
/** Use the same conversation controller as the desktop sidebar. */
export function WrapvmSection({ t, useSessions, readRemote }: Props) {
  const session = useSessions(state => Object.values(state.byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id)
  return <section className={`${styles.section} ${styles.settings}`}>
    <div><h2>{t('title')}</h2><p className={styles.intro}>{t('intro')}</p></div>
    {readRemote && session !== undefined ? <SessionDesktop key={session} sessionKey={session} remote={readRemote} t={t} /> : <p>{t(readRemote ? 'noBinding' : 'sessionUnavailable')}</p>}
  </section>
}
