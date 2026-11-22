/** Session-scoped desktop and explicit external authenticated browser links. */
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { WrapvmSectionIcon } from './icon.tsx'
import { useEffect, useRef, useState } from 'react'
import type { RemoteV02, SessionView } from './v02.ts'
import type { LocaleKey } from './locales.ts'
import styles from './panel.module.css'

type Translate = (key: LocaleKey) => string
/** Props for an ephemeral, revision-checked desktop. */
export interface ViewerProps { sessionKey: string; remote: Pick<RemoteV02, 'v02WatchSession' | 'v02ViewerUrl'>; t: Translate }
/** Render a viewer only while its session subscription remains current. */
export function VmViewer({ sessionKey, remote, t }: ViewerProps) {
  const [viewState, setViewState] = useState<{ session: string; source: ViewerProps['remote']; value: SessionView } | null>(null)
  const [viewer, setViewer] = useState<{ session: string; source: ViewerProps['remote']; url: string; expiresAt: number | null } | null>(null)
  const [browserLink, setBrowserLink] = useState<{ session: string; source: ViewerProps['remote']; url: string; expiresAt: number | null } | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const revision = useRef<{ epoch: string; revision: number } | null>(null)
  useEffect(() => {
    const epoch = ++generation.current
    revision.current = null
    setViewState(null); setViewer(null); setBrowserLink(null); setError(false); setBusy(false)
    let subscription: ReturnType<NonNullable<ViewerProps['remote']['v02WatchSession']>> | undefined
    void (async () => {
      try {
        if (!remote.v02WatchSession) throw new Error('Session stream unavailable')
        subscription = remote.v02WatchSession(sessionKey)
        const iterator = subscription[Symbol.asyncIterator]()
        while (generation.current === epoch) {
          const next = await iterator.next()
          if (generation.current !== epoch) return
          if (next.done) break
          if (revision.current?.epoch !== next.value.epoch || revision.current.revision !== next.value.revision) { setViewer(null); setBrowserLink(null) }
          revision.current = { epoch: next.value.epoch, revision: next.value.revision }
          setViewState({ session: sessionKey, source: remote, value: next.value })
        }
      } catch {
        // A broken subscription cannot authorize a viewer.
      } finally {
        if (generation.current === epoch) {
          revision.current = null; setViewer(null); setBrowserLink(null); setViewState(null); setError(true); setBusy(false)
        }
      }
    })()
    return () => { generation.current++; revision.current = null; subscription?.dispose() }
  }, [remote, sessionKey])
  const view = viewState?.session === sessionKey && viewState.source === remote ? viewState.value : null
  const currentViewer = viewer?.session === sessionKey && viewer.source === remote ? viewer : null
  const currentBrowserLink = browserLink?.session === sessionKey && browserLink.source === remote ? browserLink : null
  useEffect(() => {
    if (currentBrowserLink?.expiresAt == null) return
    const timer = setTimeout(() => { setBrowserLink(null) }, Math.max(0, currentBrowserLink.expiresAt - Date.now()))
    return () => { clearTimeout(timer) }
  }, [currentBrowserLink])
  useEffect(() => {
    if (currentViewer?.expiresAt == null) return
    const timer = setTimeout(() => { setViewer(null) }, Math.max(0, currentViewer.expiresAt - Date.now()))
    return () => { clearTimeout(timer) }
  }, [currentViewer])
  const open = async (external = false) => {
    const expected = revision.current, epoch = generation.current
    if (expected === null || busy || !remote.v02ViewerUrl) return
    setBusy(true); setError(false)
    if (external) setBrowserLink(null)
    try {
      const result = await remote.v02ViewerUrl(sessionKey, expected.epoch, expected.revision)
      if (generation.current === epoch && revision.current === expected && result?.epoch === expected.epoch
        && result.revision === expected.revision && (result.expiresAt === null || result.expiresAt > Date.now())) {
        const url = new URL(result.url)
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !url.searchParams.get('token')) throw new Error('Invalid authenticated viewer URL')
        const link = { session: sessionKey, source: remote, url: url.href, expiresAt: result.expiresAt }
        if (external) {
          // Keep a real user-clickable fallback: browser popup policies may reject an async open.
          // Electron deliberately returns null while forwarding this call to shell.openExternal.
          setBrowserLink(link)
          window.open(link.url, '_blank', 'noopener,noreferrer')
        } else setViewer(link)
      }
      else if (generation.current === epoch && revision.current === expected) setError(true)
    } catch {
      if (generation.current === epoch && revision.current === expected) setError(true)
    } finally {
      if (generation.current === epoch) setBusy(false)
    }
  }
  return <section className={`${styles.section} ${styles.viewerSection}`} aria-busy={busy || view === null && !error}>
    <div className={styles.viewerHead}><h2>{t('desktopTitle')}</h2><div className={styles.controls}>
      {view && <Button size="sm" variant="outline" disabled={busy || view.binding === null || !remote.v02ViewerUrl} onClick={() => { void open(true) }}>{t('openHostBrowser')}</Button>}
      {currentViewer && <Button size="sm" onClick={() => { setViewer(null) }}>{t('closeViewer')}</Button>}
    </div></div>
    {currentBrowserLink && <p className={styles.hint}>{t('browserLinkHint')} <a className={styles.externalLink} href={currentBrowserLink.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('authenticatedLink')}</a></p>}
    {view === null ? error ? <p role="alert" className={styles.error}>{t('sessionUnavailable')}</p> : <div role="status" aria-label={t('loading')} className={styles.loading}><StateDot state="ongoing" size={20} /></div> : <>
      {error && <p role="alert" className={styles.error}>{t('viewerUnavailable')}</p>}
      {currentViewer === null ? <div className={styles.viewerEmpty}>
        <span className={styles.emptyIcon} aria-hidden="true"><WrapvmSectionIcon size={24} active={false} /></span>
        <p>{view.binding ? t('environmentSelected') : t('noBinding')}</p>
        <p className={styles.hint}>{t('desktopDescription')}</p>
        <Button variant="primary" onClick={() => { void open() }} disabled={busy || view.binding === null || !remote.v02ViewerUrl}>{busy ? t('loading') : t('viewer')}</Button>
      </div> : <iframe src={currentViewer.url} title={t('desktopTitle')} className={styles.viewer} allow="clipboard-read; clipboard-write" />}
    </>}
  </section>
}
