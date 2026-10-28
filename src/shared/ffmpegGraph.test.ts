import { describe, expect, it } from 'vitest'
import { atempoFactors, piecewiseLinearExpr } from './ffmpegGraph'

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
