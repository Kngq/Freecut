import { useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { projectDuration, type Clip, type MediaAsset, type Track } from '@shared/types'
import { ASSET_DRAG_MIME, assetsFromPaths, droppedFilePaths, isMediaDrag } from '../media'

/** Width of the sticky track label column; lanes and the ruler's 0s mark start after it. */
const LABEL_WIDTH = 90

interface DragState {
  clipId: string
  sourceTrackId: string
  pointerStartX: number
  pointerStartY: number
  clipStartPx: number
  dx: number
  trackRowY: number[]
  trackRowIds: string[]
}

interface TrimState {
  clipId: string
  edge: 'start' | 'end'
}

function clipClassName(clip: Clip, track: Track): string {
  if (clip.kind === 'text') return 'text'
  return track.type === 'audio' ? 'audio' : 'video'
}

export default function Timeline() {
  const project = useProjectStore((s) => s.project)
  const pxPerSecond = useProjectStore((s) => s.pxPerSecond)
  const playhead = useProjectStore((s) => s.playhead)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const selectClip = useProjectStore((s) => s.selectClip)
  const trimClip = useProjectStore((s) => s.trimClip)
  const moveFreeClip = useProjectStore((s) => s.moveFreeClip)
  const reorderVideoClip = useProjectStore((s) => s.reorderVideoClip)
  const setZoom = useProjectStore((s) => s.setZoom)
  const addAsset = useProjectStore((s) => s.addAsset)
  const addMediaClipToTrack = useProjectStore((s) => s.addMediaClipToTrack)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const trackRowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [trim, setTrim] = useState<TrimState | null>(null)
  const [dropTrackId, setDropTrackId] = useState<string | null>(null)

  const duration = useMemo(() => Math.max(projectDuration(project), 10), [project])
  const totalWidth = duration * pxPerSecond + 200

  function timeAt(clientX: number): number {
    const rect = bodyRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, (clientX - rect.left - LABEL_WIDTH) / pxPerSecond)
  }

  /** The track a dropped asset should land on: the hovered one if its type fits, else the first that does. */
  function trackForAsset(asset: MediaAsset, hovered: Track): Track | undefined {
    const wanted = asset.kind === 'audio' ? 'audio' : 'video'
    return hovered.type === wanted ? hovered : project.tracks.find((t) => t.type === wanted)
  }

  function onLaneDragOver(e: React.DragEvent, track: Track) {
    if (!isMediaDrag(e.dataTransfer)) return
    e.preventDefault() // required, or the browser refuses the drop
    e.dataTransfer.dropEffect = 'copy'
    if (dropTrackId !== track.id) setDropTrackId(track.id)
  }

  function onLaneDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTrackId(null)
  }

  async function onLaneDrop(e: React.DragEvent, track: Track) {
    if (!isMediaDrag(e.dataTransfer)) return
    e.preventDefault()
    setDropTrackId(null)
    // DataTransfer is only readable during the event, so read everything before awaiting.
    const dropTime = timeAt(e.clientX)
    const assetId = e.dataTransfer.getData(ASSET_DRAG_MIME)
    const paths = assetId ? [] : droppedFilePaths(e.dataTransfer)

    let assets: MediaAsset[]
    if (assetId) {
      const asset = useProjectStore.getState().project.assets.find((a) => a.id === assetId)
      assets = asset ? [asset] : []
    } else {
      assets = await assetsFromPaths(paths)
      assets.forEach(addAsset)
    }

    // Multiple files are laid out one after another starting at the drop point.
    let cursor = dropTime
    for (const asset of assets) {
      const target = trackForAsset(asset, track)
      if (!target) continue
      addMediaClipToTrack(target.id, asset, cursor, { insertAtStart: true })
      const state = useProjectStore.getState()
      const added = state.project.tracks.flatMap((t) => t.clips).find((c) => c.id === state.selectedClipId)
      if (added) cursor = added.start + added.duration
    }
  }

  function onRulerClick(e: React.MouseEvent) {
    setPlayhead(timeAt(e.clientX))
  }

  function onClipPointerDown(e: React.MouseEvent, clip: Clip, track: Track) {
    e.stopPropagation()
    selectClip(clip.id)
    const rows = project.tracks.map((t) => {
      const el = trackRowRefs.current.get(t.id)
      const rect = el?.getBoundingClientRect()
      return rect ? rect.top + rect.height / 2 : 0
    })
    const initial: DragState = {
      clipId: clip.id,
      sourceTrackId: track.id,
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      clipStartPx: clip.start * pxPerSecond,
      dx: 0,
      trackRowY: rows,
      trackRowIds: project.tracks.map((t) => t.id)
    }
    dragRef.current = initial
    setDrag(initial)

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return
      dragRef.current = { ...dragRef.current, dx: ev.clientX - dragRef.current.pointerStartX }
      setDrag(dragRef.current)
    }
    function onUp(ev: MouseEvent) {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d) return
      // A plain click shouldn't count as a move (it would mark the project dirty for nothing).
      if (Math.abs(ev.clientX - d.pointerStartX) < 3 && Math.abs(ev.clientY - d.pointerStartY) < 3) return

      const newLeftPx = Math.max(0, d.clipStartPx + (ev.clientX - d.pointerStartX))
      const newStart = newLeftPx / pxPerSecond

      let targetTrackId = d.sourceTrackId
      let bestDist = Infinity
      d.trackRowY.forEach((y, i) => {
        const dist = Math.abs(ev.clientY - y)
        if (dist < bestDist) {
          bestDist = dist
          targetTrackId = d.trackRowIds[i]
        }
      })
      const tracks = useProjectStore.getState().project.tracks
      const targetTrack = tracks.find((t) => t.id === targetTrackId)
      const sourceTrack = tracks.find((t) => t.id === d.sourceTrackId)
      if (!targetTrack || !sourceTrack) return

      if (targetTrack.type !== sourceTrack.type) {
        // Don't allow cross-type drops in this barebones build.
        return
      }

      if (targetTrack.type === 'video') {
        const siblings = targetTrack.clips.filter((c) => c.id !== d.clipId)
        let index = siblings.length
        for (let i = 0; i < siblings.length; i++) {
          if (newStart < siblings[i].start + siblings[i].duration / 2) {
            index = i
            break
          }
        }
        reorderVideoClip(d.clipId, targetTrackId, index)
      } else {
        moveFreeClip(d.clipId, newStart, targetTrackId)
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function onTrimPointerDown(e: React.MouseEvent, clip: Clip, edge: 'start' | 'end') {
    e.stopPropagation()
    selectClip(clip.id)
    setTrim({ clipId: clip.id, edge })

    function onMove(ev: MouseEvent) {
      const t = timeAt(ev.clientX)
      trimClip(clip.id, edge, t)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setTrim(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function renderClip(clip: Clip, track: Track) {
    const isDraggingThis = drag?.clipId === clip.id
    const left = isDraggingThis ? drag.clipStartPx + drag.dx : clip.start * pxPerSecond
    const width = Math.max(clip.duration * pxPerSecond, 4)
    const label = clip.kind === 'text' ? clip.text : track.name

    return (
      <div
        key={clip.id}
        className={`clip ${clipClassName(clip, track)} ${selectedClipId === clip.id ? 'selected' : ''}`}
        style={{ left, width, zIndex: isDraggingThis ? 10 : 1 }}
        onMouseDown={(e) => onClipPointerDown(e, clip, track)}
        title={label}
      >
        {track.type !== 'audio' && <div className="trim-handle left" onMouseDown={(e) => onTrimPointerDown(e, clip, 'start')} />}
        {clip.transitionIn && track.type === 'video' && (
          <span style={{ position: 'absolute', left: 0, top: 0, fontSize: 9, opacity: 0.8 }}>⤬</span>
        )}
        <span>{label}</span>
        {track.type !== 'audio' && <div className="trim-handle right" onMouseDown={(e) => onTrimPointerDown(e, clip, 'end')} />}
      </div>
    )
  }

  const ticks: number[] = []
  const tickStep = pxPerSecond < 40 ? 5 : pxPerSecond < 100 ? 2 : 1
  for (let s = 0; s <= duration + tickStep; s += tickStep) ticks.push(s)

  return (
    <div className="timeline-wrap">
      <div className="timeline-toolbar">
        <span style={{ color: 'var(--text-dim)' }}>Zoom</span>
        <input
          type="range"
          min={10}
          max={300}
          value={pxPerSecond}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <span style={{ color: 'var(--text-dim)' }}>{playhead.toFixed(2)}s / {duration.toFixed(1)}s</span>
      </div>
      <div className="timeline-body" ref={bodyRef} style={{ width: totalWidth }}>
        <div className="ruler" onClick={onRulerClick}>
          {ticks.map((s) => (
            <div key={s} className="ruler-tick" style={{ left: LABEL_WIDTH + s * pxPerSecond }}>
              {s}s
            </div>
          ))}
        </div>
        {project.tracks.map((track) => (
          <div
            className={`track-row ${dropTrackId === track.id ? 'drop-active' : ''}`}
            key={track.id}
            onDragOver={(e) => onLaneDragOver(e, track)}
            onDragLeave={onLaneDragLeave}
            onDrop={(e) => void onLaneDrop(e, track)}
          >
            <div className="track-label">{track.name}</div>
            <div
              className="track-lane"
              ref={(el) => {
                if (el) trackRowRefs.current.set(track.id, el)
              }}
              style={{ width: totalWidth - LABEL_WIDTH }}
              onMouseDown={() => selectClip(null)}
            >
              {track.clips.map((clip) => renderClip(clip, track))}
            </div>
          </div>
        ))}
        <div className="playhead" style={{ left: LABEL_WIDTH + playhead * pxPerSecond }}>
          <div className="playhead-handle" />
        </div>
      </div>
    </div>
  )
}
