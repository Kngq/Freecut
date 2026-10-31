import type { MediaAsset } from '@shared/types'

/** MIME type used when dragging an already-imported asset from the media bin. */
export const ASSET_DRAG_MIME = 'application/x-freecut-asset'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** Probes each path and returns the assets that could be read. Unreadable files are reported once. */
export async function assetsFromPaths(paths: string[]): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = []
  const skipped: string[] = []
  for (const path of paths) {
    const probe = await window.api.probeMedia(path)
    if (!probe) {
      skipped.push(basename(path))
      continue
    }
    // Some codecs (ProRes, DNxHD, ...) demux fine in Chromium but never actually decode a
    // frame — no error, just a permanently blank/silent clip. ensurePreviewProxy returns null
    // immediately for anything already browser-playable, so this is a no-op for the common case.
    const previewPath = probe.kind === 'image' ? undefined : (await window.api.ensurePreviewProxy(path, probe.videoCodec, probe.audioCodec)) ?? undefined

    // Cover image for the timeline clip (first frame for video; the image file itself for images)
    // and an audio waveform (anything with an audio stream). Both are produced locally with the
    // bundled ffmpeg and cached on disk — fully offline, no network. Generated off the ORIGINAL
    // source (not the preview proxy) so they're correct even when no proxy exists.
    const [videoCover, waveform] = await Promise.all([
      probe.kind === 'video' ? window.api.generateThumbnails(path) : Promise.resolve(null),
      probe.hasAudio || probe.kind === 'audio' ? window.api.generateWaveform(path) : Promise.resolve(null)
    ])
    // Images are their own cover — one frame, the image itself (no extraction needed).
    const cover =
      probe.kind === 'image'
        ? { path, frames: 1, frameWidth: probe.width ?? 160, frameHeight: probe.height ?? 90 }
        : videoCover ?? undefined

    assets.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      kind: probe.kind,
      name: basename(path),
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      previewPath,
      cover,
      waveform: waveform ?? undefined
    })
  }
  if (skipped.length > 0) alert(`Could not import:\n${skipped.join('\n')}`)
  return assets
}

/** Absolute paths of OS files in a drop event (empty if none, e.g. an in-app drag). */
export function droppedFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => window.api.getPathForFile(file))
    .filter((p) => p.length > 0)
}

export function isMediaDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(ASSET_DRAG_MIME) || types.includes('Files')
}
