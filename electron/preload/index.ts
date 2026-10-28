import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FreecutApi } from '@shared/ipc'

/**
 * Builds a freecut-media:// URL, escaping characters like '#', '?', '%' and spaces that
 * break a raw path. Not a plain file:// URL: the renderer runs on http://localhost in dev,
 * and Chromium rejects <video>/<audio> loading a file:// source cross-scheme from there.
 * The main process serves this custom scheme from the real file (see electron/main/index.ts).
 */
function toFileUrl(filePath: string): string {
  let p = filePath.replace(/\\/g, '/')
  if (!p.startsWith('/')) p = `/${p}` // Windows drive paths: C:/x -> /C:/x
  return `freecut-media://${p.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')}`
}

const api: FreecutApi = {
  openMediaDialog: () => ipcRenderer.invoke('media:openDialog'),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
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
