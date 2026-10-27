import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { probeMedia } from './probe'
import { exportProject } from './export'
import { FILE_EXTENSION, type Project } from '@shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

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

app.whenReady().then(createWindow)

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
