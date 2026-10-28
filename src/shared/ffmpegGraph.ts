import type { Clip, MediaAsset, MediaClip, Project, Track } from './types'

export interface FfmpegPlan {
  inputs: string[] // -i arguments, in order; filter graph refers to them as [0:v], [1:v], etc.
  filterComplex: string
  videoOutLabel: string
  audioOutLabel: string | null
  videoArgs: string[]
}

interface InputRef {
  index: number
  asset: MediaAsset
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ')
}

function sortedClips<T extends Clip>(track: Track): T[] {
  return [...track.clips].sort((a, b) => a.start - b.start) as T[]
}

/**
 * Builds an ffmpeg filter expression that linearly interpolates a value across a sorted list
 * of (time, value) keyframes as a function of `timeVar` (e.g. `t` inside an overlay/enable
 * expression, `T` inside most other filters). Clamps to the first/last value outside the
 * keyframe range. This is the export-side mirror of `interpolateTransform` in shared/types.ts —
 * used by the keyframe-animation feature for position/scale/opacity (x/y/scale/opacity each
 * get their own call), one property per invocation.
 */
export function piecewiseLinearExpr(keyframes: { time: number; value: number }[], timeVar: string): string {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  if (sorted.length === 0) return '0'
  if (sorted.length === 1) return String(sorted[0].value)
  let expr = String(sorted[sorted.length - 1].value)
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const span = b.time - a.time
    const interp = span <= 0 ? String(b.value) : `(${a.value}+(${b.value}-${a.value})*(${timeVar}-${a.time})/${span})`
    expr = `if(lt(${timeVar},${b.time}),${interp},${expr})`
  }
  return `if(lt(${timeVar},${sorted[0].time}),${sorted[0].value},${expr})`
}

/**
 * Builds the ffmpeg inputs + filter_complex needed to render a Project to a single
 * output file. Scope (barebones v1):
 *  - One or more video tracks, composited bottom-to-top with `overlay`, each clip's own
 *    cut/crossfade transitions handled within its own track's chain before compositing.
 *  - Text tracks rendered with `drawtext`, layered on top of all video.
 *  - Audio tracks and un-muted video clip audio are trimmed, delayed, and mixed with `amix`.
 */
export function buildFfmpegPlan(project: Project): FfmpegPlan {
  const { width, height, fps } = project.canvas
  const assetById = new Map(project.assets.map((a) => [a.id, a]))

  const inputs: string[] = []
  let inputCount = 0
  const inputRefByAssetId = new Map<string, InputRef>()
  function inputFor(assetId: string): InputRef {
    const existing = inputRefByAssetId.get(assetId)
    if (existing) return existing
    const asset = assetById.get(assetId)
    if (!asset) throw new Error(`Unknown asset ${assetId}`)
    const index = inputCount++
    if (asset.kind === 'image') {
      inputs.push('-loop', '1', '-framerate', String(fps), '-i', asset.path)
    } else {
      inputs.push('-i', asset.path)
    }
    const ref: InputRef = { index, asset }
    inputRefByAssetId.set(assetId, ref)
    return ref
  }

  const filters: string[] = []
  let labelCounter = 0
  const nextLabel = (prefix: string) => `${prefix}${labelCounter++}`

  const videoTracks = project.tracks.filter((t) => t.type === 'video' && !t.hidden)
  const audioTracks = project.tracks.filter((t) => t.type === 'audio' && !t.muted)
  const textTracks = project.tracks.filter((t) => t.type === 'text' && !t.hidden)

  // ---- Video ----
  // Only the *first* video track is treated as a contiguous roll (its clips always start
  // at absolute 0 by construction — see repackVideoTrack — so a local xfade/concat chain
  // is safe here). Every later video track is a free-floating overlay: each clip is scaled,
  // shifted to its own absolute `start`, and composited with `overlay=...:enable=between(...)`
  // so it appears at the right place regardless of what else is happening on the track.
  // Transitions on overlay tracks are not modeled in export (hard cut) — the Inspector only
  // offers the transition control on the primary track to keep preview/export in agreement.
  const scalePadFor = () =>
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`

  function trimmedSegmentLabel(clip: MediaClip, asset: MediaAsset): string {
    const ref = inputFor(clip.assetId)
    const segLabel = nextLabel('vseg')
    if (asset.kind === 'image') {
      filters.push(`[${ref.index}:v]trim=duration=${clip.duration},${scalePadFor()},setpts=PTS-STARTPTS[${segLabel}]`)
    } else {
      filters.push(
        `[${ref.index}:v]trim=start=${clip.trimIn}:end=${clip.trimOut},setpts=PTS-STARTPTS,${scalePadFor()}[${segLabel}]`
      )
    }
    return segLabel
  }

  let videoOutLabel: string | null = null

  const [primaryTrack, ...overlayTracks] = videoTracks
  if (primaryTrack) {
    const clips = sortedClips<MediaClip>(primaryTrack).filter((c) => c.kind === 'media')
    if (clips.length > 0) {
      const segmentLabels: string[] = []
      const segmentDurations: number[] = []
      for (const clip of clips) {
        const asset = assetById.get(clip.assetId)
        if (!asset) continue
        segmentLabels.push(trimmedSegmentLabel(clip, asset))
        segmentDurations.push(clip.duration)
      }

      // Chain segments with xfade (crossfade) where a transitionIn is specified, otherwise
      // plain concat. xfade's `offset` is measured on the *running* chain, so we track it.
      let chainLabel = segmentLabels[0]
      let runningDuration = segmentDurations[0]

      for (let i = 1; i < segmentLabels.length; i++) {
        const clip = clips[i]
        const nextSeg = segmentLabels[i]
        const nextDuration = segmentDurations[i]
        const out = nextLabel('vchain')

        if (clip.transitionIn && clip.transitionIn.duration > 0) {
          const d = Math.min(clip.transitionIn.duration, runningDuration, nextDuration)
          const offset = Math.max(runningDuration - d, 0)
          const xfadeType = clip.transitionIn.type === 'dipToBlack' ? 'fadeblack' : 'fade'
          filters.push(`[${chainLabel}][${nextSeg}]xfade=transition=${xfadeType}:duration=${d}:offset=${offset}[${out}]`)
          runningDuration = runningDuration + nextDuration - d
        } else {
          filters.push(`[${chainLabel}][${nextSeg}]concat=n=2:v=1:a=0[${out}]`)
          runningDuration = runningDuration + nextDuration
        }
        chainLabel = out
      }

      videoOutLabel = chainLabel
    }
  }

  if (videoOutLabel === null) {
    const base = nextLabel('base')
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=1[${base}]`)
    videoOutLabel = base
  }

  for (const track of overlayTracks) {
    const clips = sortedClips<MediaClip>(track).filter((c) => c.kind === 'media')
    for (const clip of clips) {
      const asset = assetById.get(clip.assetId)
      if (!asset) continue
      const trimmed = trimmedSegmentLabel(clip, asset)
      const shifted = nextLabel('vshift')
      filters.push(`[${trimmed}]setpts=PTS+${clip.start}/TB[${shifted}]`)
      const out = nextLabel('comp')
      const end = clip.start + clip.duration
      filters.push(`[${videoOutLabel}][${shifted}]overlay=0:0:enable='between(t,${clip.start},${end})'[${out}]`)
      videoOutLabel = out
    }
  }

  // ---- Text overlays ----
  for (const track of textTracks) {
    const clips = sortedClips(track).filter((c): c is Clip & { kind: 'text' } => c.kind === 'text')
    for (const clip of clips) {
      const out = nextLabel('txt')
      const start = clip.start
      const end = clip.start + clip.duration
      const fontColor = clip.color || 'white'
      const fontSize = Math.round(clip.fontSize)
      // Static transform only for now — keyframed text position/scale/opacity export lands
      // with the keyframe-animation feature, which reuses piecewiseLinearExpr below.
      const xExpr = `(w-text_w)*${clip.transform.x}`
      const yExpr = `(h-text_h)*${clip.transform.y}`
      filters.push(
        `[${videoOutLabel}]drawtext=text='${escapeDrawtext(clip.text)}':fontcolor=${fontColor}:fontsize=${fontSize}` +
          `:x=${xExpr}:y=${yExpr}:enable='between(t,${start},${end})'[${out}]`
      )
      videoOutLabel = out
    }
  }

  // ---- Audio: mix audio-track clips + un-muted video-clip audio ----
  const audioMixLabels: string[] = []

  function addAudioClip(clip: MediaClip, asset: MediaAsset) {
    if (!asset.hasAudio || clip.muted || clip.volume <= 0) return
    const ref = inputFor(clip.assetId)
    const trimmed = nextLabel('atrim')
    filters.push(
      `[${ref.index}:a]atrim=start=${clip.trimIn}:end=${clip.trimOut},asetpts=PTS-STARTPTS,` +
        `volume=${clip.volume},adelay=${Math.round(clip.start * 1000)}|${Math.round(clip.start * 1000)}[${trimmed}]`
    )
    audioMixLabels.push(trimmed)
  }

  for (const track of audioTracks) {
    for (const clip of sortedClips<MediaClip>(track)) {
      if (clip.kind !== 'media') continue
      const asset = assetById.get(clip.assetId)
      if (asset) addAudioClip(clip, asset)
    }
  }
  for (const track of videoTracks) {
    for (const clip of sortedClips<MediaClip>(track)) {
      if (clip.kind !== 'media') continue
      const asset = assetById.get(clip.assetId)
      if (asset) addAudioClip(clip, asset)
    }
  }

  let audioOutLabel: string | null = null
  if (audioMixLabels.length === 1) {
    audioOutLabel = audioMixLabels[0]
  } else if (audioMixLabels.length > 1) {
    const out = nextLabel('amix')
    filters.push(`${audioMixLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioMixLabels.length}:normalize=0[${out}]`)
    audioOutLabel = out
  }

  return {
    inputs,
    filterComplex: filters.join(';'),
    videoOutLabel,
    audioOutLabel,
    videoArgs: ['-r', String(fps), '-s', `${width}x${height}`]
  }
}

export function planToFfmpegArgs(plan: FfmpegPlan, outputPath: string): string[] {
  const args: string[] = ['-y', ...plan.inputs, '-filter_complex', plan.filterComplex]
  args.push('-map', `[${plan.videoOutLabel}]`)
  if (plan.audioOutLabel) {
    args.push('-map', `[${plan.audioOutLabel}]`)
  }
  args.push(...plan.videoArgs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p')
  if (plan.audioOutLabel) {
    args.push('-c:a', 'aac')
  } else {
    args.push('-an')
  }
  args.push(outputPath)
  return args
}
