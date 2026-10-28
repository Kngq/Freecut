import type { MediaAsset, Project } from './types'

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

export interface FreecutApi {
  openMediaDialog(): Promise<string[]>
  probeMedia(path: string): Promise<ProbeResult | null>
  /** Chromium can't decode some codecs browsers never had to support (ProRes, DNxHD, etc.) even
   *  though ffmpeg (which export uses directly) decodes them natively — so preview needs an
   *  H.264 proxy for those. Returns the proxy path to use for preview, or null if the source is
   *  already browser-playable and no proxy is needed. Export always uses the original asset
   *  path regardless; this only affects what <video>/<audio> elements load. */
  ensurePreviewProxy(path: string, videoCodec?: string, audioCodec?: string): Promise<string | null>
  saveProjectDialog(defaultName: string): Promise<string | null>
  openProjectDialog(): Promise<{ path: string; project: Project } | null>
  openProjectAtPath(path: string): Promise<{ path: string; project: Project } | null>
  writeProject(path: string, project: Project): Promise<boolean>
  exportDialog(defaultName: string): Promise<string | null>
  exportProject(project: Project, outputPath: string): Promise<ExportResult>
  onExportProgress(cb: (progress: ExportProgress) => void): () => void
  fileUrl(path: string): string
  /** Absolute path of a File from a drag-and-drop (File.path was removed in Electron 32). */
  getPathForFile(file: File): string
}

declare global {
  interface Window {
    api: FreecutApi
  }
}
