import { useState } from 'react'
import type { ReactNode } from 'react'
import { canHaveTransition, useProjectStore } from '../state/projectStore'
import {
  EFFECT_CATALOG,
  TRANSITION_CATALOG,
  effectCatalogEntry,
  formatMMSS,
  type Clip,
  type ClipEffectType,
  type MediaAsset,
  type TransitionType
} from '@shared/types'
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
    enabled: true,
    icon: (
      <TabIcon>
        <path d="M12 2c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6z" fill="currentColor" stroke="none" />
      </TabIcon>
    )
  },
  {
    id: 'transitions',
    label: 'Transitions',
    enabled: true,
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
  const setPreviewAsset = useProjectStore((s) => s.setPreviewAsset)
  const previewAssetId = useProjectStore((s) => s.previewAssetId)
  const playhead = useProjectStore((s) => s.playhead)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const addClipEffect = useProjectStore((s) => s.addClipEffect)
  const removeClipEffect = useProjectStore((s) => s.removeClipEffect)
  const setTransition = useProjectStore((s) => s.setTransition)
  const setTransitionType = useProjectStore((s) => s.setTransitionType)
  const [dropActive, setDropActive] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('media')

  // The clip the Effects/Transitions tabs act on (mirrors the Inspector's selection).
  let selectedClip: Clip | null = null
  for (const track of project.tracks) {
    const c = track.clips.find((cl) => cl.id === selectedClipId)
    if (c) {
      selectedClip = c
      break
    }
  }

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

  function handleApplyEffect(type: ClipEffectType) {
    if (selectedClipId) addClipEffect(selectedClipId, type)
  }

  function handleApplyTransition(type: TransitionType) {
    if (!selectedClipId) return
    // Give the transition a sensible default length if the clip has none yet, then set its
    // type. setTransition/setTransitionType are no-ops on clips that can't carry a transition.
    if (!selectedClip?.transitionIn || selectedClip.transitionIn.duration <= 0) {
      setTransition(selectedClipId, 1)
    }
    setTransitionType(selectedClipId, type)
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
        <div className="asset-grid">
          {assets.map((asset) => {
            // Show the FIRST frame of the cover sprite as the card thumbnail, fit to the card's
            // full width with its natural aspect (letterboxed top/bottom in the square). The
            // sprite is `frames` frames wide, so width = frames*100% makes each frame one card
            // wide; height auto keeps the aspect; left/center isolates frame 0.
            const frames = asset.cover ? Math.max(1, asset.cover.frames) : 1
            const thumbStyle = asset.cover
              ? {
                  backgroundImage: `url(${window.api.fileUrl(asset.cover.path)})`,
                  backgroundSize: `${frames * 100}% auto`,
                  backgroundPosition: 'left center',
                  backgroundRepeat: 'no-repeat'
                }
              : undefined
            return (
              <div
                className={`asset-card ${previewAssetId === asset.id ? 'previewing' : ''}`}
                key={asset.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_MIME, asset.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => setPreviewAsset(asset.id)}
                onDoubleClick={() => handleAddToTimeline(asset)}
                title="Click to preview, drag onto the timeline, or double-click to add"
              >
                <div className="asset-thumb" style={thumbStyle}>
                  {!asset.cover && <span className="asset-thumb-fallback">{asset.kind}</span>}
                  {asset.duration > 0 && <span className="asset-duration">{formatMMSS(asset.duration)}</span>}
                  <button className="asset-item-remove" title="Remove from media pool" onClick={(e) => handleRemoveAsset(asset, e)}>
                    ×
                  </button>
                </div>
                <div className="asset-card-name" title={asset.name}>
                  {asset.name}
                </div>
              </div>
            )
          })}
        </div>
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
      {activeTab === 'effects' && (
        <div className="media-bin-body">
          {!selectedClip || selectedClip.kind !== 'media' ? (
            <div className="empty-hint">Select a video or image clip on the timeline to apply an effect.</div>
          ) : (
            <>
              <div className="empty-hint" style={{ padding: '0 0 8px' }}>Click an effect to add it to the selected clip.</div>
              <div className="fx-grid">
                {EFFECT_CATALOG.map((entry) => (
                  <button key={entry.type} className="fx-card" onClick={() => handleApplyEffect(entry.type)} title={`Add "${entry.label}"`}>
                    <span className="fx-card-label">{entry.label}</span>
                  </button>
                ))}
              </div>
              {selectedClip.effects && selectedClip.effects.length > 0 && (
                <>
                  <h3 style={{ marginTop: 14 }}>Applied</h3>
                  {selectedClip.effects.map((fx) => (
                    <div className="fx-applied-row" key={fx.id}>
                      <span>{effectCatalogEntry(fx.type)?.label ?? fx.type}</span>
                      <button title="Remove effect" onClick={() => selectedClipId && removeClipEffect(selectedClipId, fx.id)}>
                        ×
                      </button>
                    </div>
                  ))}
                  <div className="empty-hint" style={{ padding: '6px 0 0' }}>Fine-tune parameters in the Inspector.</div>
                </>
              )}
            </>
          )}
        </div>
      )}
      {activeTab === 'transitions' && (
        <div className="media-bin-body">
          {!canHaveTransition(project, selectedClipId) ? (
            <div className="empty-hint">
              Select a clip on the main video track (not the first clip) to add a transition into it from the previous clip.
            </div>
          ) : (
            <>
              <div className="empty-hint" style={{ padding: '0 0 8px' }}>Click a transition to apply it to the selected clip.</div>
              <div className="fx-grid">
                {TRANSITION_CATALOG.map((t) => {
                  const active = selectedClip?.transitionIn?.type === t.type && (selectedClip?.transitionIn?.duration ?? 0) > 0
                  return (
                    <button
                      key={t.type}
                      className={`fx-card ${active ? 'active' : ''}`}
                      onClick={() => handleApplyTransition(t.type)}
                      title={`Apply "${t.label}"`}
                    >
                      <span className="fx-card-label">{t.label}</span>
                    </button>
                  )
                })}
              </div>
              {selectedClip?.transitionIn && selectedClip.transitionIn.duration > 0 && (
                <div className="empty-hint" style={{ padding: '10px 0 0' }}>
                  Current: {TRANSITION_CATALOG.find((t) => t.type === selectedClip!.transitionIn!.type)?.label} ·{' '}
                  {selectedClip.transitionIn.duration.toFixed(2)}s — adjust duration in the Inspector.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
