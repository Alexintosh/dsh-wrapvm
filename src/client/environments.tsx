/** Inventory and explicit lifecycle controls for managed environments. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useId, useState } from 'react'
import type { Environment, RemoteV02, RemovalPreview } from './v02.ts'
import type { LocaleKey } from './locales.ts'
import styles from './panel.module.css'
import { Button, Input, Checkbox, Modal, StateDot, IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceFields, formatBytes, parseResourceLimits } from './resource-fields.tsx'
import { WrapvmSectionIcon } from './icon.tsx'

type Translate = (key: LocaleKey) => string
/** Operations required by the inventory page. */
export interface EnvironmentsProps { remote: RemoteV02; t: Translate }
const key = () => randomUUID()
const number = (value: number | null | undefined) => value == null ? '—' : String(value)
/** List environments without starting any of them. */
export function Environments({ remote, t }: EnvironmentsProps) {
  const imageHintId = useId()
  const required = <T,>(method: T | undefined): T => {
    if (method === undefined) throw new Error(t('actionsPendingIntegration'))
    return method
  }
  const [items, setItems] = useState<readonly Environment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<RemovalPreview | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [cpu, setCpu] = useState('1')
  const [memory, setMemory] = useState('1')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{ id: string; name: string; cpu: string; memory: string; diskBytes: number | null } | null>(null)
  const [internet, setInternet] = useState(false)
  const [mountHost, setMountHost] = useState('')
  const [mountGuest, setMountGuest] = useState('')
  const [mountWrite, setMountWrite] = useState(false)
  const refresh = async () => { try { setItems((await remote.v02Snapshot(null)).environments) } catch (e) { setError(e instanceof Error ? e.message : t('failed')) } }
  useEffect(() => { let alive = true; void remote.v02Snapshot(null).then((s) => { if (alive) setItems(s.environments) }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : t('failed')) }); return () => { alive = false } }, [remote, t])
  const ids = items?.map(item => item.id).sort().join('\u0000') ?? ''
  useEffect(() => {
    if (!ids || !remote.v02WatchResources) return
    const lifetime = new AbortController()
    let subscription: ReturnType<NonNullable<RemoteV02['v02WatchResources']>> | undefined
    const watch = remote.v02WatchResources
    void (async () => {
      try {
        subscription = watch(ids.split('\u0000'))
        for await (const update of subscription) {
          if (lifetime.signal.aborted) break
          setItems(current => current?.map(item =>
            item.id === update.environmentId ? { ...item, resources: update.resources } : item) ?? current)
        }
      } catch { if (!lifetime.signal.aborted) setError(t('resourceStreamFailed')) }
      finally {
        if (!lifetime.signal.aborted) {
          setItems(current => current?.map(item => item.resources === null
            ? item : { ...item, resources: { ...item.resources, stale: true } }) ?? current)
        }
      }
    })()
    return () => { lifetime.abort(); subscription?.dispose() }
  }, [ids, remote, t])
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(true); setError(null)
    try {
      const result = await action()
      if (typeof result === 'object' && result !== null && 'state' in result && result.state === 'failed') {
        setError('error' in result && typeof result.error === 'string' ? result.error : t('operationFailed'))
        await refresh(); return false
      }
      await refresh(); return true
    } catch (e) { setError(e instanceof Error ? e.message : t('failed')); return false }
    finally { setBusy(false) }
  }
  const limits = parseResourceLimits(cpu, memory)
  const editedLimits = editing && parseResourceLimits(editing.cpu, editing.memory, editing.diskBytes)
  const requestPreview = async (id: string, volumes: boolean) => {
    setBusy(true); setError(null)
    try { setPreview(await required(remote.v02PreviewRemoval)(id, volumes)) }
    catch (e) { setError(e instanceof Error ? e.message : t('failed')) }
    finally { setBusy(false) }
  }
  const newEnvironment = () => { setError(null); setCreating(true) }
  const modalOpen = creating || editing !== null || preview !== null
  return <main className={styles.page} aria-busy={busy}>
    <div className={styles.content}>
      <header className={styles.header}>
        <div className={styles.heading}><h1>{t('environments')}</h1><p className={styles.intro}>{t('dockerNotice')}</p></div>
        <div className={styles.controls}>
          <Button variant="outline" icon={<IconRefreshOutlineRegular size={16} />} onClick={() => { void refresh() }} disabled={busy}>{t('refresh')}</Button>
          <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={newEnvironment} disabled={busy || !remote.v02Create}>{t('newEnvironment')}</Button>
        </div>
      </header>
      {error && !modalOpen && <p role="alert" className={styles.error}>{error}</p>}
      {items === null ? <div className={styles.list} role="status" aria-label={t('loading')}><div className={styles.skeleton} /><div className={styles.skeleton} /></div> : <>
        <div className={styles.summary}><span><strong>{items.length}</strong>{t('managedCount')}</span><span><strong>{items.some(item => item.observed === null) ? '—' : items.filter(item => item.observed?.phase === 'running').length}</strong>{t('activeCount')}</span></div>
        {items.length === 0 && <div className={styles.empty}>
          <span className={styles.emptyIcon} aria-hidden="true"><WrapvmSectionIcon size={24} active={false} /></span>
          <h2>{t('emptyTitle')}</h2><p>{t('emptyDescription')}</p>
        </div>}
        <div className={styles.list}>{items.map((item) => {
          const phase = item.observed?.phase
          const unavailable = busy || !!item.uncertainty || item.operations.some(op => op.state === 'running' || op.state === 'requested')
          return <article className={styles.card} key={item.id}>
            <div className={styles.cardHead}>
              <div className={styles.cardIdentity}><h2>{item.displayName}</h2><p className={styles.cardImage}>{item.image}</p></div>
              <span className={styles.status}><StateDot state={phase === 'running' ? 'done' : phase === 'paused' ? 'warning' : 'idle'} size={8} />{t(phase === 'running' || phase === 'paused' || phase === 'stopped' ? phase : 'unknown')}</span>
            </div>
            {item.uncertainty && <p role="alert" className={styles.error}>{t('outcomeUnknown')}: {item.uncertainty}</p>}
            <dl className={styles.metrics}>
              <div><dt>{t('cpu')}</dt><dd>{number(item.resources?.cpuPercent)}{item.resources?.cpuPercent == null ? '' : '%'}<span className={styles.metricNote}>{item.limits.cpuMillis / 1000} {t('cpuCores')}</span></dd></div>
              <div><dt>{t('memory')}</dt><dd>{formatBytes(item.resources?.memoryUsedBytes)}<span className={styles.metricNote}>/ {formatBytes(item.limits.memoryBytes)}</span></dd></div>
              <div><dt>{t('disk')}</dt><dd>{formatBytes(item.resources?.writableLayerBytes)}<span className={styles.metricNote}>{t('workspaceVolume')}: {formatBytes(item.resources?.volumeUsedBytes)}</span></dd></div>
            </dl>
            {item.resources?.stale && <p className={styles.hint}>{t('stale')}</p>}
            <div className={styles.cardFooter}>
              <span className={styles.hint}>{t('users')}: {item.bindings.length}</span>
              <div className={styles.controls}>
                {(phase === 'stopped' || phase == null) && <Button size="sm" variant="outline" disabled={!remote.v02Start || unavailable || phase !== 'stopped'} onClick={() => { void run(() => required(remote.v02Start)(item.id, key())) }}>{t('start')}</Button>}
                {phase === 'running' && <><Button size="sm" variant="outline" disabled={!remote.v02Pause || unavailable} onClick={() => { void run(() => required(remote.v02Pause)(item.id, key())) }}>{t('pause')}</Button><Button size="sm" variant="outline" disabled={!remote.v02Stop || unavailable} onClick={() => { void run(() => required(remote.v02Stop)(item.id, key())) }}>{t('stop')}</Button></>}
                {phase === 'paused' && <Button size="sm" variant="outline" disabled={!remote.v02Resume || unavailable} onClick={() => { void run(() => required(remote.v02Resume)(item.id, key())) }}>{t('resume')}</Button>}
                <Button size="sm" disabled={!remote.v02UpdateLimits || unavailable} onClick={() => { setError(null); setEditing({ id: item.id, name: item.displayName, cpu: String(item.limits.cpuMillis / 1000), memory: String(item.limits.memoryBytes / 1024 ** 3), diskBytes: item.limits.diskBytes }) }}>{t('limits')}</Button>
                <Button size="sm" className={styles.danger} disabled={!remote.v02PreviewRemoval || !remote.v02ConfirmRemoval || unavailable} onClick={() => { setDeleting(false); void requestPreview(item.id, false) }}>{t('remove')}</Button>
              </div>
            </div>
            <details className={styles.details}><summary>{t('details')}</summary><dl>
              <dt>{t('users')}</dt><dd>{item.bindings.map(binding => binding.sessionKey).join(', ') || t('none')}</dd>
              <dt>{t('mounts')}</dt><dd>{item.mounts.map(mount => `${mount.hostPath} → ${mount.guestPath} (${mount.access})`).join(', ') || t('none')}</dd>
            </dl></details>
          </article>
        })}</div>
      </>}
    </div>
    <Modal open={creating} onClose={() => { if (!busy) setCreating(false) }} title={t('createEnvironment')} closeLabel={t('close')} description={t('createDescription')} className={styles.modal} footer={<>
      <Button disabled={busy} onClick={() => { setCreating(false) }}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || !remote.v02Create || !name.trim() || !image.trim() || !internet || !limits || (!!mountHost !== !!mountGuest)} onClick={() => { if (!limits) return; void run(() => required(remote.v02Create)({ displayName: name.trim(), image: image.trim(), limits, internetAccess: internet, mounts: mountHost && mountGuest ? [{ hostPath: mountHost, guestPath: mountGuest, access: mountWrite ? 'read-write' : 'read-only' }] : [] }, key())).then((success) => { if (success) { setCreating(false); setName('') } }) }}>{busy ? t('loading') : t('createEnvironment')}</Button>
    </>}>
      <div className={styles.form}><fieldset disabled={busy}>
        <label className={styles.field}><span>{t('environmentName')}</span><Input className={styles.input} data-modal-autofocus value={name} onChange={(e) => { setName(e.target.value) }} /></label>
        <div className={styles.field}><label className={styles.field}><span>{t('image')}</span><Input className={styles.input} aria-describedby={imageHintId} value={image} onChange={(e) => { setImage(e.target.value) }} /></label><p id={imageHintId} className={styles.hint}>{t('imageHint')}</p></div>
        <ResourceFields cpu={cpu} memory={memory} onCpu={setCpu} onMemory={setMemory} t={t} />
        <div className={styles.network}><Checkbox checked={internet} onChange={setInternet} label={t('internet')} /><p className={styles.hint}>{t('networkDescription')}</p></div>
        <details className={styles.details}><summary>{t('advanced')}</summary>
          <p className={styles.hint}>{t('sharedDescription')}</p>
          <label className={styles.field}><span>{t('hostPath')}</span><Input className={styles.input} value={mountHost} onChange={(e) => { setMountHost(e.target.value) }} /></label>
          <label className={styles.field}><span>{t('guestPath')}</span><Input className={styles.input} value={mountGuest} onChange={(e) => { setMountGuest(e.target.value) }} /></label>
          <Checkbox checked={mountWrite} onChange={setMountWrite} label={t('readWrite')} />
        </details>
      </fieldset>{error && <p role="alert" className={styles.error}>{error}</p>}</div>
    </Modal>
    <Modal open={editing !== null} onClose={() => { if (!busy) setEditing(null) }} title={t('updateLimits')} closeLabel={t('close')} description={editing?.name ?? ''} className={styles.modal} footer={<>
      <Button disabled={busy} onClick={() => { setEditing(null) }}>{t('cancel')}</Button><Button variant="primary" disabled={busy || !editedLimits} onClick={() => { if (editing && editedLimits) void run(() => required(remote.v02UpdateLimits)(editing.id, editedLimits, key())).then((success) => { if (success) setEditing(null) }) }}>{t('save')}</Button>
    </>}>
      {editing && <div className={styles.form}><p className={styles.hint}>{t('limitsDescription')}</p><fieldset disabled={busy}><ResourceFields cpu={editing.cpu} memory={editing.memory} onCpu={(cpu) => { setEditing({ ...editing, cpu }) }} onMemory={(memory) => { setEditing({ ...editing, memory }) }} t={t} /></fieldset>{error && <p role="alert" className={styles.error}>{error}</p>}</div>}
    </Modal>
    <Modal open={preview !== null} onClose={() => { if (!busy) setPreview(null) }} title={t('remove')} closeLabel={t('close')} description={t('removeDescription')} className={styles.modal} footer={<>
      <Button disabled={busy} onClick={() => { setPreview(null) }}>{t('cancel')}</Button>
      <Button variant="outline" className={styles.danger} disabled={!preview || busy || preview.deleteVolumes !== deleting || Date.now() >= preview.expiresAt} onClick={() => { if (!preview) return; const selected = preview; void run(() => required(remote.v02ConfirmRemoval)(selected.environmentId, selected.confirmToken, selected.deleteVolumes, key())).then((success) => { if (success) setPreview(null) }) }}>{t('confirmRemove')}</Button>
    </>}>
      {preview && <div className={styles.form}><h3>{preview.displayName ?? preview.environmentId}</h3><dl className={styles.facts}><dt>{t('workspaceVolume')}</dt><dd>{preview.volumeName}</dd><dt>{t('mounts')}</dt><dd>{preview.hostMounts.join(', ') || t('none')}</dd></dl>
        <Checkbox checked={deleting} disabled={busy} onChange={(selected) => { setDeleting(selected); void requestPreview(preview.environmentId, selected) }} label={t('deleteVolumes')} />
        <p className={styles.hint}>{t('previewExpires')}: {new Date(preview.expiresAt).toLocaleTimeString()}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </div>}
    </Modal>
  </main>
}
