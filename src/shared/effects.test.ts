import { describe, expect, it } from 'vitest'
import {
  createEffect,
  effectCatalogEntry,
  effectParam,
  shakeWave,
  EFFECT_CATALOG,
  TRANSITION_CATALOG,
  type ClipEffect,
  type TransitionType
} from './types'
import {
  effectGeometry,
  effectNeedsSubgraph,
  effectToFfmpegFilters,
  flashMultiplier,
  isGeometryEffect,
  mirrorSubgraph,
  transitionToXfade
} from './effects'

describe('shakeWave', () => {
  it('is deterministic for a given (t, seed, freq, phase)', () => {
    const a = shakeWave(1.234, 7, 5, 0)
    const b = shakeWave(1.234, 7, 5, 0)
    expect(a).toBe(b)
  })

  it('stays within roughly [-1, 1]', () => {
    for (let i = 0; i < 2000; i++) {
      const t = i / 100
      const v = shakeWave(t, 42, 6, 1.7)
      expect(v).toBeGreaterThanOrEqual(-1.0001)
      expect(v).toBeLessThanOrEqual(1.0001)
    }
  })

  it('different seeds produce different waveforms', () => {
    const s1 = shakeWave(0.5, 1, 5, 0)
    const s2 = shakeWave(0.5, 50, 5, 0)
    expect(s1).not.toBe(s2)
  })

  it('x and y phases decorrelate the axes', () => {
    const x = shakeWave(0.5, 7, 5, 0)
    const y = shakeWave(0.5, 7, 5, 1.7)
    expect(x).not.toBe(y)
  })
})

describe('effect catalog + helpers', () => {
  it('every catalog entry has at least one param with a default in range', () => {
    for (const entry of EFFECT_CATALOG) {
      expect(entry.params.length).toBeGreaterThan(0)
      for (const p of entry.params) {
        expect(p.default).toBeGreaterThanOrEqual(p.min)
        expect(p.default).toBeLessThanOrEqual(p.max)
      }
    }
  })

  it('createEffect fills in catalog defaults', () => {
    const e = createEffect('shake', 'fixed-id')
    expect(e.id).toBe('fixed-id')
    expect(e.type).toBe('shake')
    const entry = effectCatalogEntry('shake')!
    for (const p of entry.params) expect(e.params[p.key]).toBe(p.default)
  })

  it('effectParam falls back to the catalog default when a param is missing', () => {
    const e: ClipEffect = { id: 'x', type: 'vignette', params: {} }
    expect(effectParam(e, 'intensity')).toBe(effectCatalogEntry('vignette')!.params[0].default)
  })

  it('isGeometryEffect flags only shake and kenBurns', () => {
    expect(isGeometryEffect('shake')).toBe(true)
    expect(isGeometryEffect('kenBurns')).toBe(true)
    expect(isGeometryEffect('blur')).toBe(false)
    expect(isGeometryEffect('vignette')).toBe(false)
  })
})

describe('effectGeometry', () => {
  it('is identity with no effects', () => {
    expect(effectGeometry(undefined, 1, 5)).toEqual({ scale: 1, dx: 0, dy: 0 })
    expect(effectGeometry([], 1, 5)).toEqual({ scale: 1, dx: 0, dy: 0 })
  })

  it('ken burns zoom-in ramps scale from 1 to 1+intensity across the clip', () => {
    const e = createEffect('kenBurns', 'kb')
    e.params.intensity = 0.2
    e.params.direction = 0 // zoom in
    expect(effectGeometry([e], 0, 5).scale).toBeCloseTo(1, 5)
    expect(effectGeometry([e], 5, 5).scale).toBeCloseTo(1.2, 5)
    expect(effectGeometry([e], 2.5, 5).scale).toBeCloseTo(1.1, 5)
  })

  it('ken burns zoom-out ramps scale from 1+intensity down to 1', () => {
    const e = createEffect('kenBurns', 'kb')
    e.params.intensity = 0.2
    e.params.direction = 1 // zoom out
    expect(effectGeometry([e], 0, 5).scale).toBeCloseTo(1.2, 5)
    expect(effectGeometry([e], 5, 5).scale).toBeCloseTo(1, 5)
  })

  it('shake over-scales (>1) and offsets both axes', () => {
    const e = createEffect('shake', 'sh')
    e.params.intensity = 0.5
    const geo = effectGeometry([e], 0.3, 5)
    expect(geo.scale).toBeGreaterThan(1)
    // at least one axis is displaced
    expect(Math.abs(geo.dx) + Math.abs(geo.dy)).toBeGreaterThan(0)
  })
})

describe('flashMultiplier', () => {
  it('is >1 during the first half of each strobe cycle and 1 in the second half', () => {
    // speed 2 Hz: cycle = 0.5s; first quarter-second bright, next dark.
    expect(flashMultiplier(0.6, 2, 0.1)).toBeCloseTo(1.6, 5)
    expect(flashMultiplier(0.6, 2, 0.4)).toBeCloseTo(1, 5)
  })
})

describe('effectToFfmpegFilters', () => {
  it('maps blur to gblur with a sigma scaling with intensity', () => {
    const e = createEffect('blur', 'b')
    e.params.intensity = 0.5
    const out = effectToFfmpegFilters(e, 1080, 1920, 30)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^gblur=sigma=/)
  })

  it('blur with zero intensity emits no filter', () => {
    const e = createEffect('blur', 'b')
    e.params.intensity = 0
    expect(effectToFfmpegFilters(e, 1080, 1920, 30)).toEqual([])
  })

  it('maps black & white to a hue desaturate', () => {
    const e = createEffect('blackWhite', 'bw')
    e.params.intensity = 1
    expect(effectToFfmpegFilters(e, 1080, 1920, 30)).toEqual(['hue=s=0.000'])
  })

  it('maps vignette to the vignette filter with an angle', () => {
    const e = createEffect('vignette', 'v')
    const out = effectToFfmpegFilters(e, 1080, 1920, 30)
    expect(out[0]).toMatch(/^vignette=angle=/)
  })

  it('grain emits hue desaturate and/or noise depending on params', () => {
    const e = createEffect('grain', 'g')
    e.params.desaturate = 0.5
    e.params.intensity = 0.5
    const out = effectToFfmpegFilters(e, 1080, 1920, 30)
    expect(out.some((f) => f.startsWith('hue=s='))).toBe(true)
    expect(out.some((f) => f.startsWith('noise='))).toBe(true)
  })

  it('shake emits a scale+crop pair with per-frame eval on the scale', () => {
    const e = createEffect('shake', 's')
    const out = effectToFfmpegFilters(e, 1080, 1920, 30)
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('scale=')
    expect(out[0]).toContain('eval=frame')
    expect(out[1]).toContain('crop=')
    // crop has no `eval` option in ffmpeg; its x/y expressions (which reference `t`) are
    // evaluated per-frame natively, so we must NOT emit eval=frame on crop.
    expect(out[1]).not.toContain('eval=frame')
  })

  it('kenBurns emits a scale+crop pair', () => {
    const e = createEffect('kenBurns', 'kb')
    const out = effectToFfmpegFilters(e, 1080, 1920, 30)
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('scale=')
    expect(out[1]).toContain('crop=')
  })

  it('mirror produces no inline filters (it needs a subgraph)', () => {
    const e = createEffect('mirror', 'm')
    expect(effectToFfmpegFilters(e, 1080, 1920, 30)).toEqual([])
    expect(effectNeedsSubgraph(e)).toBe(true)
  })
})

describe('mirrorSubgraph', () => {
  it('builds a crop/split/hflip/hstack chain wired through the given labels', () => {
    const e = createEffect('mirror', 'm')
    e.params.side = 0 // keep left, mirror onto right
    const lines = mirrorSubgraph(e, 1080, 1920, 'in0', 'out0', { a: 'a0', b: 'b0', flipped: 'f0' })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('[in0]crop=540:1920:0:0,split[a0][b0]')
    expect(lines[1]).toBe('[b0]hflip[f0]')
    expect(lines[2]).toBe('[a0][f0]hstack[out0]')
  })

  it('mirrors the right half when side=1', () => {
    const e = createEffect('mirror', 'm')
    e.params.side = 1
    const lines = mirrorSubgraph(e, 1080, 1920, 'in0', 'out0', { a: 'a0', b: 'b0', flipped: 'f0' })
    expect(lines[0]).toContain('crop=540:1920:540:0')
    expect(lines[2]).toBe('[f0][b0]hstack[out0]')
  })
})

describe('transitionToXfade', () => {
  it('maps the legacy types for backward compatibility', () => {
    expect(transitionToXfade('crossfade')).toBe('fade')
    expect(transitionToXfade('dipToBlack')).toBe('fadeblack')
  })

  it('maps every catalog transition to a non-empty xfade name', () => {
    for (const t of TRANSITION_CATALOG) {
      const name = transitionToXfade(t.type)
      expect(typeof name).toBe('string')
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it('maps the new directional/wipe/zoom types to their xfade equivalents', () => {
    const cases: [TransitionType, string][] = [
      ['dipToWhite', 'fadewhite'],
      ['dissolve', 'dissolve'],
      ['slideLeft', 'slideleft'],
      ['slideRight', 'slideright'],
      ['slideUp', 'slideup'],
      ['slideDown', 'slidedown'],
      ['wipeLeft', 'wipeleft'],
      ['wipeRight', 'wiperight'],
      ['zoomIn', 'zoomin'],
      ['circleOpen', 'circleopen'],
      ['circleClose', 'circleclose']
    ]
    for (const [type, expected] of cases) expect(transitionToXfade(type)).toBe(expected)
  })

  it('falls back to fade for an unknown type', () => {
    expect(transitionToXfade('nonsense')).toBe('fade')
  })
})
