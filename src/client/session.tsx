/** Conversation-specific environment selection and desktop. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useRef, useState } from 'react'
import type { RemoteV02, Snapshot } from './v02.ts'
import type { LocaleKey } from './locales.ts'
import { VmViewer } from './viewer.tsx'
import styles from './panel.module.css'
/** Conversation controls and their remote operations. */
export interface SessionDesktopProps { sessionKey: string; remote: RemoteV02; t: (key: LocaleKey) => string }
/** Select an environment for the current conversation. */
export function SessionDesktop({ sessionKey, remote, t }: SessionDesktopProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const epoch = ++generation.current
    setSnapshot(null); setSelected(''); setError(null); setBusy(false)
    void remote.v02Snapshot(sessionKey).then((next) => { if (generation.current === epoch) { setSnapshot(next); setSelected(next.binding?.environmentId ?? '') } }, (e: unknown) => { if (generation.current === epoch) setError(e instanceof Error ? e.message : t('failed')) })
    return () => { generation.current++ }
  }, [remote, sessionKey, t])
  const select = async () => {
    if (busy || !remote.v02Bind || !selected) return
    const epoch = generation.current
    setBusy(true); setError(null)
    try {
      const operation = await remote.v02Bind(sessionKey, selected, randomUUID())
      if (operation.state === 'failed') throw new Error(t('operationFailed'))
      const next = await remote.v02Snapshot(sessionKey)
      if (generation.current === epoch) setSnapshot(next)
    } catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : t('failed')) }
    finally { if (generation.current === epoch) setBusy(false) }
  }
  const unselect = async () => {
    if (busy || !remote.v02Unbind) return
    const epoch = generation.current
    setBusy(true); setError(null)
    try {
      await remote.v02Unbind(sessionKey, randomUUID())
      const next = await remote.v02Snapshot(sessionKey)
      if (generation.current === epoch) { setSnapshot(next); setSelected('') }
    } catch (e) { if (generation.current === epoch) setError(e instanceof Error ? e.message : t('failed')) }
    finally { if (generation.current === epoch) setBusy(false) }
  }
  return <div className={`${styles.section} ${styles.session}`}>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.selector}>
      <p className={styles.hint}>{t('selectDescription')}</p>
      {snapshot === null ? <p role="status" className={styles.hint}>{t('loading')}</p> : <>
        {snapshot.environments.length === 0 ? <p className={styles.notice}>{t('noEnvironments')}</p> : <>
          <label className={styles.field}><span>{t('selectEnvironment')}</span><select className={styles.select} value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value) }}><option value="">{t('selectEnvironment')}</option>{snapshot.environments.map(item => <option value={item.id} key={item.id}>{item.displayName} · {item.observed?.phase ?? t('unknown')}</option>)}</select></label>
          <div className={styles.controls}>
            <Button size="sm" variant="outline" disabled={busy || !selected || !remote.v02Bind || snapshot.binding?.environmentId === selected} onClick={() => { void select() }}>{t('bind')}</Button>
            {snapshot.binding && <Button size="sm" disabled={busy || !remote.v02Unbind} onClick={() => { void unselect() }}>{t('unbind')}</Button>}
          </div>
        </>}
      </>}
    </div>
    <VmViewer key={sessionKey} sessionKey={sessionKey} remote={remote} t={t} />
  </div>
}
