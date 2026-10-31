import { useEffect, useState } from 'react'
import { useToastStore } from '../state/toastStore'
import type { BackgroundStatus } from '@shared/ipc'

/**
 * Inline control to remove a media clip's background locally (ONNX matting). Beta/scaffold:
 * wired end-to-end but depends on the optional onnxruntime-node runtime + a once-downloaded
 * model; degrades gracefully with guidance when either is missing. On success it reports the
 * alpha ProRes output path (import-and-overlay wiring is a follow-up).
 */
export default function BackgroundRemovalButton({ assetPath }: { assetPath: string }) {
  const pushToast = useToastStore((s) => s.push)
  const [status, setStatus] = useState<BackgroundStatus | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'downloading' | 'running'>('checking')

  async function refresh() {
    setBusy('checking')
    setStatus(await window.api.backgroundStatus())
    setBusy('idle')
  }
  useEffect(() => {
    void refresh()
  }, [])

  async function handleDownload() {
    setBusy('downloading')
    const res = await window.api.downloadBackgroundModel()
    if (!res.ok) pushToast('error', `Couldn't download the matting model: ${res.error ?? 'unknown error'}`)
    await refresh()
  }

  async function handleRun() {
    setBusy('running')
    const res = await window.api.removeBackground(assetPath)
    setBusy('idle')
    if (!res.ok) {
      pushToast('error', `Background removal failed: ${res.error ?? 'unknown error'}`)
      return
    }
    pushToast('info', `Background removed → ${res.outputPath}. (Import-as-overlay coming soon.)`)
  }

  return (
    <div className="field-row">
      <label>Background removal (beta)</label>
      {busy === 'checking' && <div className="empty-hint">Checking local ML runtime…</div>}
      {status && !status.runtimeAvailable && (
        <div className="empty-hint">{status.installHint ?? 'Local ML runtime not installed.'}</div>
      )}
      {status && status.runtimeAvailable && !status.modelDownloaded && (
        <button style={{ width: '100%' }} disabled={busy === 'downloading'} onClick={handleDownload}>
          {busy === 'downloading' ? 'Downloading model…' : 'Download matting model'}
        </button>
      )}
      {status && status.runtimeAvailable && status.modelDownloaded && (
        <button style={{ width: '100%' }} disabled={busy === 'running'} onClick={handleRun}>
          {busy === 'running' ? 'Removing background…' : 'Remove background'}
        </button>
      )}
    </div>
  )
}
