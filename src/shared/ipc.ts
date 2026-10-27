import type { MediaAsset, Project } from './types'

export interface ProbeResult {
  kind: MediaAsset['kind']
  duration: number
  width?: number
  height?: number
  hasAudio: boolean
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
