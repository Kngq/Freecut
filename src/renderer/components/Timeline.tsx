import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../state/projectStore'
import { useLayoutStore, TRACK_HEIGHTS, type TrackHeightMode } from '../state/layoutStore'
import { formatMMSS, projectDuration, type Clip, type MediaAsset, type ThumbnailCover, type Track } from '@shared/types'
import { ASSET_DRAG_MIME, assetsFromPaths, droppedFilePaths, isMediaDrag } from '../media'

/** Width of the sticky track label column; lanes and the ruler's 0s mark start after it. */
const LABEL_WIDTH = 90

/** Clip decoration heights (default mode baseline; scaled per track-height mode in the component). */
const TRACK_VIDEO_WAVE_HEIGHT = 24 // waveform strip under a video clip's thumbnails
const TRACK_AUDIO_WAVE_HEIGHT = 56 // taller waveform for a standalone audio clip

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

/** Formats seconds as HH:MM:SS:FF (frames at 30fps), the CapCut-style clip duration readout. */
function formatTimecode(seconds: number, fps = 30): string {
  const total = Math.max(0, seconds)
  const whole = Math.floor(total)
  const frames = Math.round((total - whole) * fps) % fps
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(frames)}`
}

/** Draws a clip's audio waveform as a symmetric bar graph on a canvas. VIRTUALIZED: the canvas
 *  only spans the visible slice of the clip ([visibleStart, visibleEnd) in clip-local px), so a
 *  clip that's hundreds of thousands of px wide at high zoom never exceeds the browser's max
 *  canvas size (which would blank it). Peak sampling still maps against the FULL clip width so
 *  the waveform is positionally correct. Redraws on any size/scroll/peak/trim change. */
function WaveformCanvas({
  peaks,
  fullWidth,
  height,
  startFrac,
  endFrac,
  visibleStart,
  visibleEnd
}: {
  peaks: number[]
  fullWidth: number
  height: number
  startFrac: number
  endFrac: number
  visibleStart: number
  visibleEnd: number
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const segLeft = Math.max(0, Math.floor(visibleStart))
  const segWidth = Math.max(1, Math.ceil(visibleEnd) - segLeft)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, segWidth)
    const h = Math.max(1, Math.floor(height))
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (peaks.length === 0 || w < 2 || fullWidth < 2) return

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    const mid = h / 2
    const span = Math.max(1e-6, endFrac - startFrac)
    // Each local column x maps to an absolute clip-local pixel (segLeft + x), then to a source
    // fraction across the full clip width, then to a peak bucket.
    for (let x = 0; x < w; x++) {
      const frac = startFrac + ((segLeft + x) / fullWidth) * span
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)))
      const amp = peaks[idx]
      const barH = Math.max(1, amp * (h - 2))
      ctx.fillRect(x, mid - barH / 2, 1, barH)
    }
  }, [peaks, fullWidth, height, startFrac, endFrac, segLeft, segWidth])

  return <canvas ref={ref} className="clip-waveform" style={{ left: segLeft, width: segWidth, height }} />
}

/** A filmstrip of thumbnail frames sliced from an asset's sprite sheet, tiled edge-to-edge (no
 *  gaps) across the clip. VIRTUALIZED: only the tiles overlapping the visible scroll window are
 *  rendered, so an extremely wide clip (high zoom) stays cheap and never hits the browser's
 *  wide-element paint limit. Each tile shows a distinct frame chosen by its position within the
 *  clip's trimmed source window, so zooming in reveals more frames. */
function FilmstripTiles({
  cover,
  width,
  height,
  startFrac,
  endFrac,
  visibleStart,
  visibleEnd
}: {
  cover: ThumbnailCover
  width: number
  height: number
  startFrac: number
  endFrac: number
  /** Visible x-range within the clip (clip-local px, already clamped to [0, width]). */
  visibleStart: number
  visibleEnd: number
}) {
  const url = window.api.fileUrl(cover.path)
  const frames = Math.max(1, cover.frames)
  const aspect = cover.frameWidth > 0 && cover.frameHeight > 0 ? cover.frameWidth / cover.frameHeight : 16 / 9
  const tileW = Math.max(16, Math.round(height * aspect))
  const tileCount = Math.max(1, Math.ceil(width / tileW))
  const span = Math.max(1e-6, endFrac - startFrac)

  // Only emit tiles whose [x, x+tileW) intersects the visible window.
  const firstTile = Math.max(0, Math.floor(visibleStart / tileW))
  const lastTile = Math.min(tileCount - 1, Math.ceil(visibleEnd / tileW))

  const tiles = []
  for (let i = firstTile; i <= lastTile; i++) {
    const frac = startFrac + ((i + 0.5) / tileCount) * span
    const frameIdx = Math.min(frames - 1, Math.max(0, Math.floor(frac * frames)))
    tiles.push(
      <div
        key={i}
        className="clip-tile"
        style={{
          left: i * tileW,
          width: tileW,
          backgroundImage: `url(${url})`,
          backgroundSize: `${frames * tileW}px 100%`,
          backgroundPosition: `${-frameIdx * tileW}px center`,
          backgroundRepeat: 'no-repeat'
        }}
      />
    )
  }
  return (
    <div className="clip-filmstrip" style={{ height }}>
      {tiles}
    </div>
  )
}

/** Thin SVG wrapper matching the media-bin tab icons (same stroke style as CapCut's toolbar). */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
      {children}
    </svg>
  )
}

// CapCut-style glyphs, kept minimal and recognizable at 18px.
const IconUndo = (
  <Icon>
    <path d="M9 7H16a4 4 0 0 1 0 8h-3" />
    <path d="M9 7 5.5 10.5 9 14" />
  </Icon>
)
const IconRedo = (
  <Icon>
    <path d="M15 7H8a4 4 0 0 0 0 8h3" />
    <path d="M15 7l3.5 3.5L15 14" />
  </Icon>
)
const IconSplit = (
  <Icon>
    <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2.5" />
    <path d="M7 6v12M7 6l-2 2M7 6l2 2" />
    <path d="M17 6v12M17 18l-2-2M17 18l2-2" />
  </Icon>
)
const IconDelete = (
  <Icon>
    <path d="M5 7h14" />
    <path d="M9 7V5h6v2" />
    <path d="M7 7l1 13h8l1-13" />
  </Icon>
)
const IconMirror = (
  <Icon>
    <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2 2.5" />
    <path d="M9 7l-4 5 4 5z" />
    <path d="M15 7l4 5-4 5z" />
  </Icon>
)
const IconRotate = (
  <Icon>
    <path d="M4 12a8 8 0 1 1 2.3 5.6" />
    <path d="M4 20v-4h4" />
  </Icon>
)
const IconAddVideo = (
  <Icon>
    <rect x="3" y="6" width="12" height="12" rx="2" />
    <path d="M19 9v6" />
    <path d="M16 12h6" />
  </Icon>
)
const IconAddAudio = (
  <Icon>
    <path d="M4 10v4" />
    <path d="M8 7v10" />
    <path d="M12 9v6" />
    <path d="M19 9v6" />
    <path d="M16 12h6" />
  </Icon>
)

interface ToolButtonProps {
  icon: React.ReactNode
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

/** One CapCut-style icon button with a hover tooltip showing the action name and its shortcut
 *  (e.g. "Undo (⌘Z)"), matching the reference screenshot. Icon-only; the label lives in the
 *  tooltip and the title attribute (for accessibility). */
function ToolButton({ icon, label, shortcut, active, disabled, onClick }: ToolButtonProps) {
  return (
    <button
      className={`tl-tool ${active ? 'active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {icon}
      <span className="tl-tooltip">
        {label}
        {shortcut ? ` (${shortcut})` : ''}
      </span>
    </button>
  )
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
  const addTrack = useProjectStore((s) => s.addTrack)
  const splitClipAtPlayhead = useProjectStore((s) => s.splitClipAtPlayhead)
  const removeClip = useProjectStore((s) => s.removeClip)
  const rotateClip = useProjectStore((s) => s.rotateClip)
  const toggleClipFlipH = useProjectStore((s) => s.toggleClipFlipH)
  const undo = useProjectStore((s) => s.undo)
  const trackHeightMode = useLayoutStore((s) => s.trackHeight)
  const setTrackHeight = useLayoutStore((s) => s.setTrackHeight)
  const rowHeight = TRACK_HEIGHTS[trackHeightMode]
  // Short mode shows only the name bar (no filmstrip/waveform); default/tall scale the
  // decoration heights to fill the taller row.
  const showDecorations = trackHeightMode !== 'short'
  const coverRowHeight = trackHeightMode === 'tall' ? 96 : 60
  const videoWaveHeight = trackHeightMode === 'tall' ? 30 : TRACK_VIDEO_WAVE_HEIGHT
  const audioWaveHeight = trackHeightMode === 'tall' ? Math.round(rowHeight * 0.7) : TRACK_AUDIO_WAVE_HEIGHT
  const redo = useProjectStore((s) => s.redo)
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const trackRowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [trim, setTrim] = useState<TrimState | null>(null)
  const [dropTrackId, setDropTrackId] = useState<string | null>(null)
  // Available width of the scroll container, tracked so the timeline can stretch to fill it
  // when the content is shorter than the panel (and still scroll when it's longer).
  const [wrapWidth, setWrapWidth] = useState(0)
  // Horizontal scroll offset of the timeline, tracked so clip decorations (filmstrip, waveform)
  // can render only the slice that's actually on screen — essential at high zoom, where a clip
  // can be hundreds of thousands of pixels wide (a single canvas/background that large fails to
  // paint, and one tile per frame would be tens of thousands of DOM nodes).
  const [scrollLeft, setScrollLeft] = useState(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      setWrapWidth(el.clientWidth)
      setScrollLeft(el.scrollLeft)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [])

  const duration = useMemo(() => Math.max(projectDuration(project), 10), [project])
  const contentWidth = duration * pxPerSecond + 200
  // Stretch to the full panel width when the content doesn't already overflow it.
  const totalWidth = Math.max(contentWidth, wrapWidth)

  // Minimum zoom: the whole project must always occupy at least half the visible timeline,
  // regardless of its length. laneWidth is the pixels available after the sticky label column;
  // half of that divided by the duration gives the px/second floor. Falls back to the store's
  // own floor (10) until the container has been measured.
  const laneWidth = Math.max(0, wrapWidth - LABEL_WIDTH)
  const minPxPerSecond = laneWidth > 0 ? Math.max(1, (laneWidth / 2) / duration) : 10
  const maxPxPerSecond = 400

  // Keep the current zoom at or above the dynamic floor (e.g. after a longer clip is added, or
  // the panel is resized smaller). Only pushes up, never fights a user zooming in.
  useEffect(() => {
    if (pxPerSecond < minPxPerSecond) setZoom(minPxPerSecond)
  }, [minPxPerSecond, pxPerSecond, setZoom])

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

  /** Press-and-drag on the ruler scrubs the playhead: it jumps to the pointer on mousedown and
   *  then follows the cursor until release (a plain click is just the degenerate zero-move case). */
  function onRulerPointerDown(e: React.MouseEvent) {
    e.preventDefault()
    setPlayhead(timeAt(e.clientX))

    function onMove(ev: MouseEvent) {
      setPlayhead(timeAt(ev.clientX))
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
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

    const asset = clip.kind === 'media' ? project.assets.find((a) => a.id === clip.assetId) : undefined
    const name = clip.kind === 'text' ? clip.text : asset?.name ?? track.name
    const headerLabel = clip.kind === 'text' ? clip.text : `${name}  ${formatTimecode(clip.duration)}`

    // The portion of the source this clip shows, as fractions of the full source duration —
    // used to crop the waveform to the trimmed window so it tracks trimming.
    let startFrac = 0
    let endFrac = 1
    if (clip.kind === 'media' && asset && asset.duration > 0) {
      startFrac = Math.min(1, Math.max(0, clip.trimIn / asset.duration))
      endFrac = Math.min(1, Math.max(startFrac + 1e-4, clip.trimOut / asset.duration))
    }

    // A filmstrip of distinct frames sliced from the asset's sprite sheet, tiled edge-to-edge
    // (no gaps) across the clip. Rendered as discrete tiles so it scales to any zoom without the
    // wide-background painting failure, and shows more frames the further you zoom in.
    const hasCover = showDecorations && clip.kind === 'media' && track.type !== 'audio' && !!asset?.cover
    const hasWaveform = showDecorations && clip.kind === 'media' && !!asset?.waveform && asset.waveform.peaks.length > 0
    const coverHeight = track.type === 'audio' ? 0 : coverRowHeight

    // Visible slice of this clip in clip-local px (what overlaps the scrolled viewport). Both the
    // filmstrip and waveform render only this slice, so an enormous clip at high zoom stays cheap
    // and never overflows a canvas/element size limit. A small margin pre-renders just offscreen.
    const VIRT_MARGIN = 256
    const clipBodyLeft = LABEL_WIDTH + left
    const visibleStart = Math.max(0, Math.min(width, scrollLeft - clipBodyLeft - VIRT_MARGIN))
    const visibleEnd = Math.max(0, Math.min(width, scrollLeft + wrapWidth - clipBodyLeft + VIRT_MARGIN))
    const anyVisible = visibleEnd > visibleStart

    return (
      <div
        key={clip.id}
        className={`clip ${clipClassName(clip, track)} ${hasCover ? 'has-cover' : ''} ${selectedClipId === clip.id ? 'selected' : ''}`}
        style={{ left, width, zIndex: isDraggingThis ? 10 : 1 }}
        onMouseDown={(e) => onClipPointerDown(e, clip, track)}
        title={clip.kind === 'text' ? clip.text : `${name} · ${clip.duration.toFixed(1)}s`}
      >
        {hasCover && anyVisible && (
          <FilmstripTiles
            cover={asset!.cover!}
            width={width}
            height={coverHeight}
            startFrac={startFrac}
            endFrac={endFrac}
            visibleStart={visibleStart}
            visibleEnd={visibleEnd}
          />
        )}
        <div className="clip-header">
          {clip.transitionIn && track.type === 'video' && <span className="clip-transition-badge">⤬</span>}
          <span className="clip-title">{headerLabel}</span>
        </div>
        {hasWaveform && anyVisible && (
          <WaveformCanvas
            peaks={asset!.waveform!.peaks}
            fullWidth={width}
            height={track.type === 'audio' ? audioWaveHeight : videoWaveHeight}
            startFrac={startFrac}
            endFrac={endFrac}
            visibleStart={visibleStart}
            visibleEnd={visibleEnd}
          />
        )}
        {track.type !== 'audio' && <div className="trim-handle left" onMouseDown={(e) => onTrimPointerDown(e, clip, 'start')} />}
        {track.type !== 'audio' && <div className="trim-handle right" onMouseDown={(e) => onTrimPointerDown(e, clip, 'end')} />}
      </div>
    )
  }

  // Adaptive ruler ticks. Pick the smallest "nice" step (in seconds) that keeps tick labels at
  // least MIN_TICK_PX apart at the current zoom, choosing from a ladder that runs from sub-second
  // all the way up to whole minutes.
  const MIN_TICK_PX = 64
  const STEP_LADDER = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const tickStep = STEP_LADDER.find((step) => step * pxPerSecond >= MIN_TICK_PX) ?? STEP_LADDER[STEP_LADDER.length - 1]
  // Minor subdivisions between labeled (major) ticks — classic ruler look: a few short unlabeled
  // marks per labeled interval. Kept to a count that divides the step evenly where possible.
  const MINOR_PER_MAJOR = tickStep % 5 === 0 ? 5 : tickStep % 4 === 0 ? 4 : tickStep % 2 === 0 ? 2 : tickStep % 3 === 0 ? 3 : 1
  const minorStep = tickStep / MINOR_PER_MAJOR
  const marks: { t: number; major: boolean }[] = []
  for (let s = 0; s <= duration + tickStep; s += minorStep) {
    // A mark is "major" (labeled, taller) when it lands on a multiple of the major step.
    const major = Math.abs((s / tickStep) - Math.round(s / tickStep)) < 1e-6
    marks.push({ t: Math.round(s * 1000) / 1000, major })
  }

  /** Ruler tick label — always zero-padded MM:SS, matching the position/duration readout. */
  function tickLabel(seconds: number): string {
    return formatMMSS(seconds)
  }

  return (
    <div className="timeline-wrap" ref={wrapRef}>
      <div className="timeline-toolbar">
        <div className="tl-tools">
          <ToolButton icon={IconUndo} label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={undo} />
          <ToolButton icon={IconRedo} label="Redo" shortcut="⌘⇧Z" disabled={!canRedo} onClick={redo} />
          <span className="tl-sep" />
          <ToolButton icon={IconSplit} label="Split" shortcut="⌘B" disabled={!selectedClipId} onClick={splitClipAtPlayhead} />
          <ToolButton icon={IconDelete} label="Delete" shortcut="⌫" disabled={!selectedClipId} onClick={() => selectedClipId && removeClip(selectedClipId)} />
          <span className="tl-sep" />
          <ToolButton icon={IconMirror} label="Mirror" shortcut="⌘M" disabled={!selectedClipId} onClick={() => selectedClipId && toggleClipFlipH(selectedClipId)} />
          <ToolButton icon={IconRotate} label="Flip" shortcut="⌘⇧F" disabled={!selectedClipId} onClick={() => selectedClipId && rotateClip(selectedClipId, 90)} />
          <span className="tl-sep" />
          <ToolButton icon={IconAddVideo} label="Add video track" onClick={() => addTrack('video')} />
          <ToolButton icon={IconAddAudio} label="Add audio track" onClick={() => addTrack('audio')} />
        </div>
        <span className="tl-spacer" />
        <span style={{ color: 'var(--text-dim)' }}>Zoom</span>
        <input
          type="range"
          min={minPxPerSecond}
          max={maxPxPerSecond}
          step="any"
          value={pxPerSecond}
          onChange={(e) => setZoom(Math.max(minPxPerSecond, Number(e.target.value)))}
        />
        <span className="tl-sep" />
        <div className="tl-rowheight" title="Track row height">
          {(['short', 'default', 'tall'] as TrackHeightMode[]).map((mode) => (
            <button
              key={mode}
              className={`tl-rowheight-btn ${trackHeightMode === mode ? 'active' : ''}`}
              onClick={() => setTrackHeight(mode)}
              title={`${mode[0].toUpperCase()}${mode.slice(1)} rows`}
            >
              {mode === 'short' ? '▬' : mode === 'default' ? '▭' : '▢'}
            </button>
          ))}
        </div>
      </div>
      <div className="timeline-body" ref={bodyRef} style={{ width: totalWidth }}>
        <div className="ruler" onMouseDown={onRulerPointerDown}>
          {marks.map(({ t, major }) => (
            <div
              key={t}
              className={`ruler-mark ${major ? 'major' : 'minor'}`}
              style={{ left: LABEL_WIDTH + t * pxPerSecond }}
            >
              {major && <span className="ruler-label">{tickLabel(t)}</span>}
            </div>
          ))}
        </div>
        {project.tracks.map((track) => (
          <div
            className={`track-row th-${trackHeightMode} ${dropTrackId === track.id ? 'drop-active' : ''}`}
            key={track.id}
            style={{ height: rowHeight }}
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
