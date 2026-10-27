import { useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import type { MediaAsset } from '@shared/types'
import { ASSET_DRAG_MIME, assetsFromPaths, droppedFilePaths } from '../media'

export default function MediaBin() {
  const project = useProjectStore((s) => s.project)
  const addAsset = useProjectStore((s) => s.addAsset)
  const addMediaClipToTrack = useProjectStore((s) => s.addMediaClipToTrack)
  const playhead = useProjectStore((s) => s.playhead)
  const [dropActive, setDropActive] = useState(false)

  async function importPaths(paths: string[]) {
    for (const asset of await assetsFromPaths(paths)) addAsset(asset)
  }

  async function handleImport() {
    await importPaths(await window.api.openMediaDialog())
  }

  function handleAddToTimeline(asset: MediaAsset) {
    const trackType = asset.kind === 'audio' ? 'audio' : 'video'
    const track = project.tracks.find((t) => t.type === trackType)
    if (!track) return
    addMediaClipToTrack(track.id, asset, playhead)
  }

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  function onDrop(e: React.DragEvent) {
    setDropActive(false)
    const paths = droppedFilePaths(e.dataTransfer)
    if (paths.length === 0) return
    e.preventDefault()
    void importPaths(paths)
  }

  return (
    <div
      className={`panel media-bin ${dropActive ? 'drop-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <h3>Media</h3>
      <button onClick={handleImport} style={{ width: '100%', marginBottom: 10 }}>
        + Import media
      </button>
      {project.assets.length === 0 && <div className="empty-hint">No media imported yet. Drop files here or onto the timeline.</div>}
      {project.assets.map((asset) => (
        <div
          className="asset-item"
          key={asset.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onDoubleClick={() => handleAddToTimeline(asset)}
          title="Drag onto the timeline, or double-click to add"
        >
          <div className="name">{asset.name}</div>
          <div className="meta">
            {asset.kind}
            {asset.duration > 0 ? ` · ${asset.duration.toFixed(1)}s` : ''}
          </div>
        </div>
      ))}
    </div>
  )
}
