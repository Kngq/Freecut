import { describe, expect, it } from 'vitest'
import {
  clipSpeedSegments,
  defaultTransform,
  effectiveDuration,
  interpolateTransform,
  sourceTimeFor,
  type MediaClip
} from './types'

function makeClip(overrides: Partial<MediaClip> = {}): MediaClip {
  return {
    id: 'c',
    kind: 'media',
    trackId: 't',
    start: 0,
    duration: 0,
    assetId: 'a',
    trimIn: 0,
    trimOut: 10,
    volume: 1,
    muted: false,
    speed: 1,
    reversed: false,
    frozen: false,
    transform: defaultTransform(),
    ...overrides
  }
}

describe('effectiveDuration', () => {
  it('equals the trimmed span at 1x speed', () => {
    expect(effectiveDuration(makeClip({ trimIn: 2, trimOut: 7 }))).toBeCloseTo(5)
  })

  it('halves at 2x speed', () => {
    expect(effectiveDuration(makeClip({ trimIn: 0, trimOut: 10, speed: 2 }))).toBeCloseTo(5)
  })

  it('doubles at 0.5x speed', () => {
    expect(effectiveDuration(makeClip({ trimIn: 0, trimOut: 10, speed: 0.5 }))).toBeCloseTo(20)
  })

  it('integrates a piecewise speed curve', () => {
    // [0,5) at 1x = 5s timeline, [5,10) at 2x = 2.5s timeline => 7.5s total
    const clip = makeClip({
      trimIn: 0,
      trimOut: 10,
      speedKeyframes: [
        { time: 0, speed: 1 },
        { time: 5, speed: 2 }
      ]
    })
    expect(effectiveDuration(clip)).toBeCloseTo(7.5)
  })

  it('is authored directly for frozen clips, ignoring trim/speed', () => {
    const clip = makeClip({ trimIn: 3, trimOut: 3, frozen: true, duration: 1.5 })
    expect(effectiveDuration(clip)).toBe(1.5)
  })
})

describe('sourceTimeFor', () => {
  it('maps 1:1 at 1x speed', () => {
    const clip = makeClip({ trimIn: 2, trimOut: 7 })
    expect(sourceTimeFor(clip, 0)).toBeCloseTo(2)
    expect(sourceTimeFor(clip, 2.5)).toBeCloseTo(4.5)
  })

  it('covers twice the source per timeline second at 2x speed', () => {
    const clip = makeClip({ trimIn: 0, trimOut: 10, speed: 2 })
    expect(sourceTimeFor(clip, 1)).toBeCloseTo(2)
    expect(sourceTimeFor(clip, 5)).toBeCloseTo(10)
  })

  it('reverses the mapping when `reversed` is set', () => {
    const clip = makeClip({ trimIn: 0, trimOut: 10, reversed: true })
    expect(sourceTimeFor(clip, 0)).toBeCloseTo(10)
    expect(sourceTimeFor(clip, 10)).toBeCloseTo(0)
  })

  it('walks a speed curve segment by segment', () => {
    const clip = makeClip({
      trimIn: 0,
      trimOut: 10,
      speedKeyframes: [
        { time: 0, speed: 1 },
        { time: 5, speed: 2 }
      ]
    })
    // First 5 timeline seconds cover [0,5) source at 1x.
    expect(sourceTimeFor(clip, 5)).toBeCloseTo(5)
    // Remaining 2.5 timeline seconds cover [5,10) source at 2x.
    expect(sourceTimeFor(clip, 7.5)).toBeCloseTo(10)
    expect(sourceTimeFor(clip, 6.25)).toBeCloseTo(7.5)
  })

  it('always returns trimIn for frozen clips regardless of local time', () => {
    const clip = makeClip({ trimIn: 4, trimOut: 4, frozen: true, duration: 2 })
    expect(sourceTimeFor(clip, 0)).toBe(4)
    expect(sourceTimeFor(clip, 1.9)).toBe(4)
  })
})

describe('clipSpeedSegments', () => {
  it('returns a single flat-speed segment with no curve', () => {
    const segs = clipSpeedSegments(makeClip({ trimIn: 0, trimOut: 10, speed: 1.5 }))
    expect(segs).toEqual([{ start: 0, end: 10, speed: 1.5 }])
  })

  it('splits at interior keyframe boundaries, extending to trimIn/trimOut', () => {
    const segs = clipSpeedSegments(
      makeClip({
        trimIn: 0,
        trimOut: 10,
        speedKeyframes: [
          { time: 2, speed: 1 },
          { time: 6, speed: 3 }
        ]
      })
    )
    expect(segs).toEqual([
      { start: 0, end: 2, speed: 1 },
      { start: 2, end: 6, speed: 1 },
      { start: 6, end: 10, speed: 3 }
    ])
  })
})

describe('interpolateTransform', () => {
  it('returns the static values with no keyframes', () => {
    const t = { x: 0.3, y: 0.7, scale: 1.2, opacity: 0.8 }
    expect(interpolateTransform(t, 5)).toEqual({ x: 0.3, y: 0.7, scale: 1.2, opacity: 0.8 })
  })

  it('clamps before the first and after the last keyframe', () => {
    const t = {
      ...defaultTransform(),
      keyframes: [
        { time: 1, x: 0, y: 0, scale: 1, opacity: 1 },
        { time: 3, x: 1, y: 1, scale: 2, opacity: 0 }
      ]
    }
    expect(interpolateTransform(t, 0)).toEqual({ x: 0, y: 0, scale: 1, opacity: 1 })
    expect(interpolateTransform(t, 10)).toEqual({ x: 1, y: 1, scale: 2, opacity: 0 })
  })

  it('linearly interpolates between two keyframes', () => {
    const t = {
      ...defaultTransform(),
      keyframes: [
        { time: 0, x: 0, y: 0, scale: 1, opacity: 1 },
        { time: 2, x: 1, y: 1, scale: 2, opacity: 0 }
      ]
    }
    expect(interpolateTransform(t, 1)).toEqual({ x: 0.5, y: 0.5, scale: 1.5, opacity: 0.5 })
  })
})
