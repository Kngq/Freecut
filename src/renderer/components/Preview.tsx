import { useEffect, useRef } from 'react'
import { useProjectStore } from '../state/projectStore'
import type { Clip, MediaAsset, MediaClip, Project, Track } from '@shared/types'
import { interpolateTransform, projectDuration, sourceTimeFor, formatMMSS } from '@shared/types'
import { applyPostEffects, effectGeometry } from '@shared/effects'

const SEEK_DRIFT_THRESHOLD = 0.12
/** While free-running, drift below this (seconds) is ignored entirely — the element's own
 *  clock is trusted. Roughly 3-4 frames at 30fps. */
const PLAYBACK_DRIFT_TOLERANCE = 0.12
/** While free-running, a drift above this (seconds) is treated as a real discontinuity (clip
 *  switch, loop, large scrub) and corrected with a hard seek rather than a playbackRate nudge. */
const RESYNC_SEEK_THRESHOLD = 0.6

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
 *  the center away from the canvas middle. Clip effects are folded in: geometry effects
 *  (shake/Ken Burns) adjust the draw scale/center before `drawImage`, and pixel effects
 *  (blur/vignette/grain/B&W/flash/mirror) are applied to the drawn region afterward via
 *  applyPostEffects — the same stack the exporter mirrors in shared/effects.ts. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  media: HTMLVideoElement | HTMLImageElement,
  canvasW: number,
  canvasH: number,
  alpha: number,
  transform: { x: number; y: number; scale: number; rotation?: number; flipH?: boolean },
  effects: MediaClip['effects'],
  localT: number,
  clipDuration: number
) {
  const mw = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
  const mh = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
  if (!mw || !mh) return
  const geo = effectGeometry(effects, localT, clipDuration)
  const fit = Math.min(canvasW / mw, canvasH / mh) * transform.scale * geo.scale
  const w = mw * fit
  const h = mh * fit
  const cx = canvasW * (transform.x + geo.dx)
  const cy = canvasH * (transform.y + geo.dy)
  const rotation = transform.rotation ?? 0
  const flipH = transform.flipH ?? false
  const prevAlpha = ctx.globalAlpha
  ctx.globalAlpha = alpha
  if (rotation !== 0 || flipH) {
    // Rotate/mirror about the clip's center: move the origin there, apply rotation (degrees ->
    // radians) and a horizontal flip (scaleX = -1), then draw centered on the new origin.
    ctx.save()
    ctx.translate(cx, cy)
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180)
    if (flipH) ctx.scale(-1, 1)
    ctx.drawImage(media, -w / 2, -h / 2, w, h)
    ctx.restore()
  } else {
    ctx.drawImage(media, cx - w / 2, cy - h / 2, w, h)
  }
  ctx.globalAlpha = prevAlpha
  // Pixel effects operate on the whole canvas region (the frame fills it after contain-fit +
  // any over-scale), so pass the full canvas rect. Mirror/blur read back canvas pixels, which
  // is why this runs after the draw, not before.
  applyPostEffects(ctx, effects, { x: 0, y: 0, w: canvasW, h: canvasH }, localT)
}

/** Draws a visible error banner instead of leaving a clip silently black/soundless. */
function drawMediaError(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number, assetName: string, message: string) {
  const padding = 16
  const lineHeight = Math.max(canvasH * 0.028, 16)
  ctx.save()
  ctx.fillStyle = 'rgba(120, 20, 20, 0.85)'
  ctx.fillRect(0, canvasH / 2 - lineHeight * 2, canvasW, lineHeight * 4)
  ctx.fillStyle = 'white'
  ctx.font = `bold ${lineHeight}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`Can't play "${assetName}"`, canvasW / 2, canvasH / 2 - lineHeight * 0.6, canvasW - padding * 2)
  ctx.font = `${lineHeight * 0.75}px sans-serif`
  ctx.fillText(message, canvasW / 2, canvasH / 2 + lineHeight * 0.8, canvasW - padding * 2)
  ctx.restore()
}

/** HTMLMediaElement.error.code -> a human-readable reason, since MediaError.message is often
 *  empty in practice (Chromium doesn't always fill it in). */
function mediaErrorReason(code: number): string {
  switch (code) {
    case 1:
      return 'loading aborted'
    case 2:
      return 'network error'
    case 3:
      return 'decoding failed (corrupt file or unsupported encoding)'
    case 4:
      return 'source not supported (unsupported format/codec, or the file could not be read)'
    default:
      return 'unknown error'
  }
}

export default function Preview() {
  // Subscribed so the time readout under the preview re-renders as playback advances / clips
  // change. The canvas render loop reads the store imperatively via getState(); these hooks are
  // only for the readout below.
  const playhead = useProjectStore((s) => s.playhead)
  const project = useProjectStore((s) => s.project)
  const previewAssetId = useProjectStore((s) => s.previewAssetId)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const setPlayhead = useProjectStore((s) => s.setPlayhead)
  const duration = projectDuration(project)
  const previewAsset = previewAssetId ? project.assets.find((a) => a.id === previewAssetId) ?? null : null

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const imagePoolRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const rafRef = useRef<number>(0)
  const lastTickRef = useRef<number>(0)
  // Standalone playback position (seconds) for a single raw asset being previewed from the
  // MediaBin, independent of the timeline playhead.
  const previewClockRef = useRef<number>(0)
  const previewAssetIdRef = useRef<string | null>(null)
  // Per-clip playback problems, surfaced on canvas instead of failing silently — a clip whose
  // <video>/<audio> element can't load or play used to just never draw/sound with zero
  // indication why. Cleared the moment that element plays or loads successfully again.
  const errorsRef = useRef<Map<string, string>>(new Map())
  // Codec safety-net: readyState/canplay can lie (observed with ProRes — demuxes fine, reports
  // HAVE_ENOUGH_DATA, but videoWidth/videoHeight never leave 0, no error event ever fires).
  // ensurePreviewProxy catches known-bad codecs proactively at import; this catches anything
  // that slips through, by timing how long a clip has looked "ready" with no actual frame.
  const zeroSizeStartRef = useRef<Map<string, number>>(new Map())

  function reportMediaError(clipId: string, assetName: string, message: string) {
    if (errorsRef.current.get(clipId) === message) return // already reported, don't spam
    errorsRef.current.set(clipId, message)
    console.error(`[freecut preview] "${assetName}": ${message}`)
  }

  function getVideoEl(clip: MediaClip, asset: MediaAsset): HTMLVideoElement {
    let el = videoPoolRef.current.get(clip.id)
    if (!el) {
      el = document.createElement('video')
      el.src = window.api.fileUrl(asset.previewPath ?? asset.path)
      el.preload = 'auto'
      el.muted = true
      el.addEventListener('error', () => {
        const reason = el!.error ? mediaErrorReason(el!.error.code) : 'failed to load'
        reportMediaError(clip.id, asset.name, reason)
      })
      el.addEventListener('loadeddata', () => errorsRef.current.delete(clip.id))
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
      el.src = window.api.fileUrl(asset.previewPath ?? asset.path)
      el.preload = 'auto'
      el.addEventListener('error', () => {
        const reason = el!.error ? mediaErrorReason(el!.error.code) : 'failed to load'
        reportMediaError(clip.id, asset.name, `audio ${reason}`)
      })
      el.addEventListener('loadeddata', () => errorsRef.current.delete(clip.id))
      audioPoolRef.current.set(clip.id, el)
    }
    return el
  }

  /**
   * Keeps a pooled <video>/<audio> element in sync with the timeline.
   *
   * The subtlety that used to cause visible flicker/stutter (most noticeably on .mov files —
   * ProRes proxies and long-GOP H.264 both re-decode expensively on every seek): during normal
   * forward playback the render loop advances its own `t` on a RAF clock while the media
   * element plays on its own hardware clock. Those two clocks always drift a little, and the
   * old code issued an `el.currentTime = …` seek whenever the drift passed a small threshold —
   * i.e. several seeks per second *while playing*, each flushing the decoder.
   *
   * Fix: when the element can free-run at a constant native rate (playing, speed-constant,
   * not reversed, not frozen — `canFreeRun`), let it play untouched and only correct drift via
   * `playbackRate` nudges, reserving a hard seek for a large discontinuity (clip switch, loop,
   * a big scrub). When scrubbing (paused) or when the time mapping is non-linear (reverse /
   * speed curve / frozen), seek precisely as before.
   */
  function syncMediaElement(
    el: HTMLMediaElement,
    desiredSourceTime: number,
    maxTime: number,
    isPlaying: boolean,
    shouldMute: boolean,
    volume = 1,
    clip?: MediaClip,
    assetName?: string,
    nativeRate = 1,
    canFreeRun = false
  ) {
    const clamped = Math.min(Math.max(desiredSourceTime, 0), Math.max(maxTime - 0.03, 0))
    const drift = el.currentTime - clamped

    if (canFreeRun && !el.paused) {
      // Free-running: never hard-seek for ordinary drift. Correct only via playbackRate, and
      // resync with a seek solely on a large jump (a different clip, a loop, or a big scrub).
      if (Math.abs(drift) > RESYNC_SEEK_THRESHOLD) {
        el.currentTime = clamped
        el.playbackRate = nativeRate
      } else if (Math.abs(drift) > PLAYBACK_DRIFT_TOLERANCE) {
        // Speed the element up slightly when it's behind, slow it when ahead, so it converges
        // on the timeline without a seek. Clamped to a tiny ±8% so it's imperceptible.
        const correction = drift < 0 ? 1.08 : 0.92
        el.playbackRate = nativeRate * correction
      } else {
        el.playbackRate = nativeRate
      }
    } else {
      // Paused scrub, or a non-linear mapping (reverse/curve/frozen): precise seek as needed.
      if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD) el.currentTime = clamped
      el.playbackRate = nativeRate
    }

    el.muted = shouldMute
    el.volume = Math.min(Math.max(volume, 0), 1)
    if (isPlaying) {
      if (el.paused) {
        // On (re)start, land on the right frame before playing so the first frame isn't stale.
        if (Math.abs(drift) > SEEK_DRIFT_THRESHOLD) el.currentTime = clamped
        el.play()
          .then(() => {
            if (clip) errorsRef.current.delete(clip.id)
          })
          .catch((err: DOMException) => {
            if (clip && assetName) reportMediaError(clip.id, assetName, `playback blocked: ${err.name} (${err.message})`)
          })
      }
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

    // Standalone single-asset preview (clicking a MediaBin card). Renders just that asset with
    // its own playback clock, instead of the timeline, and returns early. Interacting with the
    // timeline (selecting a clip / scrubbing) clears previewAssetId in the store, which drops us
    // back to the normal path below.
    if (state.previewAssetId) {
      // Reset the standalone clock whenever the previewed asset changes, and pause any timeline
      // media so we don't hear a clip that's no longer on screen.
      if (previewAssetIdRef.current !== state.previewAssetId) {
        previewAssetIdRef.current = state.previewAssetId
        previewClockRef.current = 0
        for (const el of videoPoolRef.current.values()) if (!el.paused) el.pause()
        for (const el of audioPoolRef.current.values()) if (!el.paused) el.pause()
      }
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, width, height)
      const asset = project.assets.find((a) => a.id === state.previewAssetId)
      if (asset) {
        const tf = { x: 0.5, y: 0.5, scale: 1, opacity: 1, rotation: 0, flipH: false }
        if (asset.kind === 'image') {
          const img = getImageEl(asset)
          if (img.complete) drawContain(ctx, img, width, height, 1, tf, undefined, 0, asset.duration || 1)
        } else {
          // Synthetic clip id keeps a stable pool entry without clashing with real clips.
          const pseudo = { id: `preview:${asset.id}` } as MediaClip
          const el = getVideoEl(pseudo, asset)
          const maxT = asset.duration || el.duration || 0
          if (state.isPlaying) {
            // Restart from the top if we're resuming playback from the very end.
            if (maxT && previewClockRef.current >= maxT - 0.05) previewClockRef.current = 0
            const last = lastTickRef.current || nowMs
            const dt = Math.min((nowMs - last) / 1000, 0.1)
            previewClockRef.current = Math.min(previewClockRef.current + dt, maxT || Infinity)
            if (maxT && previewClockRef.current >= maxT) useProjectStore.setState({ isPlaying: false })
          }
          lastTickRef.current = nowMs
          syncMediaElement(el, previewClockRef.current, maxT || 1e9, state.isPlaying, false, 1, pseudo, asset.name, 1, state.isPlaying)
          if (el.readyState >= 2 && el.videoWidth > 0) {
            drawContain(ctx, el, width, height, 1, tf, undefined, 0, asset.duration || 1)
          }
          const err = errorsRef.current.get(pseudo.id)
          if (err) drawMediaError(ctx, width, height, asset.name, err)
        }
      }
      rafRef.current = requestAnimationFrame(render)
      return
    }
    // Leaving preview mode: clear the ref so re-entering later starts fresh.
    if (previewAssetIdRef.current !== null) previewAssetIdRef.current = null

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
        const interp = interpolateTransform(clip.transform, localT)
        // interpolateTransform only drives x/y/scale/opacity; rotation/flipH are static, read
        // straight from the clip transform so the preview matches export.
        const tf = { ...interp, rotation: clip.transform.rotation ?? 0, flipH: clip.transform.flipH ?? false }
        const finalAlpha = alpha * tf.opacity
        if (asset.kind === 'image') {
          const img = getImageEl(asset)
          if (img.complete) drawContain(ctx, img, width, height, finalAlpha, tf, clip.effects, localT, clip.duration)
          continue
        }
        const video = getVideoEl(clip, asset)
        liveClipIds.add(clip.id)
        const desired = sourceTimeFor(clip, localT)
        const mute = clip.muted || clip.volume <= 0 || active.length > 1
        // A clip can let its <video> free-run (no per-frame seeking — the .mov flicker fix)
        // only when the timeline-to-source mapping is linear and forward: playing, not frozen,
        // not reversed, and a constant speed (no speed curve). Its native rate is clip.speed.
        const hasCurve = (clip.speedKeyframes?.length ?? 0) >= 2
        const canFreeRun = state.isPlaying && !clip.frozen && !clip.reversed && !hasCurve
        const nativeRate = clip.speed > 0 ? clip.speed : 1
        // Frozen clips hold a single source frame: seek there once, never actually play.
        syncMediaElement(video, desired, asset.duration, state.isPlaying && !clip.frozen, mute, clip.volume, clip, asset.name, nativeRate, canFreeRun)
        if (video.readyState >= 2) {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            drawContain(ctx, video, width, height, finalAlpha, tf, clip.effects, localT, clip.duration)
            zeroSizeStartRef.current.delete(clip.id)
          } else {
            const firstSeen = zeroSizeStartRef.current.get(clip.id) ?? nowMs
            zeroSizeStartRef.current.set(clip.id, firstSeen)
            if (nowMs - firstSeen > 1200) {
              reportMediaError(clip.id, asset.name, 'video stream could not be decoded (unsupported codec)')
            }
          }
        }
        const err = errorsRef.current.get(clip.id)
        if (err) drawMediaError(ctx, width, height, asset.name, err)
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
        const hasCurve = (clip.speedKeyframes?.length ?? 0) >= 2
        const canFreeRun = state.isPlaying && !clip.frozen && !clip.reversed && !hasCurve
        const nativeRate = clip.speed > 0 ? clip.speed : 1
        syncMediaElement(
          audioEl,
          desired,
          asset.duration,
          state.isPlaying && !clip.frozen,
          clip.muted || clip.volume <= 0,
          clip.volume,
          clip,
          asset.name,
          nativeRate,
          canFreeRun
        )
        const err = errorsRef.current.get(clip.id)
        if (err && !liveClipIds.has(clip.id)) drawMediaError(ctx, width, height, asset.name, err)
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
      <div className="preview-controls">
        <button
          className="preview-skip"
          title="Jump to start"
          onClick={() => setPlayhead(0)}
          aria-label="Jump to start"
        >
          ⏮
        </button>
        <button
          className={`preview-playpause ${isPlaying ? 'playing' : 'paused'}`}
          title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={() => setIsPlaying(!isPlaying)}
        >
          {isPlaying ? (
            // Pause glyph: two bars
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            // Play glyph: triangle
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <div className="preview-time">
          {previewAsset ? `Preview · ${previewAsset.name} · ${formatMMSS(previewAsset.duration)}` : `${formatMMSS(playhead)} / ${formatMMSS(duration)}`}
        </div>
      </div>
    </div>
  )
}
