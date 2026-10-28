import { create } from 'zustand'

const STORAGE_KEY = 'freecut.layout'

interface LayoutPrefs {
  mediaBinWidth: number
  inspectorWidth: number
  timelineHeight: number
}

const DEFAULTS: LayoutPrefs = { mediaBinWidth: 220, inspectorWidth: 280, timelineHeight: 260 }

// Panels can be dragged well below their default size, but never past the point where they'd
// become unusable (or, for the timeline, disappear entirely — the bug this was built to fix).
const MIN = { mediaBinWidth: 120, inspectorWidth: 200, timelineHeight: 120 }
const MAX = { mediaBinWidth: 480, inspectorWidth: 560, timelineHeight: 720 }

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

function clamp(value: number, key: keyof LayoutPrefs): number {
  return Math.min(Math.max(value, MIN[key]), MAX[key])
}

interface LayoutState extends LayoutPrefs {
  setMediaBinWidth: (w: number) => void
  setInspectorWidth: (w: number) => void
  setTimelineHeight: (h: number) => void
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  ...load(),
  setMediaBinWidth: (w) =>
    set(() => {
      const next = { ...pick(get()), mediaBinWidth: clamp(w, 'mediaBinWidth') }
      persist(next)
      return next
    }),
  setInspectorWidth: (w) =>
    set(() => {
      const next = { ...pick(get()), inspectorWidth: clamp(w, 'inspectorWidth') }
      persist(next)
      return next
    }),
  setTimelineHeight: (h) =>
    set(() => {
      const next = { ...pick(get()), timelineHeight: clamp(h, 'timelineHeight') }
      persist(next)
      return next
    })
}))

function pick(s: LayoutState): LayoutPrefs {
  return { mediaBinWidth: s.mediaBinWidth, inspectorWidth: s.inspectorWidth, timelineHeight: s.timelineHeight }
}
