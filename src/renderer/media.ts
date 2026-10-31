import type { MediaAsset } from '@shared/types'
import { ALL_SUPPORTED_EXTENSIONS, SUPPORTED_EXTENSIONS, fileExtension } from '@shared/types'

/** MIME type used when dragging an already-imported asset from the media bin. */
export const ASSET_DRAG_MIME = 'application/x-freecut-asset'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** Human-readable list of supported formats, for import error messages. */
function supportedFormatsSentence(): string {
  const strip = (exts: readonly string[]) => exts.map((e) => e.slice(1)).join(', ')
  return (
    `Video: ${strip(SUPPORTED_EXTENSIONS.video)}\n` +
    `Audio: ${strip(SUPPORTED_EXTENSIONS.audio)}\n` +
    `Images: ${strip(SUPPORTED_EXTENSIONS.image)}`
  )
}

/** Result of an import attempt: the assets that loaded, plus any files that were rejected with
 *  a specific, human-readable reason (surfaced to the user instead of a silent drop). */
export interface ImportResult {
  assets: MediaAsset[]
  rejected: { name: string; reason: string }[]
}

/** Probes each path and returns the assets that could be read, plus explained rejections. */
export async function importAssets(paths: string[]): Promise<ImportResult> {
  const assets: MediaAsset[] = []
  const rejected: { name: string; reason: string }[] = []
  for (const path of paths) {
    const ext = fileExtension(path)
    // Classify BEFORE probing so an unsupported container gets a precise message rather than a
    // generic "couldn't read" (the probe returns null for both cases otherwise).
    if (!ALL_SUPPORTED_EXTENSIONS.includes(ext)) {
      rejected.push({
        name: basename(path),
        reason: ext
          ? `"${ext}" files aren't supported.`
          : `files without a recognized extension aren't supported.`
      })
      continue
    }
    const probe = await window.api.probeMedia(path)
    if (!probe) {
      rejected.push({
        name: basename(path),
        reason: `the file couldn't be read (it may be corrupt or use an unsupported codec).`
      })
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
  return { assets, rejected }
}

/** Back-compat convenience: import and surface any rejections via the toast channel, returning
 *  just the successful assets. Callers that want to show the reasons inline use importAssets. */
export async function assetsFromPaths(paths: string[]): Promise<MediaAsset[]> {
  const { assets, rejected } = await importAssets(paths)
  if (rejected.length > 0) {
    const lines = rejected.map((r) => `• ${r.name} — ${r.reason}`).join('\n')
    notifyImportError(`Couldn't import ${rejected.length} file${rejected.length > 1 ? 's' : ''}:\n${lines}\n\nSupported formats:\n${supportedFormatsSentence()}`)
  }
  return assets
}

/** Where import errors go. Defaults to a simple alert; the app overrides this at startup to
 *  route rejections through the on-screen toast/slash popup instead. */
let importErrorHandler: (message: string) => void = (message) => alert(message)
export function setImportErrorHandler(handler: (message: string) => void) {
  importErrorHandler = handler
}
function notifyImportError(message: string) {
  importErrorHandler(message)
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
