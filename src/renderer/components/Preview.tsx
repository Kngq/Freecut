import { useEffect, useRef } from 'react'
import { useProjectStore } from '../state/projectStore'
import type { Clip, MediaAsset, MediaClip, Project, Track } from '@shared/types'
import { interpolateTransform, projectDuration, sourceTimeFor } from '@shared/types'

const SEEK_DRIFT_THRESHOLD = 0.12

interface ActiveMedia {
  clip: MediaClip
  asset: MediaAsset
  alpha: number
}

function findActiveMedia(track: Track, assetById: Map<string, MediaAsset>, t: number): ActiveMedia[] {
  const clips = track.clips.filter((c): c is MediaClip => c.kind === 'media')
  const result: ActiveMedia[] = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    if (t < clip.start || t >= clip.start + clip.duration) continue
    const asset = assetById.get(clip.assetId)
    if (!asset) continue

    const d = clip.transitionIn?.duration ?? 0
    if (d > 0 && t < clip.start + d && i > 0) {
      const prev = clips[i - 1]
      const prevAsset = assetById.get(prev.assetId)
      const progress = (t - clip.start) / d
      if (prevAsset) result.push({ clip: prev, asset: prevAsset, alpha: 1 - progress })
      result.push({ clip, asset, alpha: progress })
    } else {
      result.push({ clip, asset, alpha: 1 })
    }
  }
  return result
}

/** Draws media "contain"-fit within the canvas, then scaled and re-centered by the clip's
 *  (possibly keyframed) transform: `scale` enlarges around the fit size, `x`/`y` (0-1) move
 *  the center away from the canvas middle. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  media: HTMLVideoElement | HTMLImageElement,
  canvasW: number,
  canvasH: number,
  alpha: number,
  transform: { x: number; y: number; scale: number }
) {
  const mw = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
  const mh = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
  if (!mw || !mh) return
  const fit = Math.min(canvasW / mw, canvasH / mh) * transform.scale
  const w = mw * fit
  const h = mh * fit
  const cx = canvasW * transform.x
  const cy = canvasH * transform.y
  const prevAlpha = ctx.globalAlpha
  ctx.globalAlpha = alpha
  ctx.drawImage(media, cx - w / 2, cy - h / 2, w, h)
  ctx.globalAlpha = prevAlpha
}

export default function Preview() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const imagePoolRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const rafRef = useRef<number>(0)
  const lastTickRef = useRef<number>(0)

  function getVideoEl(clip: MediaClip, asset: MediaAsset): HTMLVideoElement {
    let el = videoPoolRef.current.get(clip.id)
    if (!el) {
      el = document.createElement('video')
      el.src = window.api.fileUrl(asset.path)
      el.preload = 'auto'
      el.muted = true
      videoPoolRef.current.set(clip.id, el)
    }
    return el
  }

  function getImageEl(asset: MediaAsset): HTMLImageElement {
    let el = imagePoolRef.current.get(asset.id)
    if (!el) {
      el = new Image()
      el.src = window.api.fileUrl(asset.path)
      imagePoolRef.current.set(asset.id, el)
    }
    return el
  }

  function getAudioEl(clip: MediaClip, asset: MediaAsset): HTMLAudioElement {
    let el = audioPoolRef.current.get(clip.id)
    if (!el) {
      el = document.createElement('audio')
      el.src = window.api.fileUrl(asset.path)
      el.preload = 'auto'
      audioPoolRef.current.set(clip.id, el)
    }
    return el
  }

  function syncMediaElement(el: HTMLMediaElement, desiredSourceTime: number, maxTime: number, isPlaying: boolean, shouldMute: boolean, volume = 1) {
    const clamped = Math.min(Math.max(desiredSourceTime, 0), Math.max(maxTime - 0.03, 0))
    if (Math.abs(el.currentTime - clamped) > SEEK_DRIFT_THRESHOLD) {
      el.currentTime = clamped
    }
    el.muted = shouldMute
    el.volume = Math.min(Math.max(volume, 0), 1)
    if (isPlaying) {
      if (el.paused) el.play().catch(() => {})
    } else if (!el.paused) {
      el.pause()
    }
  }

  function render(nowMs: number) {
    const canvas = canvasRef.current
    if (!canvas) {
      rafRef.current = requestAnimationFrame(render)
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      rafRef.current = requestAnimationFrame(render)
      return
    }

    const state = useProjectStore.getState()
    const project: Project = state.project
    const { width, height } = project.canvas
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    let t = state.playhead
    const duration = projectDuration(project)

    if (state.isPlaying) {
      const last = lastTickRef.current || nowMs
      const dt = Math.min((nowMs - last) / 1000, 0.1)
      t = Math.min(t + dt, duration)
      useProjectStore.setState({ playhead: t })
      if (t >= duration) {
        useProjectStore.setState({ isPlaying: false })
      }
    }
    lastTickRef.current = nowMs

    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, width, height)

    const assetById = new Map(project.assets.map((a) => [a.id, a]))
    const liveClipIds = new Set<string>()

    for (const track of project.tracks) {
      if (track.type !== 'video' || track.hidden) continue
      const active = findActiveMedia(track, assetById, t)
      for (const { clip, asset, alpha } of active) {
        const localT = t - clip.start
        const tf = interpolateTransform(clip.transform, localT)
        const finalAlpha = alpha * tf.opacity
        if (asset.kind === 'image') {
          const img = getImageEl(asset)
          if (img.complete) drawContain(ctx, img, width, height, finalAlpha, tf)
          continue
        }
        const video = getVideoEl(clip, asset)
        liveClipIds.add(clip.id)
        const desired = sourceTimeFor(clip, localT)
        const mute = clip.muted || clip.volume <= 0 || active.length > 1
        // Frozen clips hold a single source frame: seek there once, never actually play.
        syncMediaElement(video, desired, asset.duration, state.isPlaying && !clip.frozen, mute, clip.volume)
        if (video.readyState >= 2) drawContain(ctx, video, width, height, finalAlpha, tf)
      }
    }

    // Pause/mute any pooled video elements that aren't currently active.
    for (const [clipId, el] of videoPoolRef.current) {
      if (!liveClipIds.has(clipId) && !el.paused) el.pause()
    }

    const liveAudioIds = new Set<string>()
    for (const track of project.tracks) {
      if (track.type !== 'audio' || track.muted) continue
      for (const clip of track.clips) {
        if (clip.kind !== 'media') continue
        if (t < clip.start || t >= clip.start + clip.duration) continue
        const asset = assetById.get(clip.assetId)
        if (!asset) continue
        const audioEl = getAudioEl(clip, asset)
        liveAudioIds.add(clip.id)
        const desired = sourceTimeFor(clip, t - clip.start)
        syncMediaElement(audioEl, desired, asset.duration, state.isPlaying && !clip.frozen, clip.muted || clip.volume <= 0, clip.volume)
      }
    }
    for (const [clipId, el] of audioPoolRef.current) {
      if (!liveAudioIds.has(clipId) && !el.paused) el.pause()
    }

    // Text overlays, drawn last (on top).
    for (const track of project.tracks) {
      if (track.type !== 'text' || track.hidden) continue
      for (const clip of track.clips as Clip[]) {
        if (clip.kind !== 'text') continue
        if (t < clip.start || t >= clip.start + clip.duration) continue
        const tf = interpolateTransform(clip.transform, t - clip.start)
        const fontSize = clip.fontSize * tf.scale
        ctx.font = `${clip.bold ? 'bold ' : ''}${fontSize}px sans-serif`
        ctx.fillStyle = clip.color || 'white'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        const metrics = ctx.measureText(clip.text)
        const textW = metrics.width
        const textH = fontSize * 1.2
        const x = (width - textW) * tf.x
        const y = (height - textH) * tf.y
        const prevAlpha = ctx.globalAlpha
        ctx.globalAlpha = tf.opacity
        ctx.fillText(clip.text, x, y)
        ctx.globalAlpha = prevAlpha
      }
    }

    rafRef.current = requestAnimationFrame(render)
  }

  useEffect(() => {
    rafRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <div className="preview-canvas-wrap">
      <canvas ref={canvasRef} className="preview-canvas" />
    </div>
  )
}
