/** Resource inputs display human units; the host continues to receive integers. */
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleKey } from './locales.ts'
import type { Limits } from './v02.ts'
import styles from './panel.module.css'

const GIB = 1024 ** 3
/** Format resource measurements without treating an absent measurement as zero. */
export function formatBytes(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value < 1024) return `${value} B`
  const unit = value >= GIB ? GIB : 1024 ** 2
  return `${Number((value / unit).toFixed(1))} ${unit === GIB ? 'GiB' : 'MiB'}`
}
/** Parse human units, rejecting fractional bytes and invalid host limits. */
export function parseResourceLimits(cpu: string, memory: string, diskBytes: number | null = null): Limits | null {
  const cpuMillis = Number(cpu) * 1000, memoryBytes = Number(memory) * GIB
  if (!Number.isSafeInteger(cpuMillis) || cpuMillis <= 0 || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) return null
  return { cpuMillis, memoryBytes, diskBytes }
}
/** Render paired CPU and memory fields used by create and edit dialogs. */
export function ResourceFields({ cpu, memory, onCpu, onMemory, t }: {
  cpu: string
  memory: string
  onCpu: (value: string) => void
  onMemory: (value: string) => void
  t: (key: LocaleKey) => string
}) {
  return <div className={styles.formRow}>
    <label className={styles.field}><span>{t('cpuCores')}</span><Input className={styles.input} type="number" min="0.001" step="0.5" value={cpu} onChange={(event) => { onCpu(event.target.value) }} /></label>
    <label className={styles.field}><span>{t('memoryGiB')}</span><Input className={styles.input} type="number" min="0.125" step="0.5" value={memory} onChange={(event) => { onMemory(event.target.value) }} /></label>
  </div>
}
