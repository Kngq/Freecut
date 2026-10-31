import { useEffect, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useRecentsStore } from '../state/recentsStore'
import { ASPECT_PRESETS, aspectPresetFor } from '@shared/types'
import type { ExportProgress } from '@shared/ipc'

export default function Toolbar({ onGoHome }: { onGoHome: () => void }) {
  const project = useProjectStore((s) => s.project)
  const filePath = useProjectStore((s) => s.filePath)
  const dirty = useProjectStore((s) => s.dirty)
  const addTextClipToTrack = useProjectStore((s) => s.addTextClipToTrack)
  const setCanvasSize = useProjectStore((s) => s.setCanvasSize)
  const playhead = useProjectStore((s) => s.playhead)
  const newProject = useProjectStore((s) => s.newProject)
  const setProject = useProjectStore((s) => s.setProject)
  const addRecent = useRecentsStore((s) => s.addRecent)

  const [exportState, setExportState] = useState<ExportProgress | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => window.api.onExportProgress((p) => setExportState(p)), [])

  async function handleNew() {
    if (dirty && !confirm('Discard unsaved changes and start a new project?')) return
    newProject()
  }

  function handleGoHome() {
    if (dirty && !confirm('Discard unsaved changes and go back to Home?')) return
    onGoHome()
  }

  async function handleOpen() {
    const result = await window.api.openProjectDialog()
    if (!result) return
    setProject(result.project, result.path)
    addRecent(result.path, result.project.name)
  }

  async function handleSave() {
    let path = filePath
    if (!path) {
      path = await window.api.saveProjectDialog(project.name)
      if (!path) return
    }
    await window.api.writeProject(path, project)
    useProjectStore.setState({ filePath: path, dirty: false })
    addRecent(path, project.name)
  }

  async function handleSaveAs() {
    const path = await window.api.saveProjectDialog(project.name)
    if (!path) return
    await window.api.writeProject(path, project)
    useProjectStore.setState({ filePath: path, dirty: false })
    addRecent(path, project.name)
  }

  async function handleExport() {
    const path = await window.api.exportDialog(project.name)
    if (!path) return
    setExporting(true)
    setExportState({ ratio: 0, message: 'Starting…' })
    const result = await window.api.exportProject(project, path)
    setExporting(false)
    if (!result.ok) {
      alert(`Export failed:\n${result.error}`)
    }
  }

  function addText() {
    const textTrack = project.tracks.find((t) => t.type === 'text')
    if (textTrack) addTextClipToTrack(textTrack.id, playhead)
  }

  return (
    <div className="toolbar">
      <button onClick={handleGoHome}>Home</button>
      <span className="title">freecut — {project.name}{dirty ? ' *' : ''}</span>
      <button onClick={handleNew}>New</button>
      <button onClick={handleOpen}>Open</button>
      <button onClick={handleSave}>Save</button>
      <button onClick={handleSaveAs}>Save As</button>
      <button onClick={addText}>+ Text</button>
      <span style={{ width: 1, background: 'var(--border)', height: 20, margin: '0 4px' }} />
      <label style={{ color: 'var(--text-dim)', fontSize: 12 }}>Aspect</label>
      <select
        value={aspectPresetFor(project.canvas.width, project.canvas.height)?.id ?? 'custom'}
        title="Output aspect ratio / resolution"
        onChange={(e) => {
          const preset = ASPECT_PRESETS.find((p) => p.id === e.target.value)
          if (preset) setCanvasSize(preset.width, preset.height)
        }}
      >
        {!aspectPresetFor(project.canvas.width, project.canvas.height) && (
          <option value="custom">
            Custom ({project.canvas.width}×{project.canvas.height})
          </option>
        )}
        {ASPECT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="spacer" />
      {exporting && exportState && (
        <>
          <span>{exportState.message}</span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${Math.round(exportState.ratio * 100)}%` }} />
          </div>
        </>
      )}
      <button onClick={handleExport} disabled={exporting}>
        Export MP4
      </button>
    </div>
  )
}
