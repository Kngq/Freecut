import { useEffect, useRef } from 'react'
import { applyPostEffects, effectGeometry } from '@shared/effects'
import { createEffect, type ClipEffectType, type TransitionType } from '@shared/types'

/** A tiny looping preview canvas that renders a built-in sample frame with ONE effect applied —
 *  so effects can be previewed without a real clip on the timeline. Reuses the exact shared
 *  effect math (effectGeometry + applyPostEffects) the live Preview uses, so what you see here
 *  matches what the effect does on an actual clip. Entirely procedural (no bundled asset). */
export function EffectPreview({ type, size = 72 }: { type: ClipEffectType; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const c: CanvasRenderingContext2D = ctx
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    c.setTransform(dpr, 0, 0, dpr, 0, 0)

    const effect = createEffect(type, 'preview')
    const DURATION = 3 // seconds; effects loop over this window
    let raf = 0
    const start = performance.now()

    function drawSample(g: { scale: number; dx: number; dy: number }) {
      // A recognizable sample frame: colored bands + a face-ish circle so geometry/pixel effects
      // are obvious. Drawn into the geometry transform (scale/offset) from effectGeometry.
      c.save()
      c.translate((g.dx + 0.5) * size, (g.dy + 0.5) * size)
      c.scale(g.scale, g.scale)
      c.translate(-size / 2, -size / 2)
      const bands = ['#ff5a5a', '#ffb14e', '#ffe14e', '#5ad15a', '#4ec3ff', '#6c7bff', '#c86cff']
      const bw = size / bands.length
      bands.forEach((col, i) => {
        c.fillStyle = col
        c.fillRect(i * bw, 0, bw + 1, size)
      })
      c.fillStyle = 'rgba(255,255,255,0.85)'
      c.beginPath()
      c.arc(size / 2, size / 2, size * 0.28, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#1a1a22'
      c.beginPath()
      c.arc(size * 0.42, size * 0.46, size * 0.04, 0, Math.PI * 2)
      c.arc(size * 0.58, size * 0.46, size * 0.04, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }

    function frame(now: number) {
      const localT = ((now - start) / 1000) % DURATION
      c.clearRect(0, 0, size, size)
      c.fillStyle = '#000'
      c.fillRect(0, 0, size, size)
      const geo = effectGeometry([effect], localT, DURATION)
      drawSample(geo)
      applyPostEffects(c, [effect], { x: 0, y: 0, w: size, h: size }, localT)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [type, size])

  return <canvas ref={ref} className="fx-preview-canvas" />
}

/** A looping preview of a TRANSITION between two sample frames. Transitions on export are ffmpeg
 *  xfade filters (no Canvas-2D helper), so this is a faithful JS APPROXIMATION of the common
 *  families (fade/slide/wipe/circle) — enough to communicate what each one does at a glance. */
export function TransitionPreview({ type, size = 72 }: { type: TransitionType; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const c: CanvasRenderingContext2D = ctx
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    c.setTransform(dpr, 0, 0, dpr, 0, 0)

    const PERIOD = 2.2 // seconds for a full A→B→A loop (transition runs over the middle second)
    let raf = 0
    const start = performance.now()

    function drawA() {
      c.fillStyle = '#2b3a67'
      c.fillRect(0, 0, size, size)
      c.fillStyle = '#9fb4ff'
      c.font = `bold ${size * 0.4}px sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText('A', size / 2, size / 2)
    }
    function drawB(clip?: () => void) {
      c.save()
      if (clip) {
        c.beginPath()
        clip()
        c.clip()
      }
      c.fillStyle = '#5a3a2b'
      c.fillRect(0, 0, size, size)
      c.fillStyle = '#ffcf9f'
      c.font = `bold ${size * 0.4}px sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText('B', size / 2, size / 2)
      c.restore()
    }

    function frame(now: number) {
      const tt = ((now - start) / 1000) % PERIOD
      // progress 0..1 over the middle ~1s; A before, B after.
      const p = Math.max(0, Math.min(1, (tt - 0.6) / 1.0))
      c.clearRect(0, 0, size, size)
      drawA()
      if (p <= 0) {
        // all A
      } else if (p >= 1) {
        drawB()
      } else if (type === 'crossfade' || type === 'dissolve' || type === 'dipToBlack' || type === 'dipToWhite' || type === 'zoomIn') {
        if (type === 'dipToBlack' || type === 'dipToWhite') {
          // fade A out to black/white then B in
          c.globalAlpha = 1
          drawB()
          c.globalAlpha = p < 0.5 ? 1 - p * 2 : 0
          drawA()
          c.globalAlpha = Math.abs(p - 0.5) < 0.5 ? 1 - Math.abs(p - 0.5) * 2 : 0
          c.fillStyle = type === 'dipToBlack' ? '#000' : '#fff'
          c.fillRect(0, 0, size, size)
          c.globalAlpha = 1
        } else {
          drawB()
          c.globalAlpha = 1 - p
          drawA()
          c.globalAlpha = 1
        }
      } else if (type.startsWith('slide')) {
        // B slides in from a direction, pushing nothing (overlay)
        const off = (1 - p) * size
        c.save()
        if (type === 'slideLeft') c.translate(off, 0)
        else if (type === 'slideRight') c.translate(-off, 0)
        else if (type === 'slideUp') c.translate(0, off)
        else c.translate(0, -off)
        drawB()
        c.restore()
      } else if (type.startsWith('wipe')) {
        drawB(() => {
          if (type === 'wipeLeft') c.rect(0, 0, size * p, size)
          else if (type === 'wipeRight') c.rect(size * (1 - p), 0, size * p, size)
          else if (type === 'wipeUp') c.rect(0, 0, size, size * p)
          else c.rect(0, size * (1 - p), size, size * p)
        })
      } else if (type === 'circleOpen' || type === 'circleClose') {
        const r = (type === 'circleOpen' ? p : 1 - p) * size * 0.75
        drawB(() => c.arc(size / 2, size / 2, r, 0, Math.PI * 2))
      } else {
        // fallback: crossfade
        drawB()
        c.globalAlpha = 1 - p
        drawA()
        c.globalAlpha = 1
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [type, size])

  return <canvas ref={ref} className="fx-preview-canvas" style={{ width: size, height: size }} />
}
