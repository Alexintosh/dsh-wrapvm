/** Native modal with focus restoration and Escape handling. */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
/** Render modal content while open. */
export function ConfirmDialog({ labelId, onClose, children }: { labelId: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    return () => { if (dialog.open && typeof dialog.close === 'function') dialog.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <dialog ref={ref} aria-labelledby={labelId} onCancel={event => { event.preventDefault(); onClose() }}>{children}</dialog>
}
