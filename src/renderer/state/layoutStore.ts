import { create } from 'zustand'

const STORAGE_KEY = 'freecut.layout'

/** CapCut-style timeline row density: short (name-only bar), default (current look), tall. */
export type TrackHeightMode = 'short' | 'default' | 'tall'

interface LayoutPrefs {
  mediaBinWidth: number
  inspectorWidth: number
  timelineHeight: number
  trackHeight: TrackHeightMode
}

const DEFAULTS: LayoutPrefs = { mediaBinWidth: 220, inspectorWidth: 280, timelineHeight: 260, trackHeight: 'default' }

// Panels can be dragged well below their default size, but never past the point where they'd
// become unusable (or, for the timeline, disappear entirely — the bug this was built to fix).
const MIN = { mediaBinWidth: 120, inspectorWidth: 200, timelineHeight: 120 }
const MAX = { mediaBinWidth: 480, inspectorWidth: 560, timelineHeight: 720 }

/** Pixel heights per track-height mode, consumed by the Timeline (row height + clip decorations). */
export const TRACK_HEIGHTS: Record<TrackHeightMode, number> = { short: 30, default: 92, tall: 132 }

function load(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

function persist(prefs: LayoutPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage unavailable (e.g. private mode) — layout just won't persist across launches.
  }
}

function clampNum(value: number, key: 'mediaBinWidth' | 'inspectorWidth' | 'timelineHeight'): number {
  return Math.min(Math.max(value, MIN[key]), MAX[key])
}

interface LayoutState extends LayoutPrefs {
  setMediaBinWidth: (w: number) => void
  setInspectorWidth: (w: number) => void
  setTimelineHeight: (h: number) => void
  setTrackHeight: (mode: TrackHeightMode) => void
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  ...load(),
  setMediaBinWidth: (w) =>
    set(() => {
      const next = { ...pick(get()), mediaBinWidth: clampNum(w, 'mediaBinWidth') }
      persist(next)
      return next
    }),
  setInspectorWidth: (w) =>
    set(() => {
      const next = { ...pick(get()), inspectorWidth: clampNum(w, 'inspectorWidth') }
      persist(next)
      return next
    }),
  setTimelineHeight: (h) =>
    set(() => {
      const next = { ...pick(get()), timelineHeight: clampNum(h, 'timelineHeight') }
      persist(next)
      return next
    }),
  setTrackHeight: (mode) =>
    set(() => {
      const next = { ...pick(get()), trackHeight: mode }
      persist(next)
      return next
    })
}))

function pick(s: LayoutState): LayoutPrefs {
  return {
    mediaBinWidth: s.mediaBinWidth,
    inspectorWidth: s.inspectorWidth,
    timelineHeight: s.timelineHeight,
    trackHeight: s.trackHeight
  }
}
