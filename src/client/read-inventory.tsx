/** Read-only inventory while mutation endpoints are unavailable. */
import { useEffect, useState } from 'react'
import type { VmEnvironmentView } from '../types.ts'
import type { LocaleKey } from './locales.ts'
import type { ReadV02 } from './remote-adapter.ts'
import styles from './panel.module.css'
/** Render inventory and subscribe to the host sampler without starting environments. */
export function ReadInventory({ remote, t }: { remote: ReadV02; t: (key: LocaleKey) => string }) {
  const [items, setItems] = useState<readonly VmEnvironmentView[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { let active = true; setError(false); void remote.v02Snapshot(null).then(snapshot => { if (active) setItems(snapshot.environments) }, () => { if (active) setError(true) }); return () => { active = false } }, [remote, attempt])
  const ids = items?.map(item => item.id).sort().join('\u0000') ?? ''
  useEffect(() => {
    if (!ids || !remote.v02WatchResources) return
    let active = true
    let stream: ReturnType<NonNullable<ReadV02['v02WatchResources']>> | undefined
    void (async () => { try { stream = remote.v02WatchResources!(ids.split('\u0000')); for await (const update of stream) { if (!active) break; setItems(current => current?.map(item => item.id === update.environmentId ? { ...item, resources: update.resources } : item) ?? current) } } catch { if (active) setError(true) } finally { if (active) setItems(current => current?.map(item => item.resources ? { ...item, resources: { ...item.resources, stale: true } } : item) ?? current) } })()
    return () => { active = false; stream?.dispose() }
  }, [ids, remote, attempt])
  const number = (value: number | null | undefined) => value == null ? '—' : String(value)
  return <main className={styles.section}>
    <h1>{t('environments')}</h1><p>{t('dockerNotice')}</p><p>{t('actionsPendingIntegration')}</p>
    {error && <p role="alert">{t('resourceStreamFailed')}</p>}
    <button type="button" onClick={() => { setAttempt(value => value + 1) }}>{t('refresh')}</button>
    {items === null ? !error && <p role="status">{t('loading')}</p> : <>
      <p>{t('managedCount')}: {items.length} · {t('activeCount')}: {items.some(item => item.observed === null) ? '—' : items.filter(item => item.observed?.phase === 'running').length}</p>
      {items.map(item => <article className={styles.section} key={item.id}>
        <h2>{item.displayName}</h2><p>{item.backend} · {item.observed?.phase ?? t('unknown')}</p>
        {item.uncertainty && <p role="alert">{t('outcomeUnknown')}: {item.uncertainty}</p>}
        <p>{t('users')}: {!item.bindingsComplete ? t('usersUnknown') : item.bindings.map(binding => binding.sessionKey).join(', ') || t('none')}</p>
        <p>{t('resources')}: CPU {number(item.resources?.cpuPercent)}% · {t('memory')}: {number(item.resources?.memoryUsedBytes)} / {number(item.resources?.memoryLimitBytes)} · {t('disk')}: {number(item.resources?.writableLayerBytes)} + {number(item.resources?.volumeUsedBytes)} {item.resources?.stale ? `(${t('stale')})` : ''}</p>
        <p>{t('limits')}: {item.limits.cpuMillis} mCPU · {item.limits.memoryBytes} B · {number(item.limits.diskBytes)} B</p>
        <p>{t('mounts')}: {item.mounts.map(mount => `${mount.hostPath} → ${mount.guestPath} (${mount.access})`).join(', ') || t('none')}</p>
      </article>)}
    </>}
  </main>
}
