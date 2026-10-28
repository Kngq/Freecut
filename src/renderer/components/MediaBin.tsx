import { useState } from 'react'
import type { ReactNode } from 'react'
import { useProjectStore } from '../state/projectStore'
import type { MediaAsset } from '@shared/types'
import { ASSET_DRAG_MIME, assetsFromPaths, droppedFilePaths } from '../media'

function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

type TabId = 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'captions' | 'filters' | 'adjust'

const TABS: { id: TabId; label: string; enabled: boolean; icon: ReactNode }[] = [
  {
    id: 'media',
    label: 'Media',
    enabled: true,
    icon: (
      <TabIcon>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  },
  {
    id: 'audio',
    label: 'Audio',
    enabled: true,
    icon: (
      <TabIcon>
        <line x1="4" y1="9" x2="4" y2="15" />
        <line x1="8" y1="5" x2="8" y2="19" />
        <line x1="12" y1="2" x2="12" y2="22" />
        <line x1="16" y1="5" x2="16" y2="19" />
        <line x1="20" y1="9" x2="20" y2="15" />
      </TabIcon>
    )
  },
  {
    id: 'text',
    label: 'Text',
    enabled: true,
    icon: (
      <TabIcon>
        <line x1="5" y1="6" x2="19" y2="6" />
        <line x1="12" y1="6" x2="12" y2="19" />
      </TabIcon>
    )
  },
  {
    id: 'stickers',
    label: 'Stickers',
    enabled: false,
    icon: (
      <TabIcon>
        <path d="M12 3l2.47 5.4 5.93.58-4.47 4.03 1.3 5.84L12 15.9l-5.23 2.95 1.3-5.84L3.6 8.98l5.93-.58z" />
      </TabIcon>
    )
  },
  {
    id: 'effects',
    label: 'Effects',
    enabled: false,
    icon: (
      <TabIcon>
        <path d="M12 2c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6z" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  },
  {
    id: 'transitions',
    label: 'Transitions',
    enabled: false,
    icon: (
      <TabIcon>
        <path d="M5 6l6 6-6 6V6z" />
        <path d="M19 6l-6 6 6 6V6z" />
      </TabIcon>
    )
  },
  {
    id: 'captions',
    label: 'Captions',
    enabled: false,
    icon: (
      <TabIcon>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <line x1="7" y1="11" x2="12" y2="11" />
        <line x1="7" y1="14" x2="17" y2="14" />
      </TabIcon>
    )
  },
  {
    id: 'filters',
    label: 'Filters',
    enabled: false,
    icon: (
      <TabIcon>
        <circle cx="9" cy="12" r="6" />
        <circle cx="15" cy="12" r="6" />
      </TabIcon>
    )
  },
  {
    id: 'adjust',
    label: 'Adjust',
    enabled: false,
    icon: (
      <TabIcon>
        <line x1="6" y1="4" x2="6" y2="20" />
        <circle cx="6" cy="9" r="2" fill="currentColor" stroke="none" />
        <line x1="12" y1="4" x2="12" y2="20" />
        <circle cx="12" cy="15" r="2" fill="currentColor" stroke="none" />
        <line x1="18" y1="4" x2="18" y2="20" />
        <circle cx="18" cy="7" r="2" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  }
]

export default function MediaBin() {
  const project = useProjectStore((s) => s.project)
  const addAsset = useProjectStore((s) => s.addAsset)
  const removeAsset = useProjectStore((s) => s.removeAsset)
  const addMediaClipToTrack = useProjectStore((s) => s.addMediaClipToTrack)
  const addTextClipToTrack = useProjectStore((s) => s.addTextClipToTrack)
  const playhead = useProjectStore((s) => s.playhead)
  const [dropActive, setDropActive] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('media')

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

  function handleAddText() {
    const textTrack = project.tracks.find((t) => t.type === 'text')
    if (textTrack) addTextClipToTrack(textTrack.id, playhead)
  }

  function handleRemoveAsset(asset: MediaAsset, e: React.MouseEvent) {
    e.stopPropagation()
    const usedCount = project.tracks.reduce(
      (n, t) => n + t.clips.filter((c) => c.kind === 'media' && c.assetId === asset.id).length,
      0
    )
    if (usedCount > 0 && !confirm(`"${asset.name}" is used in ${usedCount} clip${usedCount > 1 ? 's' : ''} on the timeline. Remove it and ${usedCount > 1 ? 'those clips' : 'that clip'}?`)) {
      return
    }
    removeAsset(asset.id)
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

  function renderAssetList(assets: MediaAsset[], emptyHint: string) {
    return (
      <>
        {assets.length === 0 && <div className="empty-hint">{emptyHint}</div>}
        {assets.map((asset) => (
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
            <button className="asset-item-remove" title="Remove from media pool" onClick={(e) => handleRemoveAsset(asset, e)}>
              ×
            </button>
            <div className="name">{asset.name}</div>
            <div className="meta">
              {asset.kind}
              {asset.duration > 0 ? ` · ${asset.duration.toFixed(1)}s` : ''}
            </div>
          </div>
        ))}
      </>
    )
  }

  return (
    <div
      className={`panel media-bin ${dropActive ? 'drop-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <div className="media-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`media-tab ${tab.id === activeTab ? 'active' : ''}`}
            disabled={!tab.enabled}
            title={tab.enabled ? undefined : 'Coming soon'}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      {activeTab === 'media' && (
        <div className="media-bin-body">
          <button onClick={handleImport} style={{ width: '100%', marginBottom: 10 }}>
            + Import media
          </button>
          {renderAssetList(
            project.assets.filter((a) => a.kind !== 'audio'),
            'No media imported yet. Drop files here or onto the timeline.'
          )}
        </div>
      )}
      {activeTab === 'audio' && (
        <div className="media-bin-body">
          <button onClick={handleImport} style={{ width: '100%', marginBottom: 10 }}>
            + Import audio
          </button>
          {renderAssetList(
            project.assets.filter((a) => a.kind === 'audio'),
            'No audio imported yet. Drop audio files here or onto the timeline.'
          )}
        </div>
      )}
      {activeTab === 'text' && (
        <div className="media-bin-body">
          <button onClick={handleAddText} style={{ width: '100%', marginBottom: 10 }}>
            + Add text
          </button>
          <div className="empty-hint">Adds a text clip to the Text track at the playhead.</div>
        </div>
      )}
    </div>
  )
}
