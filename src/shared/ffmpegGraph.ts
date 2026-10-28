import { clipSpeedSegments, type Clip, type ClipTransform, type MediaAsset, type MediaClip, type Project, type Track } from './types'

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
 * of (time, value) keyframes as a function of `timeVar` (e.g. `t` inside most filters' own
 * per-frame expression evaluation, `T` specifically inside `geq`, which uses uppercase X/Y/T
 * in its per-pixel expression language — verified empirically, not from the filter docs alone).
 * Clamps to the first/last value outside the keyframe range. This is the export-side mirror of
 * `interpolateTransform` in shared/types.ts — used by the keyframe-animation feature for
 * position/scale/opacity (x/y/scale/opacity each get their own call), one property per
 * invocation.
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
 * ffmpeg's `atempo` filter only accepts a 0.5-2.0 rate per instance, so a speed outside that
 * range needs to be expressed as a chain of several (e.g. 3x -> atempo=2,atempo=1.5). Always
 * returns at least one factor; a flat `[1]` means "no atempo needed at all".
 */
export function atempoFactors(speed: number): number[] {
  const factors: number[] = []
  let remaining = speed
  while (remaining > 2) {
    factors.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    factors.push(0.5)
    remaining /= 0.5
  }
  factors.push(remaining)
  return factors
}

function hasActiveKeyframes(transform: ClipTransform): boolean {
  return (transform.keyframes?.length ?? 0) >= 2
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
  // is safe here). Every later video track is a free-floating overlay: each clip is scaled
  // to its native-fit size (not stretched to fill the canvas), positioned/scaled/faded per
  // its transform, shifted to its own absolute `start`, and composited with
  // `overlay=...:enable=between(...)` so it appears at the right place regardless of what
  // else is happening on the track. Transitions on overlay tracks are not modeled in export
  // (hard cut) — the Inspector only offers the transition control on the primary track to
  // keep preview/export in agreement.
  const scalePadFor = () =>
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`

  /**
   * Scale+pan/zoom+fade a primary-track clip's already canvas-sized frame around its (possibly
   * keyframed) transform. Geometry: scale the whole canvasW x canvasH frame up by `scale`
   * (never below 1x — a primary-track clip fills the frame, so shrinking it would leave
   * nothing to crop from; below-1x scale on the primary track is a known, narrow limitation,
   * not a crash) using ffmpeg's per-frame `eval=frame` scale when keyframed (empirically
   * verified: scale really does resize every frame, not just at init, and the dimensions
   * propagate correctly into a following `crop`), then `crop` back down to canvasW x canvasH
   * with the crop window's center anchored at the transform's (x,y) — `clip(...)` keeps the
   * crop origin in bounds. Opacity fades the frame toward black (there's nothing "behind" the
   * primary track to blend with — this matches Preview.tsx's black canvas background).
   * No-op (returns `label` unchanged) at the default transform, so untransformed primary-track
   * clips produce byte-identical filter output to before this feature existed.
   */
  function applyCanvasTransform(label: string, clip: MediaClip): string {
    const transform = clip.transform
    const hasKf = hasActiveKeyframes(transform)
    const isDefaultGeometry = !hasKf && transform.x === 0.5 && transform.y === 0.5 && transform.scale === 1
    const isDefaultOpacity = !hasKf && transform.opacity === 1
    if (isDefaultGeometry && isDefaultOpacity) return label

    let out = label

    if (!isDefaultGeometry) {
      const kfs = transform.keyframes!
      const scaleExpr = hasKf ? piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.scale })), 't') : String(transform.scale)
      const xExpr = hasKf ? piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.x })), 't') : String(transform.x)
      const yExpr = hasKf ? piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.y })), 't') : String(transform.y)

      const scaled = nextLabel('zoomscale')
      if (hasKf) {
        filters.push(`[${out}]scale=w='${width}*max(${scaleExpr},1)':h='${height}*max(${scaleExpr},1)':eval=frame[${scaled}]`)
      } else {
        const s = Math.max(transform.scale, 1)
        filters.push(`[${out}]scale=${Math.round(width * s)}:${Math.round(height * s)}[${scaled}]`)
      }
      out = scaled

      const cropped = nextLabel('zoomcrop')
      filters.push(
        `[${out}]crop=${width}:${height}:'clip(iw*(${xExpr})-${width}/2,0,iw-${width})':'clip(ih*(${yExpr})-${height}/2,0,ih-${height})'[${cropped}]`
      )
      out = cropped
    }

    if (!isDefaultOpacity) {
      const kfs = transform.keyframes!
      const opaced = nextLabel('zoomop')
      if (hasKf) {
        const opacityExpr = piecewiseLinearExpr(kfs.map((k) => ({ time: k.time, value: k.opacity })), 'T')
        filters.push(`[${out}]geq=r='r(X,Y)*(${opacityExpr})':g='g(X,Y)*(${opacityExpr})':b='b(X,Y)*(${opacityExpr})'[${opaced}]`)
      } else {
        filters.push(`[${out}]colorchannelmixer=rr=${transform.opacity}:gg=${transform.opacity}:bb=${transform.opacity}[${opaced}]`)
      }
      out = opaced
    }

    return out
  }

  /**
   * Returns one label holding the clip's trimmed, speed-adjusted, (optionally reversed) video,
   * finished per `finish`: 'canvas' scales/pads to fill the full canvas (then applies any
   * primary-track pan/zoom/fade transform) — the primary-track shape; 'native' only normalizes
   * fps/SAR, leaving the clip at its native asset resolution for the caller to position itself
   * (see overlayCompositeLabel) — the overlay-track shape. A flat (no curve) 1x-speed,
   * non-reversed, untransformed 'canvas' clip produces exactly the single trim/setpts/scale
   * chain this did before speed/reverse/transform existed; anything else (a curve, non-1x flat
   * speed, `reversed`, or a non-default transform) assembles the clip from clipSpeedSegments()
   * (one constant-speed trim+setpts per segment, concatenated — always in ascending SOURCE-time
   * order regardless of `reversed`), then applies a single `reverse` filter to the whole
   * assembled (still-forward) result before the finish step — reverse is a final flip, never
   * per-segment, so it composes correctly with any speed curve.
   */
  function trimmedSegmentLabel(clip: MediaClip, asset: MediaAsset, finish: 'canvas' | 'native' = 'canvas'): string {
    const finishFilter = finish === 'native' ? `setsar=1,fps=${fps}` : scalePadFor()
    const base = buildBaseSegment(clip, asset, finishFilter)
    return finish === 'canvas' ? applyCanvasTransform(base, clip) : base
  }

  function buildBaseSegment(clip: MediaClip, asset: MediaAsset, finishFilter: string): string {
    const ref = inputFor(clip.assetId)
    const segLabel = nextLabel('vseg')
    if (asset.kind === 'image') {
      filters.push(`[${ref.index}:v]trim=duration=${clip.duration},${finishFilter},setpts=PTS-STARTPTS[${segLabel}]`)
      return segLabel
    }

    // Frozen clips hold a single source frame (trimIn === trimOut, which would be a
    // zero-length span to clipSpeedSegments below) for the clip's authored `duration` —
    // grab one frame and hold it with `tpad`'s clone mode, no speed/reverse/curve involved.
    if (clip.frozen) {
      const pre = nextLabel('vfreeze')
      filters.push(`[${ref.index}:v]trim=start=${clip.trimIn}:end=${clip.trimIn + 1 / fps},setpts=PTS-STARTPTS,${finishFilter}[${pre}]`)
      const holdDuration = Math.max(clip.duration - 1 / fps, 0)
      filters.push(`[${pre}]tpad=stop_mode=clone:stop_duration=${holdDuration}[${segLabel}]`)
      return segLabel
    }

    const segments = clipSpeedSegments(clip)
    if (segments.length === 1 && !clip.reversed) {
      const seg = segments[0]
      const ptsExpr = seg.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.speed}`
      filters.push(`[${ref.index}:v]trim=start=${seg.start}:end=${seg.end},setpts=${ptsExpr},${finishFilter}[${segLabel}]`)
      return segLabel
    }

    let assembledLabel: string
    if (segments.length === 1) {
      const seg = segments[0]
      const ptsExpr = seg.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.speed}`
      const pre = nextLabel('vpre')
      filters.push(`[${ref.index}:v]trim=start=${seg.start}:end=${seg.end},setpts=${ptsExpr}[${pre}]`)
      assembledLabel = pre
    } else {
      const pieceLabels = segments.map((seg) => {
        const piece = nextLabel('vspeed')
        const ptsExpr = seg.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${seg.speed}`
        filters.push(`[${ref.index}:v]trim=start=${seg.start}:end=${seg.end},setpts=${ptsExpr}[${piece}]`)
        return piece
      })
      const concatLabel = nextLabel('vconcat')
      filters.push(`${pieceLabels.map((l) => `[${l}]`).join('')}concat=n=${pieceLabels.length}:v=1:a=0[${concatLabel}]`)
      assembledLabel = concatLabel
    }

    if (clip.reversed) {
      const revLabel = nextLabel('vrev')
      filters.push(`[${assembledLabel}]reverse[${revLabel}]`)
      assembledLabel = revLabel
    }

    filters.push(`[${assembledLabel}]${finishFilter}[${segLabel}]`)
    return segLabel
  }

  /**
   * Composites one overlay-track clip (its 'native'-finished, already pts-shifted label) onto
   * `baseLabel`, applying its (possibly keyframed) position/scale/opacity, and returns the new
   * combined label. Mirrors what Preview.tsx's drawContain already does: fit the asset's native
   * size within the canvas preserving aspect ratio, multiply by `transform.scale`, center at
   * (transform.x*canvasW, transform.y*canvasH).
   *
   * The position+scale step, and opacity, are deliberately NOT combined into one pre-overlay
   * alpha-compositing pass — every alpha mechanism tried there (colorchannelmixer, geq) either
   * doesn't support a time-varying value at all, or (geq specifically) silently resets a
   * stream's per-frame-varying dimensions if placed before a frame-varying `scale`, breaking
   * keyframed scale (confirmed empirically: the overlay visibly stopped growing once geq sat
   * upstream of it, despite `scale`'s own eval=frame output genuinely differing in size every
   * frame when checked directly). What *is* confirmed to track a dynamically-scaled input
   * correctly, every time it was tested in isolation from geq, is `overlay` itself: its own
   * `x`/`y` expressions can reference the overlay input's live current `w`/`h` with
   * `eval=frame`. So position+scale go through a full-opacity `overlay` first; opacity (when
   * not simply 1) is applied *after*, by blending that fully-composited result back toward the
   * untouched `baseLabel` with a time-varying mix factor — both blend inputs are already
   * constant canvasW x canvasH by that point, so there's no dynamic-sizing interaction left to
   * break.
   */
  function compositeOverlayClip(baseLabel: string, nativeLabel: string, clip: MediaClip, asset: MediaAsset): string {
    const transform = clip.transform
    const hasKf = hasActiveKeyframes(transform)
    const kfs = transform.keyframes
    const nativeW = asset.width || width
    const nativeH = asset.height || height
    const fit = Math.min(width / nativeW, height / nativeH)
    const baseW = Math.max(Math.round(nativeW * fit), 1)
    const baseH = Math.max(Math.round(nativeH * fit), 1)
    const localT = `(t-${clip.start})`

    const scaleExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.scale })), localT) : String(transform.scale)
    const xExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.x })), localT) : String(transform.x)
    const yExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.y })), localT) : String(transform.y)

    let scaledLabel = nativeLabel
    const scaled = nextLabel('ovscale')
    if (hasKf) {
      filters.push(`[${scaledLabel}]scale=w='${baseW}*(${scaleExpr})':h='${baseH}*(${scaleExpr})':eval=frame[${scaled}]`)
    } else {
      const w = Math.max(Math.round(baseW * transform.scale), 1)
      const h = Math.max(Math.round(baseH * transform.scale), 1)
      filters.push(`[${scaledLabel}]scale=${w}:${h}[${scaled}]`)
    }
    scaledLabel = scaled

    const end = clip.start + clip.duration

    if (!hasKf && transform.opacity === 1) {
      // format=auto is required, not cosmetic: verified empirically that overlay's default
      // format mode silently drops blending correctness when the main input comes from
      // `xfade`/`concat` rather than a raw decoded stream.
      const composited = nextLabel('comp')
      filters.push(
        `[${baseLabel}][${scaledLabel}]overlay=x='${width}*(${xExpr})-w/2':y='${height}*(${yExpr})-h/2':eval=frame:format=auto:` +
          `enable='between(t,${clip.start},${end})'[${composited}]`
      )
      return composited
    }

    // Opacity needs `baseLabel` a second time (as the blend's "A" input, see below) — using
    // the same label as input to two different filters silently broke ffmpeg's filtergraph
    // resolution in this build (confirmed empirically: identical graph, swap the implicit
    // reuse for an explicit `split`, and a mystifying "Invalid stream specifier" error from a
    // seemingly unrelated label disappears). `split` is the canonical, always-safe way to fan
    // a label out to multiple consumers — use it instead of relying on implicit reuse again.
    const baseA = nextLabel('base')
    const baseB = nextLabel('base')
    filters.push(`[${baseLabel}]split=2[${baseA}][${baseB}]`)

    const composited = nextLabel('comp')
    filters.push(
      `[${baseA}][${scaledLabel}]overlay=x='${width}*(${xExpr})-w/2':y='${height}*(${yExpr})-h/2':eval=frame:format=auto:` +
        `enable='between(t,${clip.start},${end})'[${composited}]`
    )
    baseLabel = baseB

    const opacityExpr = hasKf ? piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.opacity })), `(T-${clip.start})`) : String(transform.opacity)
    const blended = nextLabel('ovblend')
    filters.push(
      `[${baseLabel}][${composited}]blend=all_expr='A*(1-(${opacityExpr}))+B*(${opacityExpr})':enable='between(t,${clip.start},${end})'[${blended}]`
    )
    return blended
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
      const native = trimmedSegmentLabel(clip, asset, 'native')
      const shifted = nextLabel('vshift')
      filters.push(`[${native}]setpts=PTS+${clip.start}/TB[${shifted}]`)
      videoOutLabel = compositeOverlayClip(videoOutLabel, shifted, clip, asset)
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
      const transform = clip.transform
      const hasKf = hasActiveKeyframes(transform)
      const kfs = transform.keyframes
      const localT = `(t-${start})`

      // Static values keep the exact unquoted format this produced before transform/keyframe
      // support existed (byte-identical filter output at the default transform); keyframed
      // values need the quoting piecewiseLinearExpr's embedded commas require.
      const fontSizeStr = hasKf
        ? `'${clip.fontSize}*(${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.scale })), localT)})'`
        : String(Math.round(clip.fontSize * transform.scale))
      const xStr = hasKf
        ? `'(w-text_w)*(${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.x })), localT)})'`
        : `(w-text_w)*${transform.x}`
      const yStr = hasKf
        ? `'(h-text_h)*(${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.y })), localT)})'`
        : `(h-text_h)*${transform.y}`

      const parts = [`drawtext=text='${escapeDrawtext(clip.text)}'`, `fontcolor=${fontColor}`, `fontsize=${fontSizeStr}`, `x=${xStr}`, `y=${yStr}`]
      if (hasKf || transform.opacity !== 1) {
        const alphaStr = hasKf ? `'${piecewiseLinearExpr(kfs!.map((k) => ({ time: k.time, value: k.opacity })), localT)}'` : String(transform.opacity)
        parts.push(`alpha=${alphaStr}`)
      }
      parts.push(`enable='between(t,${start},${end})'`)

      filters.push(`[${videoOutLabel}]${parts.join(':')}[${out}]`)
      videoOutLabel = out
    }
  }

  // ---- Audio: mix audio-track clips + un-muted video-clip audio ----
  const audioMixLabels: string[] = []

  function addAudioClip(clip: MediaClip, asset: MediaAsset) {
    if (!asset.hasAudio || clip.muted || clip.volume <= 0) return
    const ref = inputFor(clip.assetId)
    const trimmed = nextLabel('atrim')
    const delayMs = Math.round(clip.start * 1000)
    const segments = clipSpeedSegments(clip)

    if (segments.length === 1 && segments[0].speed === 1 && !clip.reversed) {
      filters.push(
        `[${ref.index}:a]atrim=start=${segments[0].start}:end=${segments[0].end},asetpts=PTS-STARTPTS,` +
          `volume=${clip.volume},adelay=${delayMs}|${delayMs}[${trimmed}]`
      )
      audioMixLabels.push(trimmed)
      return
    }

    // atempo only accepts 0.5-2.0 per instance, so each segment's speed may need chaining
    // (see atempoFactors). Segments are assembled first, then volume/adelay applied once to
    // the whole concatenated clip (those don't need to vary per segment).
    const pieceLabels = segments.map((seg) => {
      const piece = nextLabel('aspeed')
      const factors = atempoFactors(seg.speed)
      const tempoChain = factors.length === 1 && factors[0] === 1 ? '' : `,${factors.map((f) => `atempo=${f}`).join(',')}`
      filters.push(`[${ref.index}:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS${tempoChain}[${piece}]`)
      return piece
    })
    let concatLabel =
      pieceLabels.length > 1
        ? (() => {
            const label = nextLabel('aconcat')
            filters.push(`${pieceLabels.map((l) => `[${l}]`).join('')}concat=n=${pieceLabels.length}:v=0:a=1[${label}]`)
            return label
          })()
        : pieceLabels[0]

    // Mirrors trimmedSegmentLabel's video handling: reverse is a final flip applied to the
    // whole assembled (still-forward) clip, not per-segment.
    if (clip.reversed) {
      const revLabel = nextLabel('arev')
      filters.push(`[${concatLabel}]areverse[${revLabel}]`)
      concatLabel = revLabel
    }

    filters.push(`[${concatLabel}]volume=${clip.volume},adelay=${delayMs}|${delayMs}[${trimmed}]`)
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
