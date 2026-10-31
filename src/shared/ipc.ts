import type { MediaAsset, Project, ThumbnailCover, Waveform } from './types'
export type { ThumbnailCover, Waveform } from './types'

export interface ProbeResult {
  kind: MediaAsset['kind']
  duration: number
  width?: number
  height?: number
  hasAudio: boolean
  videoCodec?: string
  audioCodec?: string
}

export interface ExportProgress {
  ratio: number // 0-1
  message: string
}

export interface ExportResult {
  ok: boolean
  outputPath?: string
  error?: string
}

/** One transcribed caption line, in timeline seconds. */
export interface CaptionSegment {
  start: number
  end: number
  text: string
}

/** Whether local captioning can run right now (whisper.cpp binary + downloaded model). */
export interface CaptionStatus {
  binaryAvailable: boolean
  binaryPath?: string
  modelDownloaded: boolean
  modelName: string
  installHint?: string
}

export interface FreecutApi {
  openMediaDialog(): Promise<string[]>
  probeMedia(path: string): Promise<ProbeResult | null>
  /** Chromium can't decode some codecs browsers never had to support (ProRes, DNxHD, etc.) even
   *  though ffmpeg (which export uses directly) decodes them natively — so preview needs an
   *  H.264 proxy for those. Returns the proxy path to use for preview, or null if the source is
   *  already browser-playable and no proxy is needed. Export always uses the original asset
   *  path regardless; this only affects what <video>/<audio> elements load. */
  ensurePreviewProxy(path: string, videoCodec?: string, audioCodec?: string): Promise<string | null>
  /** A single cover image for a timeline clip — the first frame of a video (extracted locally
   *  with the bundled ffmpeg), or the image file itself for image assets. Null for audio-only
   *  sources or on failure. Cached on disk per source. Fully offline — no network. */
  generateThumbnails(path: string): Promise<ThumbnailCover | null>
  /** Normalized audio peak magnitudes for a timeline waveform. Null for silent/failed sources.
   *  Cached on disk per source. */
  generateWaveform(path: string): Promise<Waveform | null>
  saveProjectDialog(defaultName: string): Promise<string | null>
  openProjectDialog(): Promise<{ path: string; project: Project } | null>
  openProjectAtPath(path: string): Promise<{ path: string; project: Project } | null>
  writeProject(path: string, project: Project): Promise<boolean>
  exportDialog(defaultName: string): Promise<string | null>
  exportProject(project: Project, outputPath: string): Promise<ExportResult>
  onExportProgress(cb: (progress: ExportProgress) => void): () => void
  /** Local auto-caption (whisper.cpp): status, one-time model download, and transcription. */
  captionStatus(): Promise<CaptionStatus>
  downloadCaptionModel(): Promise<{ ok: boolean; error?: string }>
  transcribeToCaptions(path: string): Promise<{ ok: boolean; segments?: CaptionSegment[]; error?: string }>
  fileUrl(path: string): string
  /** Absolute path of a File from a drag-and-drop (File.path was removed in Electron 32). */
  getPathForFile(file: File): string
}

declare global {
  interface Window {
    api: FreecutApi
  }
}
