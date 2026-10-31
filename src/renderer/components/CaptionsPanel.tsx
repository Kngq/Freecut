import { useEffect, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useToastStore } from '../state/toastStore'
import type { CaptionStatus } from '@shared/ipc'

/**
 * Auto-captions panel: transcribes the first video clip's source locally (whisper.cpp) and adds
 * the result as text clips on the Text track. Fully offline — the model is downloaded once into
 * the app data dir. Degrades gracefully with clear guidance when the local binary/model aren't
 * present yet.
 */
export default function CaptionsPanel() {
  const project = useProjectStore((s) => s.project)
  const addCaptionClips = useProjectStore((s) => s.addCaptionClips)
  const pushToast = useToastStore((s) => s.push)

  const [status, setStatus] = useState<CaptionStatus | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'downloading' | 'transcribing'>('checking')

  async function refresh() {
    setBusy('checking')
    const s = await window.api.captionStatus()
    setStatus(s)
    setBusy('idle')
  }

  useEffect(() => {
    void refresh()
  }, [])

  // The source to caption: the first media clip on the first video track.
  const firstVideoTrack = project.tracks.find((t) => t.type === 'video')
  const firstClip = firstVideoTrack?.clips.find((c) => c.kind === 'media')
  const asset = firstClip && firstClip.kind === 'media' ? project.assets.find((a) => a.id === firstClip.assetId) : undefined

  async function handleDownload() {
    setBusy('downloading')
    const res = await window.api.downloadCaptionModel()
    if (!res.ok) pushToast('error', `Couldn't download the caption model: ${res.error ?? 'unknown error'}`)
    await refresh()
  }

  async function handleTranscribe() {
    if (!asset) {
      pushToast('error', 'Add a video clip to the timeline first, then generate captions.')
      return
    }
    setBusy('transcribing')
    const res = await window.api.transcribeToCaptions(asset.path)
    setBusy('idle')
    if (!res.ok || !res.segments) {
      pushToast('error', `Captioning failed: ${res.error ?? 'unknown error'}`)
      return
    }
    if (res.segments.length === 0) {
      pushToast('info', 'No speech was detected in the clip.')
      return
    }
    // Shift segments to the clip's timeline position (segments are source-relative).
    const base = firstClip?.start ?? 0
    addCaptionClips(res.segments.map((seg) => ({ start: base + seg.start, end: base + seg.end, text: seg.text })))
    pushToast('info', `Added ${res.segments.length} caption line${res.segments.length === 1 ? '' : 's'} to the Text track.`)
  }

  return (
    <div className="media-bin-body">
      <h3>Auto Captions</h3>
      <div className="empty-hint" style={{ padding: '0 0 10px' }}>
        Transcribes the first video clip's audio locally (no internet, no cloud) and adds the lines
        as text clips. Uses a whisper.cpp model downloaded once to your machine.
      </div>

      {busy === 'checking' && <div className="empty-hint">Checking local caption engine…</div>}

      {status && !status.binaryAvailable && (
        <div className="caption-notice">
          <strong>Speech engine not found.</strong>
          <div>{status.installHint ?? 'Install whisper.cpp to enable captions.'}</div>
          <button style={{ marginTop: 8 }} onClick={() => void refresh()}>Re-check</button>
        </div>
      )}

      {status && status.binaryAvailable && !status.modelDownloaded && (
        <div className="caption-notice">
          <div>The caption model ({status.modelName}, ~142 MB) isn't downloaded yet.</div>
          <button style={{ marginTop: 8, width: '100%' }} disabled={busy === 'downloading'} onClick={handleDownload}>
            {busy === 'downloading' ? 'Downloading model…' : 'Download caption model'}
          </button>
        </div>
      )}

      {status && status.binaryAvailable && status.modelDownloaded && (
        <>
          <div className="empty-hint" style={{ padding: '0 0 8px' }}>
            {asset ? `Ready to caption: ${asset.name}` : 'Add a video clip to the timeline to caption it.'}
          </div>
          <button style={{ width: '100%' }} disabled={busy === 'transcribing' || !asset} onClick={handleTranscribe}>
            {busy === 'transcribing' ? 'Transcribing…' : 'Generate captions'}
          </button>
        </>
      )}
    </div>
  )
}
