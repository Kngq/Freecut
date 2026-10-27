import { useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useRecentsStore } from '../state/recentsStore'

function formatRelativeTime(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

export default function Home({ onEnterEditor }: { onEnterEditor: () => void }) {
  const newProject = useProjectStore((s) => s.newProject)
  const setProject = useProjectStore((s) => s.setProject)
  const recents = useRecentsStore((s) => s.recents)
  const addRecent = useRecentsStore((s) => s.addRecent)
  const removeRecent = useRecentsStore((s) => s.removeRecent)
  const [missing, setMissing] = useState<Set<string>>(new Set())

  function handleCreate() {
    newProject()
    onEnterEditor()
  }

  async function handleOpenDialog() {
    const result = await window.api.openProjectDialog()
    if (!result) return
    setProject(result.project, result.path)
    addRecent(result.path, result.project.name)
    onEnterEditor()
  }

  async function handleOpenRecent(path: string) {
    const result = await window.api.openProjectAtPath(path)
    if (!result) {
      setMissing((s) => new Set(s).add(path))
      return
    }
    setProject(result.project, result.path)
    addRecent(result.path, result.project.name)
    onEnterEditor()
  }

  return (
    <div className="home">
      <aside className="home-sidebar">
        <div className="home-logo">freecut</div>
        <nav className="home-nav">
          <div className="home-nav-item active">
            <span className="home-nav-icon">⌂</span>
            Home
          </div>
          <button className="home-nav-action" onClick={handleOpenDialog}>
            <span className="home-nav-icon">⤒</span>
            Open Project…
          </button>
        </nav>
      </aside>

      <main className="home-main">
        <button className="home-create-banner" onClick={handleCreate}>
          <span className="home-create-icon">+</span>
          Create project
        </button>

        <section className="home-section">
          <h2>Recent projects</h2>
          {recents.length === 0 ? (
            <div className="home-empty">No projects yet — create your first one above.</div>
          ) : (
            <div className="home-grid">
              {recents.map((r) => (
                <div
                  key={r.path}
                  className={`home-card${missing.has(r.path) ? ' missing' : ''}`}
                  onClick={() => handleOpenRecent(r.path)}
                >
                  <div className="home-card-thumb">{missing.has(r.path) ? '⚠' : '▶'}</div>
                  <button
                    className="home-card-remove"
                    title="Remove from recents"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeRecent(r.path)
                    }}
                  >
                    ×
                  </button>
                  <div className="home-card-name">{r.name}</div>
                  <div className="home-card-meta">{missing.has(r.path) ? 'File not found' : formatRelativeTime(r.updatedAt)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
