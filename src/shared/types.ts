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
}

export type TransitionType = 'crossfade' | 'dipToBlack'

export interface Transition {
  type: TransitionType
  duration: number // seconds, overlaps the end of the previous clip with the start of this clip
}

interface ClipBase {
  id: string
  trackId: string
  start: number // position on the timeline, seconds
  duration: number // visible length on the timeline, seconds
  /** Transition into this clip from the previous clip on the same track. */
  transitionIn?: Transition
}

export interface MediaClip extends ClipBase {
  kind: 'media'
  assetId: string
  trimIn: number // seconds into the source media
  trimOut: number // seconds into the source media; trimOut - trimIn === duration
  volume: number // 0-1
  muted: boolean
}

export interface TextClip extends ClipBase {
  kind: 'text'
  text: string
  fontSize: number // px, relative to a 1080-tall canvas
  color: string
  x: number // 0-1, relative to canvas width, text center
  y: number // 0-1, relative to canvas height, text center
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
