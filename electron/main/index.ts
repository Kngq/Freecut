import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { probeMedia } from './probe'
import { ensurePreviewProxy } from './proxy'
import { ensureVideoCover } from './thumbnails'
import { ensureWaveform } from './waveform'
import { captionStatus, downloadCaptionModel, transcribeToCaptions } from './transcribe'
import { backgroundStatus, downloadBackgroundModel, removeBackground } from './background'
import { exportProject } from './export'
import { handleMediaRequest } from './mediaProtocol'
import { FILE_EXTENSION, type Project } from '@shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * The renderer loads from http://localhost:5173 in dev, so <video>/<audio> elements can't
 * load file:// sources directly — Chromium's media URL safety check rejects the cross-scheme
 * load. Serving local media through this privileged custom scheme instead (handled by
 * handleMediaRequest, which reads the file with Node fs directly — see that file for why not
 * net.fetch) works from both the dev server origin and the packaged file:// origin.
 */
const MEDIA_SCHEME = 'freecut-media'

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // A file dropped outside a drop zone would otherwise replace the editor with that file.
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  protocol.handle(MEDIA_SCHEME, handleMediaRequest)
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

const VIDEO_FILTERS = [
  { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }
]

ipcMain.handle('media:openDialog', async () => {
  if (!win) return []
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: VIDEO_FILTERS
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('media:probe', async (_e, filePath: string) => {
  return probeMedia(filePath)
})

ipcMain.handle('media:ensureProxy', async (_e, filePath: string, videoCodec?: string, audioCodec?: string) => {
  return ensurePreviewProxy(filePath, videoCodec, audioCodec)
})

ipcMain.handle('media:thumbnails', async (_e, filePath: string) => {
  return ensureVideoCover(filePath)
})

ipcMain.handle('media:waveform', async (_e, filePath: string) => {
  return ensureWaveform(filePath)
})

ipcMain.handle('caption:status', async () => {
  return captionStatus()
})

ipcMain.handle('caption:download', async () => {
  return downloadCaptionModel()
})

ipcMain.handle('caption:transcribe', async (_e, filePath: string) => {
  return transcribeToCaptions(filePath)
})

ipcMain.handle('background:status', async () => {
  return backgroundStatus()
})

ipcMain.handle('background:download', async () => {
  return downloadBackgroundModel()
})

ipcMain.handle('background:remove', async (_e, filePath: string) => {
  return removeBackground(filePath)
})

ipcMain.handle('project:saveDialog', async (_e, defaultName: string) => {
  if (!win) return null
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName.endsWith(FILE_EXTENSION) ? defaultName : `${defaultName}${FILE_EXTENSION}`,
    filters: [{ name: 'freecut project', extensions: ['fcproj'] }]
  })
  return result.canceled || !result.filePath ? null : result.filePath
})

async function readProjectFile(filePath: string): Promise<{ path: string; project: Project } | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return { path: filePath, project: JSON.parse(raw) as Project }
  } catch {
    return null
  }
}

ipcMain.handle('project:openDialog', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'freecut project', extensions: ['fcproj'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readProjectFile(result.filePaths[0])
})

ipcMain.handle('project:open', async (_e, filePath: string) => {
  return readProjectFile(filePath)
})

ipcMain.handle('project:write', async (_e, filePath: string, project: Project) => {
  await fs.writeFile(filePath, JSON.stringify(project, null, 2), 'utf-8')
  return true
})

ipcMain.handle('export:dialog', async (_e, defaultName: string) => {
  if (!win) return null
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName.endsWith('.mp4') ? defaultName : `${defaultName}.mp4`,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  })
  return result.canceled || !result.filePath ? null : result.filePath
})

ipcMain.handle('export:run', async (_e, project: Project, outputPath: string) => {
  return exportProject(project, outputPath, (progress) => {
    win?.webContents.send('export:progress', progress)
  })
})
