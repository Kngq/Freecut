import { describe, expect, it } from 'vitest'
import { atempoFactors, buildFfmpegPlan, piecewiseLinearExpr } from './ffmpegGraph'
import { createEffect, defaultTransform, type ClipTransform, type MediaClip, type Project, type TransitionType } from './types'

/** Minimal single-video-track project with two clips, so transitions (which need a preceding
 *  clip) and effects can both be exercised through the real plan builder. */
function twoClipProject(opts: { transition?: TransitionType; effectsOnSecond?: MediaClip['effects']; transformOnSecond?: ClipTransform } = {}): Project {
  const base: Omit<MediaClip, 'id' | 'start'> = {
    kind: 'media',
    trackId: 'v1',
    duration: 4,
    assetId: 'a1',
    trimIn: 0,
    trimOut: 4,
    volume: 1,
    muted: false,
    speed: 1,
    reversed: false,
    frozen: false,
    transform: defaultTransform()
  }
  const clip1: MediaClip = { ...base, id: 'c1', start: 0 }
  const clip2: MediaClip = {
    ...base,
    id: 'c2',
    start: 4,
    transitionIn: opts.transition ? { type: opts.transition, duration: 1 } : undefined,
    effects: opts.effectsOnSecond,
    transform: opts.transformOnSecond ?? defaultTransform()
  }
  return {
    id: 'p',
    name: 'test',
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [{ id: 'v1', type: 'video', name: 'Video 1', clips: [clip1, clip2], muted: false, hidden: false }],
    assets: [{ id: 'a1', path: '/tmp/a.mp4', kind: 'video', name: 'a.mp4', duration: 10, hasAudio: false }],
    createdAt: 0,
    updatedAt: 0
  }
}

describe('buildFfmpegPlan — transitions', () => {
  it('emits the mapped xfade transition name for a new transition type', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transition: 'slideLeft' }))
    expect(plan.filterComplex).toContain('xfade=transition=slideleft')
  })

  it('still emits plain concat when there is no transition', () => {
    const plan = buildFfmpegPlan(twoClipProject())
    expect(plan.filterComplex).toContain('concat=n=2:v=1:a=0')
    expect(plan.filterComplex).not.toContain('xfade')
  })
})

describe('buildFfmpegPlan — effects', () => {
  it('splices an inline effect filter into the clip chain', () => {
    const vignette = createEffect('vignette', 'fx-vig')
    const plan = buildFfmpegPlan(twoClipProject({ effectsOnSecond: [vignette] }))
    expect(plan.filterComplex).toContain('vignette=angle=')
  })

  it('emits a mirror subgraph (split/hflip/hstack) for the mirror effect', () => {
    const mirror = createEffect('mirror', 'fx-mir')
    const plan = buildFfmpegPlan(twoClipProject({ effectsOnSecond: [mirror] }))
    expect(plan.filterComplex).toContain('hflip')
    expect(plan.filterComplex).toContain('hstack')
  })

  it('produces no effect filters when a clip has no effects', () => {
    const plan = buildFfmpegPlan(twoClipProject())
    expect(plan.filterComplex).not.toContain('vignette')
    expect(plan.filterComplex).not.toContain('gblur')
  })
})

describe('buildFfmpegPlan — rotate/flip (mirror)', () => {
  it('emits hflip for a horizontally-flipped clip', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transformOnSecond: { ...defaultTransform(), flipH: true } }))
    expect(plan.filterComplex).toContain('hflip')
  })

  it('emits a rotate filter pinned to the canvas size for a rotated clip', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transformOnSecond: { ...defaultTransform(), rotation: 90 } }))
    expect(plan.filterComplex).toMatch(/rotate=[\d.]+:ow=1080:oh=1920/)
  })

  it('emits both hflip and rotate when a clip is mirrored and rotated', () => {
    const plan = buildFfmpegPlan(twoClipProject({ transformOnSecond: { ...defaultTransform(), rotation: 180, flipH: true } }))
    expect(plan.filterComplex).toContain('hflip')
    expect(plan.filterComplex).toContain('rotate=')
  })

  it('emits neither at the default transform (rotation 0, no flip)', () => {
    const plan = buildFfmpegPlan(twoClipProject())
    expect(plan.filterComplex).not.toContain('hflip')
    expect(plan.filterComplex).not.toContain('rotate=')
  })
})

/** Evaluates the tiny subset of ffmpeg expression syntax `piecewiseLinearExpr` emits
 *  (if/lt + arithmetic) so the generated string can be checked against the same math
 *  `interpolateTransform` does, without needing a real ffmpeg binary. */
function evalExpr(expr: string, t: number): number {
  const scoped = expr.replace(/\bT\b/g, String(t))
  // `if(cond,a,b)` -> `(cond ? a : b)`; everything else is plain JS-safe arithmetic.
  // eslint-disable-next-line no-new-func
  const js = scoped.replace(/if\(/g, '__if(')
  // eslint-disable-next-line no-new-func
  const fn = new Function('lt', '__if', `return ${js}`)
  return fn((a: number, b: number) => a < b, (cond: boolean, a: number, b: number) => (cond ? a : b)) as number
}

describe('piecewiseLinearExpr', () => {
  it('is constant with a single keyframe', () => {
    expect(piecewiseLinearExpr([{ time: 0, value: 5 }], 'T')).toBe('5')
  })

  it('clamps before the first and after the last keyframe', () => {
    const expr = piecewiseLinearExpr(
      [
        { time: 1, value: 0 },
        { time: 3, value: 10 }
      ],
      'T'
    )
    expect(evalExpr(expr, 0)).toBe(0)
    expect(evalExpr(expr, 10)).toBe(10)
  })

  it('linearly interpolates between keyframes, matching interpolateTransform math', () => {
    const expr = piecewiseLinearExpr(
      [
        { time: 0, value: 0 },
        { time: 2, value: 10 }
      ],
      'T'
    )
    expect(evalExpr(expr, 1)).toBeCloseTo(5)
  })

  it('handles more than two keyframes, picking the right segment', () => {
    const expr = piecewiseLinearExpr(
      [
        { time: 0, value: 0 },
        { time: 2, value: 10 },
        { time: 4, value: 0 }
      ],
      'T'
    )
    expect(evalExpr(expr, 1)).toBeCloseTo(5)
    expect(evalExpr(expr, 3)).toBeCloseTo(5)
    expect(evalExpr(expr, 2)).toBeCloseTo(10)
  })
})

describe('atempoFactors', () => {
  function product(factors: number[]): number {
    return factors.reduce((a, b) => a * b, 1)
  }

  it('is a single in-range factor when speed is already in [0.5,2]', () => {
    expect(atempoFactors(1)).toEqual([1])
    expect(atempoFactors(1.5)).toEqual([1.5])
    expect(atempoFactors(0.5)).toEqual([0.5])
    expect(atempoFactors(2)).toEqual([2])
  })

  it('chains factors (each within [0.5,2]) whose product reproduces an out-of-range speed', () => {
    for (const speed of [3, 4, 0.25, 0.1, 8]) {
      const factors = atempoFactors(speed)
      expect(factors.length).toBeGreaterThan(0)
      for (const f of factors) {
        expect(f).toBeGreaterThanOrEqual(0.5)
        expect(f).toBeLessThanOrEqual(2)
      }
      expect(product(factors)).toBeCloseTo(speed, 10)
    }
  })
})
