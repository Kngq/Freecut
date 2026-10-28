export type MediaKind = 'video' | 'audio' | 'image'

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
}

export type TransitionType = 'crossfade' | 'dipToBlack'

export interface Transition {
  type: TransitionType
  duration: number // seconds, overlaps the end of the previous clip with the start of this clip
}

export interface TransformKeyframe {
  time: number // clip-local timeline seconds, 0..effective clip duration
  x: number
  y: number
  scale: number
  opacity: number
}

/** Position/scale/opacity for a clip. Static unless `keyframes` has >=2 points, in which case
 *  the static x/y/scale/opacity are ignored and interpolateTransform() drives the value instead. */
export interface ClipTransform {
  x: number // 0-1, relative to canvas width, anchor center
  y: number // 0-1, relative to canvas height, anchor center
  scale: number // 1 = 100%
  opacity: number // 0-1
  keyframes?: TransformKeyframe[]
}

export function defaultTransform(): ClipTransform {
  return { x: 0.5, y: 0.5, scale: 1, opacity: 1 }
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

interface ClipBase {
  id: string
  trackId: string
  start: number // position on the timeline, seconds
  duration: number // visible length on the timeline, seconds
  /** Transition into this clip from the previous clip on the same track. */
  transitionIn?: Transition
  transform: ClipTransform
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

export function projectDuration(project: Project): number {
  let max = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.start + clip.duration)
    }
  }
  return max
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
