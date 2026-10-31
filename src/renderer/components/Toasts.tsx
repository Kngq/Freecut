import { useToastStore } from '../state/toastStore'

/** Bottom-center stack of transient notifications (import errors, etc.). Replaces blocking
 *  `alert()` popups with a non-modal "slash" message the user can read and dismiss. */
export default function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          <span className="toast-message">{t.message}</span>
          <button className="toast-close" title="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
