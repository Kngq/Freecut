/**
 * Shared effect rendering, split into halves so the live preview (Canvas 2D) and the exporter
 * (ffmpeg filter graph) stay in agreement:
 *
 *  - `effectGeometry()` — geometry-only effects (shake, Ken Burns). They move/scale the whole
 *    frame, so the preview folds them into its `drawImage` transform *before* pixels land on
 *    the canvas, and the exporter folds them into scale/crop expressions. Pure.
 *
 *  - `applyPostEffects()` — pixel effects (blur, vignette, grain, B&W, flash, mirror). They
 *    operate on an already-drawn frame, so the preview applies them to the canvas region after
 *    `drawImage`. Touches a CanvasRenderingContext2D, so it's preview-only.
 *
 *  - `effectToFfmpegFilters()` — the export mirror: each effect -> ffmpeg filter string(s) to
 *    splice into the clip's filter chain. Pure, string-only, unit-testable.
 *
 * See docs/capcut-effects-reimplementation.md for what each effect approximates in CapCut.
 */
import { effectParam, shakeWave, type ClipEffect, type ClipEffectType } from './types'

/** Which effects change frame geometry (handled before the pixels are drawn) vs. post-process
 *  pixel passes. Keeps preview + export from double-applying or missing one. */
export function isGeometryEffect(type: ClipEffectType): boolean {
  return type === 'shake' || type === 'kenBurns'
}

export interface FrameGeometry {
  /** Extra scale multiplier (1 = none). Ken Burns zoom and shake's safety over-scale land here. */
  scale: number
  /** Normalized center offset added to the clip's transform x/y (fraction of width/height). */
  dx: number
  dy: number
}

/**
 * Accumulates the geometry contribution of a clip's effects at a clip-local time. Shake adds a
 * seeded per-axis offset (plus a slight safety over-scale so the shaken frame never reveals an
 * edge). Ken Burns ramps scale linearly across the clip (zoom in or out). `clipDuration` drives
 * Ken Burns' linear ramp; pass the clip's effective timeline duration.
 */
export function effectGeometry(effects: ClipEffect[] | undefined, localT: number, clipDuration: number): FrameGeometry {
  const geo: FrameGeometry = { scale: 1, dx: 0, dy: 0 }
  if (!effects) return geo
  for (const e of effects) {
    if (e.type === 'shake') {
      const intensity = effectParam(e, 'intensity')
      const speed = effectParam(e, 'speed')
      const seed = Math.round(effectParam(e, 'seed'))
      const freq = 2 + speed * 10 // 2..12 Hz
      const amp = intensity * 0.06 // up to 6% of frame per axis
      geo.dx += shakeWave(localT, seed, freq, 0) * amp
      geo.dy += shakeWave(localT, seed, freq, 1.7) * amp
      // Over-scale by 2*amp so the ±amp offset on each axis never reveals an edge: the margin
      // on each side is (scale-1)/2 of the frame, which must be >= amp.
      geo.scale *= 1 + 2 * amp
    } else if (e.type === 'kenBurns') {
      const intensity = effectParam(e, 'intensity')
      const out = effectParam(e, 'direction') >= 0.5
      const p = clipDuration > 0 ? Math.min(Math.max(localT / clipDuration, 0), 1) : 0
      // Zoom in: 1 -> 1+intensity. Zoom out: 1+intensity -> 1.
      geo.scale *= out ? 1 + intensity * (1 - p) : 1 + intensity * p
    }
  }
  return geo
}

/** Normalized flash/strobe multiplier at a given time: a square-wave exposure pulse. 1 = no
 *  change; >1 brightens. Shared conceptually with export's brightness expression. */
export function flashMultiplier(intensity: number, speedHz: number, t: number): number {
  // Bright for the first half of each cycle. Overdrive exposure rather than mixing to pure
  // white, so detail survives (per the doc's effect #4 note).
  const phase = (t * speedHz) % 1
  const on = phase < 0.5 ? 1 : 0
  return 1 + intensity * on
}

/**
 * Applies the pixel/post-process effects of a clip to the canvas region [x,y,w,h], after the
 * media frame has already been drawn there. Preview-only (needs a 2D context). Geometry
 * effects (shake/Ken Burns) are intentionally skipped — the caller folds those into the draw
 * transform via effectGeometry().
 */
export function applyPostEffects(
  ctx: CanvasRenderingContext2D,
  effects: ClipEffect[] | undefined,
  rect: { x: number; y: number; w: number; h: number },
  localT: number
): void {
  if (!effects || effects.length === 0) return
  const { x, y, w, h } = rect
  for (const e of effects) {
    if (isGeometryEffect(e.type)) continue
    switch (e.type) {
      case 'blur': {
        const px = effectParam(e, 'intensity') * 24
        if (px <= 0) break
        ctx.save()
        ctx.filter = `blur(${px}px)`
        ctx.drawImage(ctx.canvas, x, y, w, h, x, y, w, h)
        ctx.restore()
        break
      }
      case 'blackWhite': {
        const amount = effectParam(e, 'intensity')
        ctx.save()
        ctx.globalAlpha = amount
        ctx.globalCompositeOperation = 'saturation'
        ctx.fillStyle = 'hsl(0,0%,50%)'
        ctx.fillRect(x, y, w, h)
        ctx.restore()
        break
      }
      case 'grain': {
        const desat = effectParam(e, 'desaturate')
        if (desat > 0) {
          ctx.save()
          ctx.globalAlpha = desat
          ctx.globalCompositeOperation = 'saturation'
          ctx.fillStyle = 'hsl(0,0%,50%)'
          ctx.fillRect(x, y, w, h)
          ctx.restore()
        }
        const grain = effectParam(e, 'intensity')
        if (grain > 0) {
          ctx.save()
          const count = Math.floor(((w * h) / 900) * grain)
          for (let i = 0; i < count; i++) {
            const gx = x + Math.random() * w
            const gy = y + Math.random() * h
            const v = Math.random() < 0.5 ? 0 : 255
            ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + grain * 0.2})`
            ctx.fillRect(gx, gy, 1.5, 1.5)
          }
          ctx.restore()
        }
        break
      }
      case 'vignette': {
        const strength = effectParam(e, 'intensity')
        if (strength <= 0) break
        ctx.save()
        const cx = x + w / 2
        const cy = y + h / 2
        const outer = Math.hypot(w, h) / 2
        const grad = ctx.createRadialGradient(cx, cy, outer * 0.45, cx, cy, outer)
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(1, `rgba(0,0,0,${strength})`)
        ctx.fillStyle = grad
        ctx.fillRect(x, y, w, h)
        ctx.restore()
        break
      }
      case 'flash': {
        const m = flashMultiplier(effectParam(e, 'intensity'), effectParam(e, 'speed'), localT)
        if (m <= 1) break
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = Math.min(m - 1, 1)
        ctx.fillStyle = 'white'
        ctx.fillRect(x, y, w, h)
        ctx.restore()
        break
      }
      case 'mirror': {
        const right = effectParam(e, 'side') >= 0.5
        const half = w / 2
        ctx.save()
        if (right) {
          // mirror the right half onto the left
          ctx.translate(x, y)
          ctx.scale(-1, 1)
          ctx.drawImage(ctx.canvas, x + half, y, half, h, -half, 0, half, h)
        } else {
          // mirror the left half onto the right
          ctx.translate(x + w, y)
          ctx.scale(-1, 1)
          ctx.drawImage(ctx.canvas, x, y, half, h, 0, 0, half, h)
        }
        ctx.restore()
        break
      }
    }
  }
}

/**
 * Export mirror of the effect stack: maps one effect to the ffmpeg filter string(s) that
 * approximate it, applied to the clip's already-canvas-sized frame. Returns an ordered list of
 * filters (no input/output labels — the caller chains them with commas). Geometry effects
 * (shake/Ken Burns) are returned here too as scale/crop with per-frame `t` expressions, since
 * ffmpeg has no separate pre-draw transform stage.
 *
 * @param w,h  canvas dimensions (for crop geometry)
 * @param _fps project fps (reserved; not currently needed)
 */
export function effectToFfmpegFilters(effect: ClipEffect, w: number, h: number, _fps: number): string[] {
  switch (effect.type) {
    case 'kenBurns': {
      const intensity = effectParam(effect, 'intensity')
      const out = effectParam(effect, 'direction') >= 0.5
      // We don't know the clip duration here, so approximate the ramp over a fixed 5s window
      // (typical clip length), clamped. Preview is exact; this is a best-effort export match.
      const start = out ? 1 + intensity : 1
      const end = out ? 1 : 1 + intensity
      const zoomExpr = `(${start}+(${end}-${start})*min(t/5\\,1))`
      return [`scale=w='${w}*${zoomExpr}':h='${h}*${zoomExpr}':eval=frame`, `crop=${w}:${h}:'(iw-${w})/2':'(ih-${h})/2'`]
    }
    case 'shake': {
      const intensity = effectParam(effect, 'intensity')
      const speed = effectParam(effect, 'speed')
      const seed = Math.round(effectParam(effect, 'seed'))
      const freq = 2 + speed * 10
      const amp = intensity * 0.06
      const over = 1 + 2 * amp // margin on each side is (over-1)/2 >= amp, covering the offset
      const s = seed % 97
      // Reproduce shakeWave() as an ffmpeg expression in `t`. 2*PI == 6.28318.
      const wave = (phase: number) =>
        `(0.6*sin(6.28318*t*${freq}+${phase})+0.4*(0.5*sin(6.28318*t*${freq * 2}+${phase}+${s % 7})+0.32*sin(6.28318*t*${freq * 3}+${phase}+${s % 11})+0.18*sin(6.28318*t*${freq * 5}+${phase}+${s % 13})))`
      const dx = `(${wave(0)})*${amp}*${w}`
      const dy = `(${wave(1.7)})*${amp}*${h}`
      // Clamp the crop origin into [0, iw-w]/[0, ih-h] so a rounding mismatch on the scaled
      // size can never push the window out of bounds (ffmpeg errors on an off-frame crop).
      return [
        `scale=w='${w}*${over}':h='${h}*${over}':eval=frame`,
        `crop=${w}:${h}:'clip((iw-${w})/2+(${dx})\\,0\\,iw-${w})':'clip((ih-${h})/2+(${dy})\\,0\\,ih-${h})'`
      ]
    }
    case 'blur': {
      const sigma = effectParam(effect, 'intensity') * 20
      if (sigma <= 0) return []
      return [`gblur=sigma=${sigma.toFixed(3)}`]
    }
    case 'vignette': {
      const angle = (effectParam(effect, 'intensity') * Math.PI) / 2
      return [`vignette=angle=${angle.toFixed(4)}`]
    }
    case 'grain': {
      const filters: string[] = []
      const desat = effectParam(effect, 'desaturate')
      if (desat > 0) filters.push(`hue=s=${(1 - desat).toFixed(3)}`)
      const grain = effectParam(effect, 'intensity')
      if (grain > 0) filters.push(`noise=alls=${Math.round(grain * 40)}:allf=t`)
      return filters
    }
    case 'blackWhite': {
      const amount = effectParam(effect, 'intensity')
      return [`hue=s=${(1 - amount).toFixed(3)}`]
    }
    case 'flash': {
      const intensity = effectParam(effect, 'intensity')
      const speedHz = effectParam(effect, 'speed')
      // Square-wave exposure boost matching flashMultiplier(): bright for first half of cycle.
      const mult = `${intensity}*if(lt(mod(t*${speedHz}\\,1)\\,0.5)\\,1\\,0)`
      return [`eq=brightness='${mult}'`]
    }
    case 'mirror': {
      // A whole-frame horizontal mirror-fold needs a split/hflip/hstack subgraph, which carries
      // its own internal labels and can't be comma-chained inline. The graph builder handles
      // this specially via mirrorSubgraph(); emitting nothing here keeps the inline chain valid.
      return []
    }
    default:
      return []
  }
}

/** True for effects whose export form is a labeled subgraph (not a comma-joinable inline
 *  filter) — currently only mirror. The graph builder routes these through mirrorSubgraph(). */
export function effectNeedsSubgraph(effect: ClipEffect): boolean {
  return effect.type === 'mirror'
}

/**
 * Emits the ffmpeg filtergraph lines for a horizontal mirror-fold of `inLabel` into `outLabel`,
 * using caller-provided intermediate labels. Folds one half of the frame onto the other:
 * side 0 mirrors the left half onto the right, side 1 mirrors the right half onto the left.
 */
export function mirrorSubgraph(
  effect: ClipEffect,
  w: number,
  h: number,
  inLabel: string,
  outLabel: string,
  intermediate: { a: string; b: string; flipped: string }
): string[] {
  const right = effectParam(effect, 'side') >= 0.5
  const halfW = Math.floor(w / 2)
  const { a, b, flipped } = intermediate
  if (right) {
    // Keep the right half; mirror it onto the left.
    return [
      `[${inLabel}]crop=${w - halfW}:${h}:${halfW}:0,split[${a}][${b}]`,
      `[${a}]hflip[${flipped}]`,
      `[${flipped}][${b}]hstack[${outLabel}]`
    ]
  }
  // Keep the left half; mirror it onto the right.
  return [
    `[${inLabel}]crop=${halfW}:${h}:0:0,split[${a}][${b}]`,
    `[${b}]hflip[${flipped}]`,
    `[${a}][${flipped}]hstack[${outLabel}]`
  ]
}

/**
 * Maps a TransitionType to the ffmpeg `xfade=transition=<name>` identifier. See
 * docs/capcut-effects-reimplementation.md.
 */
export function transitionToXfade(type: string): string {
  switch (type) {
    case 'crossfade':
      return 'fade'
    case 'dipToBlack':
      return 'fadeblack'
    case 'dipToWhite':
      return 'fadewhite'
    case 'dissolve':
      return 'dissolve'
    case 'slideLeft':
      return 'slideleft'
    case 'slideRight':
      return 'slideright'
    case 'slideUp':
      return 'slideup'
    case 'slideDown':
      return 'slidedown'
    case 'wipeLeft':
      return 'wipeleft'
    case 'wipeRight':
      return 'wiperight'
    case 'wipeUp':
      return 'wipeup'
    case 'wipeDown':
      return 'wipedown'
    case 'zoomIn':
      return 'zoomin'
    case 'circleOpen':
      return 'circleopen'
    case 'circleClose':
      return 'circleclose'
    default:
      return 'fade'
  }
}
