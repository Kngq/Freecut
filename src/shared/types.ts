export type MediaKind = 'video' | 'audio' | 'image'

export interface ThumbnailCover {
  /** Absolute path to a thumbnail sprite: FRAMES distinct frames sampled across the source and
   *  laid out left-to-right in one image (or the image file itself for image assets, frames=1).
   *  Generated locally with ffmpeg. The renderer tiles/slices these across a timeline clip. */
  path: string
  /** Number of distinct frames in the sprite (1 for images). */
  frames: number
  /** Pixel width and height of one frame within the sprite. */
  frameWidth: number
  frameHeight: number
}

export interface Waveform {
  /** Normalized peak magnitudes in 0..1, evenly spaced across the source duration. */
  peaks: number[]
}

export interface MediaAsset {
  id: string
  path: string
  kind: MediaKind
  name: string
  duration: number // seconds, source duration (0 for images)
  width?: number
  height?: number
  hasAudio: boolean
  /** A browser-playable transcode of `path`, used only for live preview when the source codec
   *  (e.g. ProRes) can't be decoded by Chromium's <video>/<audio> even though ffmpeg can.
   *  Export always reads `path` directly, never this. */
  previewPath?: string
  /** Cover image for the timeline clip — the video's first frame, or the image itself for image
   *  assets. Absent for audio or if generation failed; the clip then falls back to a flat color. */
  cover?: ThumbnailCover
  /** Normalized audio peaks for the timeline waveform (sources with audio only). */
  waveform?: Waveform
}

/**
 * Transition between two adjacent primary-track clips. CapCut treats every transition as an
 * overlap of the outgoing and incoming clip over a normalized 0..1 progress (catalog type 19,
 * `sdk_extra.transition = {isOverlap:true}`) — see docs/capcut-effects-reimplementation.md.
 * freecut models that overlap the same way the original crossfade did (pull the incoming clip's
 * start back by the transition duration, mirrored in both preview and the ffmpeg `xfade`
 * offset math). Each type here maps to an ffmpeg `xfade=transition=<name>` on export and to a
 * best-effort Canvas-2D approximation in the live preview.
 *
 * `crossfade`/`dipToBlack` are kept as-is for backward compatibility with existing `.fcproj`
 * files (crossfade === fade, dipToBlack === fadeblack).
 */
export type TransitionType =
  | 'crossfade' // plain cross dissolve (ffmpeg xfade=fade)
  | 'dipToBlack' // fade through black (xfade=fadeblack)
  | 'dipToWhite' // fade through white (xfade=fadewhite)
  | 'dissolve' // grainy pixel dissolve (xfade=dissolve)
  | 'slideLeft' // push: new clip enters from the right, old exits left (xfade=slideleft)
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'wipeLeft' // hard wipe boundary sweeping across (xfade=wipeleft)
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'zoomIn' // CapCut "Zoom" transition, approximated (xfade=zoomin)
  | 'circleOpen' // iris (xfade=circleopen)
  | 'circleClose'

export interface Transition {
  type: TransitionType
  duration: number // seconds, overlaps the end of the previous clip with the start of this clip
}

/** Ordered catalog of selectable transition types with human-readable labels, for the
 *  Inspector's dropdown. Order roughly follows docs/capcut-effects-reimplementation.md. */
export const TRANSITION_CATALOG: { type: TransitionType; label: string }[] = [
  { type: 'crossfade', label: 'Cross dissolve' },
  { type: 'dipToBlack', label: 'Fade to black' },
  { type: 'dipToWhite', label: 'Fade to white' },
  { type: 'dissolve', label: 'Dissolve (grainy)' },
  { type: 'slideLeft', label: 'Slide left' },
  { type: 'slideRight', label: 'Slide right' },
  { type: 'slideUp', label: 'Slide up' },
  { type: 'slideDown', label: 'Slide down' },
  { type: 'wipeLeft', label: 'Wipe left' },
  { type: 'wipeRight', label: 'Wipe right' },
  { type: 'wipeUp', label: 'Wipe up' },
  { type: 'wipeDown', label: 'Wipe down' },
  { type: 'zoomIn', label: 'Zoom' },
  { type: 'circleOpen', label: 'Circle open' },
  { type: 'circleClose', label: 'Circle close' }
]

/** Selectable text fonts. `family` is the CSS/canvas font-family used in the live preview;
 *  `fontFile` is an absolute font path ffmpeg's drawtext uses on export (macOS system fonts,
 *  which are present on every Mac). Keeping both in one catalog means preview and export agree.
 *  The default (first entry) matches the previous hardcoded sans-serif look. */
export interface FontCatalogEntry {
  /** Stable key stored on the clip (TextClip.fontFamily). */
  id: string
  label: string
  /** CSS font-family stack for the preview canvas. */
  family: string
  /** Absolute font file for ffmpeg drawtext on export (best-effort; macOS paths). */
  fontFile: string
}

export const FONT_CATALOG: FontCatalogEntry[] = [
  { id: 'sans', label: 'Sans (Helvetica)', family: 'Helvetica, Arial, sans-serif', fontFile: '/System/Library/Fonts/Helvetica.ttc' },
  { id: 'arial', label: 'Arial', family: 'Arial, Helvetica, sans-serif', fontFile: '/Library/Fonts/Arial.ttf' },
  { id: 'avenir', label: 'Avenir Next', family: '"Avenir Next", Avenir, sans-serif', fontFile: '/System/Library/Fonts/Avenir Next.ttc' },
  { id: 'georgia', label: 'Georgia (serif)', family: 'Georgia, "Times New Roman", serif', fontFile: '/System/Library/Fonts/Supplemental/Georgia.ttf' },
  { id: 'times', label: 'Times New Roman', family: '"Times New Roman", Times, serif', fontFile: '/System/Library/Fonts/Supplemental/Times New Roman.ttf' },
  { id: 'courier', label: 'Courier (mono)', family: '"Courier New", Courier, monospace', fontFile: '/System/Library/Fonts/Supplemental/Courier New.ttf' },
  { id: 'menlo', label: 'Menlo (mono)', family: 'Menlo, Monaco, monospace', fontFile: '/System/Library/Fonts/Menlo.ttc' },
  { id: 'impact', label: 'Impact', family: 'Impact, "Arial Black", sans-serif', fontFile: '/System/Library/Fonts/Supplemental/Impact.ttf' },
  { id: 'markerfelt', label: 'Marker Felt', family: '"Marker Felt", fantasy', fontFile: '/System/Library/Fonts/Supplemental/MarkerFelt.ttc' },
  { id: 'chalkboard', label: 'Chalkboard', family: '"Chalkboard SE", "Comic Sans MS", cursive', fontFile: '/System/Library/Fonts/Supplemental/Chalkboard.ttc' }
]

export function fontCatalogEntry(id: string | undefined): FontCatalogEntry {
  return FONT_CATALOG.find((f) => f.id === id) ?? FONT_CATALOG[0]
}

/** Output canvas aspect-ratio presets. Width/height are the export resolution; the preview
 *  canvas and ffmpeg both read project.canvas, so switching here changes both. */
export interface AspectPreset {
  id: string
  label: string
  width: number
  height: number
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { id: 'portrait', label: '9:16 Portrait', width: 1080, height: 1920 },
  { id: 'landscape', label: '16:9 Landscape', width: 1920, height: 1080 },
  { id: 'square', label: '1:1 Square', width: 1080, height: 1080 },
  { id: 'classic', label: '4:3 Classic', width: 1440, height: 1080 },
  { id: 'cinema', label: '21:9 Cinema', width: 2560, height: 1080 }
]

/** Finds the preset matching a canvas's exact resolution, or null for a custom size. */
export function aspectPresetFor(width: number, height: number): AspectPreset | null {
  return ASPECT_PRESETS.find((p) => p.width === width && p.height === height) ?? null
}

export interface TransformKeyframe {
  time: number // clip-local timeline seconds, 0..effective clip duration
  x: number
  y: number
  scale: number
  opacity: number
}

/** Position/scale/opacity for a clip. Static unless `keyframes` has >=2 points, in which case
 *  the static x/y/scale/opacity are ignored and interpolateTransform() drives the value instead.
 *  `rotation` (degrees, clockwise) and `flipH` (horizontal mirror) are always static — they're
 *  driven by the timeline toolbar's rotate/mirror buttons, not keyframed in v1. Both are
 *  optional so pre-existing `.fcproj` files (and the keyframe interpolation result) round-trip
 *  without them. */
export interface ClipTransform {
  x: number // 0-1, relative to canvas width, anchor center
  y: number // 0-1, relative to canvas height, anchor center
  scale: number // 1 = 100%
  opacity: number // 0-1
  rotation?: number // degrees clockwise, default 0
  flipH?: boolean // horizontal mirror, default false
  keyframes?: TransformKeyframe[]
}

export function defaultTransform(): ClipTransform {
  return { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0, flipH: false }
}

/** Linearly interpolates a transform's value at a clip-local time. Falls back to the static
 *  x/y/scale/opacity when there are no keyframes (or only one). */
export function interpolateTransform(
  transform: ClipTransform,
  localT: number
): { x: number; y: number; scale: number; opacity: number } {
  const kfs = transform.keyframes
  if (!kfs || kfs.length < 2) return { x: transform.x, y: transform.y, scale: transform.scale, opacity: transform.opacity }
  const sorted = [...kfs].sort((a, b) => a.time - b.time)
  if (localT <= sorted[0].time) return pickTransform(sorted[0])
  const last = sorted[sorted.length - 1]
  if (localT >= last.time) return pickTransform(last)
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (localT >= a.time && localT <= b.time) {
      const p = b.time === a.time ? 0 : (localT - a.time) / (b.time - a.time)
      return {
        x: a.x + (b.x - a.x) * p,
        y: a.y + (b.y - a.y) * p,
        scale: a.scale + (b.scale - a.scale) * p,
        opacity: a.opacity + (b.opacity - a.opacity) * p
      }
    }
  }
  return pickTransform(last)
}

function pickTransform(k: TransformKeyframe) {
  return { x: k.x, y: k.y, scale: k.scale, opacity: k.opacity }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Clip effects
 *
 * A single-clip, per-frame visual effect, applied in the preview (Canvas 2D) and on export
 * (an ffmpeg filter chain) — see docs/capcut-effects-reimplementation.md "Effects (applied to
 * a single clip)". CapCut's effects are AE-style layer stacks driven by cubic-bezier curves;
 * freecut reimplements the cheap ones that have faithful Canvas-2D + ffmpeg equivalents.
 *
 * Each effect is `{ type, params }` where `params` is a flat bag of numbers in documented
 * ranges (mostly 0..1, matching CapCut's `effects_adjust_*`). The authoritative default params,
 * ranges and labels live in EFFECT_CATALOG so the data model, the Inspector UI, the preview and
 * the exporter all agree. The actual rendering math lives in shared/effects.ts (pure functions)
 * so it stays unit-testable and shared between preview and export.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ClipEffectType =
  | 'kenBurns' // slow zoom/pan (CapCut "Zoom"/Ken Burns), effect #1
  | 'shake' // seeded camera shake (LumiSShake), effect #2
  | 'blur' // gaussian blur, effect #5
  | 'vignette' // darkened edges, effect #8
  | 'grain' // old-film grain + optional desaturation, effect #9
  | 'blackWhite' // desaturate to B&W
  | 'flash' // exposure strobe/flash, effect #4
  | 'mirror' // horizontal mirror fold, effect #12 (simple mirror)

export interface ClipEffect {
  /** Stable id so the Inspector can key/patch/remove a specific instance. */
  id: string
  type: ClipEffectType
  /** Flat numeric parameter bag; valid keys per type are documented in EFFECT_CATALOG. */
  params: Record<string, number>
}

export interface EffectParamSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

export interface EffectCatalogEntry {
  type: ClipEffectType
  label: string
  params: EffectParamSpec[]
}

/** Authoritative metadata for every effect: label + its tunable params (ranges/defaults).
 *  Parameter semantics (how each maps to a Canvas-2D op and an ffmpeg filter) are implemented
 *  in shared/effects.ts. Ranges follow CapCut's 0..1 `effects_adjust_*` convention where it
 *  makes sense. */
export const EFFECT_CATALOG: EffectCatalogEntry[] = [
  {
    type: 'kenBurns',
    label: 'Zoom (Ken Burns)',
    params: [
      { key: 'intensity', label: 'Zoom amount', min: 0, max: 1, step: 0.01, default: 0.2 },
      // direction: 0 = zoom in, 1 = zoom out (treated as a toggle, kept numeric for a uniform param bag)
      { key: 'direction', label: 'Out (0=in,1=out)', min: 0, max: 1, step: 1, default: 0 }
    ]
  },
  {
    type: 'shake',
    label: 'Camera shake',
    params: [
      { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: 'speed', label: 'Speed', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'seed', label: 'Seed', min: 0, max: 99, step: 1, default: 7 }
    ]
  },
  {
    type: 'blur',
    label: 'Blur (gaussian)',
    params: [{ key: 'intensity', label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.3 }]
  },
  {
    type: 'vignette',
    label: 'Vignette',
    params: [{ key: 'intensity', label: 'Strength', min: 0, max: 1, step: 0.01, default: 0.5 }]
  },
  {
    type: 'grain',
    label: 'Old film / grain',
    params: [
      { key: 'intensity', label: 'Grain', min: 0, max: 1, step: 0.01, default: 0.3 },
      { key: 'desaturate', label: 'Desaturate', min: 0, max: 1, step: 0.01, default: 0.4 }
    ]
  },
  {
    type: 'blackWhite',
    label: 'Black & white',
    params: [{ key: 'intensity', label: 'Amount', min: 0, max: 1, step: 0.01, default: 1 }]
  },
  {
    type: 'flash',
    label: 'Flash / strobe',
    params: [
      { key: 'intensity', label: 'Strength', min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: 'speed', label: 'Rate (Hz)', min: 0.5, max: 12, step: 0.5, default: 4 }
    ]
  },
  {
    type: 'mirror',
    label: 'Mirror',
    params: [
      // 0 = mirror left half onto right, 1 = mirror right half onto left
      { key: 'side', label: 'Side (0=L,1=R)', min: 0, max: 1, step: 1, default: 0 }
    ]
  }
]

/** Looks up an effect's catalog entry by type. */
export function effectCatalogEntry(type: ClipEffectType): EffectCatalogEntry | undefined {
  return EFFECT_CATALOG.find((e) => e.type === type)
}

/** Builds a fresh effect instance with the catalog's default params. `id` is caller-supplied
 *  (uuid in the store; a fixed value in tests) so this stays pure/deterministic. */
export function createEffect(type: ClipEffectType, id: string): ClipEffect {
  const entry = effectCatalogEntry(type)
  const params: Record<string, number> = {}
  if (entry) for (const p of entry.params) params[p.key] = p.default
  return { id, type, params }
}

/** Reads an effect param with a catalog default fallback, so rendering code never has to
 *  guard against a missing/partial param bag. */
export function effectParam(effect: ClipEffect, key: string): number {
  const v = effect.params[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const entry = effectCatalogEntry(effect.type)
  return entry?.params.find((p) => p.key === key)?.default ?? 0
}

/**
 * Seeded camera-shake waveform, ported from CapCut's `LumiSShake`
 * (docs/capcut-effects-reimplementation.md transition #10 / effect #2): a base sine plus a
 * "random" wave that sums three sines at frequency ratios 2/3/5 with weights 0.5/0.32/0.18,
 * each phase-shifted by a function of the seed. Deterministic and cheap — no noise texture —
 * so the preview and the export produce the exact same displacement for a given (seed, t).
 *
 * Returns a normalized offset in roughly [-1, 1] for one axis; callers scale it by an
 * amplitude in pixels. `phase` separates the x and y axes (CapCut uses per-channel phases).
 *
 * @param t       time in seconds
 * @param seed    integer seed (stable across preview/export)
 * @param freq    base frequency in Hz
 * @param phase   phase offset (use 0 for x, ~1.7 for y to decorrelate the axes)
 */
export function shakeWave(t: number, seed: number, freq: number, phase: number): number {
  const s = seed % 97
  const base = Math.sin(Math.PI * 2 * t * freq + phase)
  const r1 = Math.sin(Math.PI * 2 * t * freq * 2 + phase + (s % 7))
  const r2 = Math.sin(Math.PI * 2 * t * freq * 3 + phase + (s % 11))
  const r3 = Math.sin(Math.PI * 2 * t * freq * 5 + phase + (s % 13))
  const random = r1 * 0.5 + r2 * 0.32 + r3 * 0.18
  // 60/40 blend of the base sine and the summed-sine "random" wave, kept within [-1,1].
  return base * 0.6 + random * 0.4
}

interface ClipBase {
  id: string
  trackId: string
  start: number // position on the timeline, seconds
  duration: number // visible length on the timeline, seconds
  /** Transition into this clip from the previous clip on the same track. */
  transitionIn?: Transition
  transform: ClipTransform
  /** Per-clip visual effects, applied in order (preview + export). Optional/absent means none;
   *  omitted entirely from serialized projects when empty, so old `.fcproj` files round-trip. */
  effects?: ClipEffect[]
}

/** A speed value that takes effect at a given SOURCE-relative time (within [trimIn, trimOut]).
 *  With >=2 points, this overrides the clip's flat `speed` and the clip becomes a piecewise-
 *  constant speed curve: each consecutive pair of keyframes defines one constant-speed segment
 *  (the earlier keyframe's speed holds until the next keyframe's source time). */
export interface SpeedKeyframe {
  time: number
  speed: number
}

export interface MediaClip extends ClipBase {
  kind: 'media'
  assetId: string
  trimIn: number // seconds into the source media
  trimOut: number // seconds into the source media
  volume: number // 0-1
  muted: boolean
  speed: number // constant-speed multiplier, default 1; ignored when speedKeyframes has >=2 points
  speedKeyframes?: SpeedKeyframe[]
  reversed: boolean // plays the (speed-adjusted) source range back to front
  /** Holds a single source frame (at trimIn) for `duration` seconds. When true, trimIn/trimOut
   *  stay pinned together and `duration` is an authored value, not derived from trim/speed. */
  frozen: boolean
}

export interface TextClip extends ClipBase {
  kind: 'text'
  text: string
  fontSize: number // px, relative to a 1080-tall canvas
  color: string
  bold: boolean
  /** CSS/ffmpeg font family name. Absent ⇒ default sans-serif (keeps old .fcproj files valid). */
  fontFamily?: string
}

export type Clip = MediaClip | TextClip

export type TrackType = 'video' | 'audio' | 'text'

export interface Track {
  id: string
  type: TrackType
  name: string
  clips: Clip[]
  muted: boolean
  hidden: boolean
}

export interface ProjectCanvas {
  width: number
  height: number
  fps: number
  /** Working color space label (informational; export is standard Rec.709/sRGB). Optional so
   *  old .fcproj files round-trip. */
  colorSpace?: string
}

export interface Project {
  id: string
  name: string
  canvas: ProjectCanvas
  tracks: Track[]
  assets: MediaAsset[]
  createdAt: number
  updatedAt: number
}

export const FILE_EXTENSION = '.fcproj'

/** Media file extensions freecut can import, by kind. The single source of truth shared by the
 *  main-process probe (what ffprobe is asked to read) and the renderer's import error messaging
 *  (so a rejection can say exactly which formats ARE supported). */
export const SUPPORTED_EXTENSIONS = {
  video: ['.mp4', '.mov', '.mkv', '.webm', '.avi'],
  audio: ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif']
} as const

/** All supported extensions flattened, for a quick membership check. */
export const ALL_SUPPORTED_EXTENSIONS: string[] = [
  ...SUPPORTED_EXTENSIONS.video,
  ...SUPPORTED_EXTENSIONS.audio,
  ...SUPPORTED_EXTENSIONS.image
]

/** Lowercase extension (with leading dot) of a path, or '' if none. */
export function fileExtension(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

export function projectDuration(project: Project): number {
  let max = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.start + clip.duration)
    }
  }
  return max
}

/** Zero-padded MM:SS clock (e.g. "00:00", "01:30", "90:00"). Shared by the timeline ruler/
 *  readout and the preview's time display so every timestamp uses one consistent format. */
export function formatMMSS(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function createEmptyProject(name: string): Project {
  const now = Date.now()
  return {
    id: cryptoRandomId(),
    name,
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [
      { id: cryptoRandomId(), type: 'video', name: 'Video 1', clips: [], muted: false, hidden: false },
      { id: cryptoRandomId(), type: 'audio', name: 'Audio 1', clips: [], muted: false, hidden: false },
      { id: cryptoRandomId(), type: 'text', name: 'Text 1', clips: [], muted: false, hidden: false }
    ],
    assets: [],
    createdAt: now,
    updatedAt: now
  }
}

function cryptoRandomId(): string {
  // Lightweight id generator usable in both renderer and main process without extra deps at import time.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface SpeedSegment {
  start: number // source time
  end: number // source time
  speed: number
}

/** Splits a media clip's source range into constant-speed pieces (SOURCE time), clamped to
 *  [trimIn, trimOut]. A single segment when the clip has no curve (flat `speed`). */
export function clipSpeedSegments(clip: MediaClip): SpeedSegment[] {
  if (clip.speedKeyframes && clip.speedKeyframes.length >= 2) {
    return speedSegmentsFromKeyframes(clip.trimIn, clip.trimOut, clip.speedKeyframes)
  }
  return [{ start: clip.trimIn, end: clip.trimOut, speed: clip.speed > 0 ? clip.speed : 1 }]
}

function speedSegmentsFromKeyframes(trimIn: number, trimOut: number, keyframes: SpeedKeyframe[]): SpeedSegment[] {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  const boundaryTimes = new Set<number>([trimIn, trimOut])
  for (const k of sorted) {
    if (k.time > trimIn && k.time < trimOut) boundaryTimes.add(k.time)
  }
  const boundaries = [...boundaryTimes].sort((a, b) => a - b)
  const segments: SpeedSegment[] = []
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]
    const end = boundaries[i + 1]
    if (end <= start) continue
    let speed = sorted[0].speed
    for (const k of sorted) {
      if (k.time <= start + 1e-9) speed = k.speed
    }
    segments.push({ start, end, speed: speed > 0 ? speed : 1 })
  }
  return segments.length > 0 ? segments : [{ start: trimIn, end: trimOut, speed: 1 }]
}

/** The clip's length on the timeline: authored directly for frozen clips, otherwise derived
 *  by integrating its (possibly curved) speed over its trimmed source range. This is the
 *  speed-aware analogue of reading `clip.duration` directly — video-track repacking and
 *  trim/split logic should use this instead of the raw field for MediaClips. */
export function effectiveDuration(clip: MediaClip): number {
  if (clip.frozen) return clip.duration
  let total = 0
  for (const seg of clipSpeedSegments(clip)) total += (seg.end - seg.start) / seg.speed
  return total
}

/** Maps clip-local timeline time (0..effectiveDuration(clip)) to a source time, honoring the
 *  clip's speed curve and `reversed` flag. The single source of truth for "what source frame
 *  is playing right now" — used by live preview and conceptually mirrored by the export
 *  segment-splitting in ffmpegGraph.ts. */
export function sourceTimeFor(clip: MediaClip, localT: number): number {
  if (clip.frozen) return clip.trimIn
  const dur = effectiveDuration(clip)
  const forwardT = clip.reversed ? Math.max(dur - localT, 0) : Math.max(localT, 0)
  const segments = clipSpeedSegments(clip)
  let elapsed = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const segTimelineLen = (seg.end - seg.start) / seg.speed
    if (forwardT <= elapsed + segTimelineLen || i === segments.length - 1) {
      const intoSeg = Math.min(Math.max(forwardT - elapsed, 0), segTimelineLen)
      return seg.start + intoSeg * seg.speed
    }
    elapsed += segTimelineLen
  }
  return clip.trimOut
}
