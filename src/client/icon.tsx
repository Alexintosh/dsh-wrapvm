/** Settings navigation icon. */
import type React from 'react'

/** Section icon shown in the settings navigation rail. */
export function WrapvmSectionIcon({ size, active }: { size: number; active: boolean }): React.ReactElement {
  const stroke = 'currentColor'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2"
        fill="none"
        stroke={stroke}
        strokeWidth={active ? 1.8 : 1.5} />
      <rect x="6.5" y="9.5" width="11" height="6" rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2" />
      <circle cx="9" cy="12.5" r="1" fill="currentColor" />
      <circle cx="12" cy="12.5" r="1" fill="currentColor" />
      <circle cx="15" cy="12.5" r="1" fill="currentColor" />
    </svg>
  )
}
