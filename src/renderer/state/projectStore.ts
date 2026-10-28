import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import {
  createEmptyProject,
  projectDuration,
  type Clip,
  type MediaAsset,
  type MediaClip,
  type Project,
  type Track,
  type TrackType
} from '@shared/types'

interface ProjectState {
  project: Project
  filePath: string | null
  dirty: boolean
  selectedClipId: string | null
  playhead: number
  isPlaying: boolean
  pxPerSecond: number

  setProject: (project: Project, filePath?: string | null) => void
  newProject: () => void

  addAsset: (asset: MediaAsset) => void
  /** Removes an asset from the media pool and any clips on the timeline that reference it. */
  removeAsset: (assetId: string) => void
  /** On video tracks the clip is appended unless `insertAtStart` is set, in which case it's placed at `start`. */
  addMediaClipToTrack: (trackId: string, asset: MediaAsset, start: number, options?: { insertAtStart?: boolean }) => void
  addTextClipToTrack: (trackId: string, start: number) => void
  addTrack: (type: TrackType) => void

  /** Free positioning: only valid for audio/text tracks. */
  moveFreeClip: (clipId: string, newStart: number, newTrackId?: string) => void
  /** Reorder within (or into) a contiguous video track by array index. */
  reorderVideoClip: (clipId: string, toTrackId: string, toIndex: number) => void

  trimClip: (clipId: string, edge: 'start' | 'end', newTime: number) => void
  splitClipAtPlayhead: () => void
  removeClip: (clipId: string) => void
  setTransition: (clipId: string, duration: number) => void
  updateTextClip: (clipId: string, patch: Record<string, unknown>) => void
  updateMediaClipProps: (clipId: string, patch: Partial<Pick<MediaClip, 'volume' | 'muted'>>) => void

  selectClip: (clipId: string | null) => void
  setPlayhead: (t: number) => void
  setIsPlaying: (v: boolean) => void
  setZoom: (pxPerSecond: number) => void
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index !== -1) return { track, clip: track.clips[index], index }
  }
  return null
}

function touch(project: Project): Project {
  return { ...project, updatedAt: Date.now() }
}

/**
 * Video tracks are a contiguous roll: array order === playback order, and `start` is a
 * derived value, not something a drag can set freely. A transitionIn pulls a clip's start
 * back by its (clamped) duration, exactly mirroring the xfade offset math in ffmpegGraph.ts
 * so the canvas preview and the exported file always agree.
 */
function repackVideoTrack(track: Track): Track {
  if (track.type !== 'video') return track
  const clips = track.clips
  let cursor = 0
  const repacked = clips.map((c, i) => {
    if (i === 0) {
      cursor = c.duration
      return { ...c, start: 0, transitionIn: undefined } as Clip
    }
    const d = Math.min(c.transitionIn?.duration ?? 0, cursor, c.duration)
    const start = cursor - d
    cursor = start + c.duration
    return { ...c, start } as Clip
  })
  return { ...track, clips: repacked }
}

function updateTrack(project: Project, trackId: string, fn: (t: Track) => Track): Project {
  const tracks = project.tracks.map((t) => (t.id === trackId ? fn(t) : t))
  return touch({ ...project, tracks })
}

export const useProjectStore = create<ProjectState>((set) => ({
  project: createEmptyProject('Untitled'),
  filePath: null,
  dirty: false,
  selectedClipId: null,
  playhead: 0,
  isPlaying: false,
  pxPerSecond: 60,

  setProject: (project, filePath = null) => set({ project, filePath, dirty: false, selectedClipId: null, playhead: 0 }),

  newProject: () => set({ project: createEmptyProject('Untitled'), filePath: null, dirty: false, selectedClipId: null, playhead: 0 }),

  addAsset: (asset) =>
    set((s) => ({ project: touch({ ...s.project, assets: [...s.project.assets, asset] }), dirty: true })),

  removeAsset: (assetId) =>
    set((s) => {
      const tracks = s.project.tracks.map((t) => {
        const clips = t.clips.filter((c) => !(c.kind === 'media' && c.assetId === assetId))
        return t.type === 'video' ? repackVideoTrack({ ...t, clips }) : { ...t, clips }
      })
      const assets = s.project.assets.filter((a) => a.id !== assetId)
      const project = touch({ ...s.project, tracks, assets })
      const selectionStillExists = s.selectedClipId !== null && findClip(project, s.selectedClipId) !== null
      return { project, dirty: true, selectedClipId: selectionStillExists ? s.selectedClipId : null }
    }),

  addMediaClipToTrack: (trackId, asset, start, options) =>
    set((s) => {
      const track = s.project.tracks.find((t) => t.id === trackId)
      if (!track) return {}
      const duration = asset.kind === 'image' ? 5 : asset.duration
      const clip: MediaClip = {
        id: uuid(),
        kind: 'media',
        trackId,
        start: track.type === 'video' ? 0 : start,
        duration,
        trimIn: 0,
        trimOut: asset.kind === 'image' ? duration : asset.duration,
        assetId: asset.id,
        volume: 1,
        muted: false
      }
      const project = updateTrack(s.project, trackId, (t) => {
        let clips = [...t.clips, clip]
        if (t.type === 'video' && options?.insertAtStart) {
          // Insert before the first clip whose midpoint is after the drop point, like a drag-reorder.
          const index = t.clips.findIndex((c) => start < c.start + c.duration / 2)
          if (index !== -1) clips = [...t.clips.slice(0, index), clip, ...t.clips.slice(index)]
        }
        return repackVideoTrack({ ...t, clips })
      })
      return { project, dirty: true, selectedClipId: clip.id }
    }),

  addTextClipToTrack: (trackId, start) =>
    set((s) => {
      const clip: Clip = {
        id: uuid(),
        kind: 'text',
        trackId,
        start,
        duration: 3,
        text: 'New text',
        fontSize: 64,
        color: 'white',
        x: 0.5,
        y: 0.5,
        bold: true
      }
      const project = updateTrack(s.project, trackId, (t) => ({ ...t, clips: [...t.clips, clip] }))
      return { project, dirty: true, selectedClipId: clip.id }
    }),

  addTrack: (type) =>
    set((s) => {
      const count = s.project.tracks.filter((t) => t.type === type).length + 1
      const track: Track = {
        id: uuid(),
        type,
        name: `${type[0].toUpperCase()}${type.slice(1)} ${count}`,
        clips: [],
        muted: false,
        hidden: false
      }
      return { project: touch({ ...s.project, tracks: [...s.project.tracks, track] }), dirty: true }
    }),

  moveFreeClip: (clipId, newStart, newTrackId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found || found.track.type === 'video') return {}
      const targetTrackId = newTrackId ?? found.track.id
      const targetTrack = s.project.tracks.find((t) => t.id === targetTrackId)
      if (!targetTrack || targetTrack.type === 'video') return {}
      const clampedStart = Math.max(0, newStart)
      const tracks = s.project.tracks.map((t) => {
        if (t.id === found.track.id && t.id !== targetTrackId) {
          return { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
        }
        if (t.id === targetTrackId) {
          const withoutClip = t.clips.filter((c) => c.id !== clipId)
          const moved = { ...found.clip, start: clampedStart, trackId: targetTrackId }
          return { ...t, clips: [...withoutClip, moved] }
        }
        return t
      })
      return { project: touch({ ...s.project, tracks }), dirty: true }
    }),

  reorderVideoClip: (clipId, toTrackId, toIndex) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const targetTrack = s.project.tracks.find((t) => t.id === toTrackId)
      if (!targetTrack || targetTrack.type !== 'video') return {}

      const tracks = s.project.tracks.map((t) => {
        if (t.id === found.track.id && t.id !== toTrackId) {
          return repackVideoTrack({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })
        }
        if (t.id === toTrackId) {
          const without = t.clips.filter((c) => c.id !== clipId)
          const clampedIndex = Math.max(0, Math.min(toIndex, without.length))
          const moved = { ...found.clip, trackId: toTrackId }
          const next = [...without.slice(0, clampedIndex), moved, ...without.slice(clampedIndex)]
          return repackVideoTrack({ ...t, clips: next })
        }
        return t
      })
      return { project: touch({ ...s.project, tracks }), dirty: true }
    }),

  trimClip: (clipId, edge, newTime) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const clip = found.clip
      // Video and audio clips can't be trimmed outside their source file. Images and text are unbounded.
      const asset = clip.kind === 'media' ? s.project.assets.find((a) => a.id === clip.assetId) : undefined
      const sourceLimited = clip.kind === 'media' && asset !== undefined && asset.kind !== 'image'
      let patch: Partial<Clip> = {}
      if (edge === 'start') {
        let delta = Math.max(newTime, 0) - clip.start
        if (sourceLimited && clip.kind === 'media') delta = Math.max(delta, -clip.trimIn)
        const newDuration = clip.duration - delta
        if (newDuration < 0.1) return {}
        patch = { duration: newDuration }
        if (found.track.type !== 'video') patch.start = clip.start + delta
        if (clip.kind === 'media') patch = { ...patch, trimIn: clip.trimIn + delta } as Partial<MediaClip>
      } else {
        let newDuration = newTime - clip.start
        if (sourceLimited && clip.kind === 'media') newDuration = Math.min(newDuration, asset.duration - clip.trimIn)
        if (newDuration < 0.1) return {}
        patch = { duration: newDuration }
        if (clip.kind === 'media') patch = { ...patch, trimOut: clip.trimIn + newDuration } as Partial<MediaClip>
      }
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = { ...t, clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c)) }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  splitClipAtPlayhead: () =>
    set((s) => {
      const clipId = s.selectedClipId
      if (!clipId) return {}
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const { track, clip, index } = found
      const t = s.playhead
      if (t <= clip.start + 0.05 || t >= clip.start + clip.duration - 0.05) return {}

      const firstDuration = t - clip.start
      const secondDuration = clip.duration - firstDuration

      let first: Clip
      let second: Clip
      if (clip.kind === 'media') {
        first = { ...clip, duration: firstDuration, trimOut: clip.trimIn + firstDuration }
        second = { ...clip, id: uuid(), start: t, duration: secondDuration, trimIn: clip.trimIn + firstDuration, transitionIn: undefined }
      } else {
        first = { ...clip, duration: firstDuration }
        second = { ...clip, id: uuid(), start: t, duration: secondDuration, transitionIn: undefined }
      }

      const project = updateTrack(s.project, track.id, (tr) => {
        const clips = [...tr.clips]
        clips[index] = first
        clips.splice(index + 1, 0, second)
        return repackVideoTrack({ ...tr, clips })
      })
      return { project, dirty: true, selectedClipId: second.id }
    }),

  removeClip: (clipId) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => repackVideoTrack({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }))
      return { project, dirty: true, selectedClipId: s.selectedClipId === clipId ? null : s.selectedClipId }
    }),

  setTransition: (clipId, duration) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      const firstVideoTrack = s.project.tracks.find((t) => t.type === 'video')
      if (!found || found.track.type !== 'video' || found.track.id !== firstVideoTrack?.id || found.index === 0) return {}
      const project = updateTrack(s.project, found.track.id, (t) => {
        const withPatch = {
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, transitionIn: duration > 0 ? { type: 'crossfade' as const, duration } : undefined } : c))
        }
        return repackVideoTrack(withPatch)
      })
      return { project, dirty: true }
    }),

  updateTextClip: (clipId, patch) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c))
      }))
      return { project, dirty: true }
    }),

  updateMediaClipProps: (clipId, patch) =>
    set((s) => {
      const found = findClip(s.project, clipId)
      if (!found) return {}
      const project = updateTrack(s.project, found.track.id, (t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? ({ ...c, ...patch } as Clip) : c))
      }))
      return { project, dirty: true }
    }),

  selectClip: (clipId) => set({ selectedClipId: clipId }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setZoom: (pxPerSecond) => set({ pxPerSecond: Math.min(Math.max(pxPerSecond, 10), 400) })
}))

export function getProjectDuration(project: Project): number {
  return projectDuration(project)
}
