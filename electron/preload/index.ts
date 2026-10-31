import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FreecutApi } from '@shared/ipc'

/**
 * Builds a freecut-media:// URL, escaping characters like '#', '?', '%' and spaces that
 * break a raw path. Not a plain file:// URL: the renderer runs on http://localhost in dev,
 * and Chromium rejects <video>/<audio> loading a file:// source cross-scheme from there.
 * The main process serves this custom scheme from the real file (see electron/main/mediaProtocol.ts).
 *
 * The fixed "local" host is deliberate, not decorative: a scheme registered with
 * `standard: true` parses like http(s) (scheme://host/path), so an EMPTY host
 * (freecut-media:///Users/...) gets its first path segment silently reinterpreted as the host
 * during Chromium's URL normalization — "/Users/kng/x" became host "users", path "/kng/x".
 * Confirmed empirically: this was masked in testing only because /private/tmp (where test
 * fixtures happened to live) has a /tmp symlink alias that coincidentally still resolved after
 * the leading segment was swallowed — any real path (~/Desktop, ~/Library, /var/folders/...)
 * broke outright. A non-empty, constant host sidesteps the ambiguity entirely.
 */
function toFileUrl(filePath: string): string {
  let p = filePath.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = `/${p}` // Windows drive paths: C:/x -> /C:/x
  const encoded = p.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')
  return `freecut-media://local${encoded}`
}

const api: FreecutApi = {
  openMediaDialog: () => ipcRenderer.invoke('media:openDialog'),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
  ensurePreviewProxy: (path, videoCodec, audioCodec) => ipcRenderer.invoke('media:ensureProxy', path, videoCodec, audioCodec),
  generateThumbnails: (path) => ipcRenderer.invoke('media:thumbnails', path),
  generateWaveform: (path) => ipcRenderer.invoke('media:waveform', path),
  captionStatus: () => ipcRenderer.invoke('caption:status'),
  downloadCaptionModel: () => ipcRenderer.invoke('caption:download'),
  transcribeToCaptions: (path) => ipcRenderer.invoke('caption:transcribe', path),
  saveProjectDialog: (defaultName) => ipcRenderer.invoke('project:saveDialog', defaultName),
  openProjectDialog: () => ipcRenderer.invoke('project:openDialog'),
  openProjectAtPath: (path) => ipcRenderer.invoke('project:open', path),
  writeProject: (path, project) => ipcRenderer.invoke('project:write', path, project),
  exportDialog: (defaultName) => ipcRenderer.invoke('export:dialog', defaultName),
  exportProject: (project, outputPath) => ipcRenderer.invoke('export:run', project, outputPath),
  onExportProgress: (cb) => {
    const listener = (_e: unknown, progress: Parameters<typeof cb>[0]) => cb(progress)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },
  fileUrl: toFileUrl,
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
