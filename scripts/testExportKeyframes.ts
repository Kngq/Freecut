import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip, type Clip } from '../src/shared/types'

const WORKDIR = process.env.FREECUT_TEST_DIR || '/private/tmp/claude-501/-Users-kng-projects-freecut/993c10e2-d160-482e-8f31-fca3d9b87e21/scratchpad/export-test-keyframes'
fs.mkdirSync(WORKDIR, { recursive: true })

function run(args: string[], label: string) {
  console.log(`\n$ ffmpeg ${args.join(' ')}`)
  const res = spawnSync(ffmpegPath as string, args, { encoding: 'utf-8' })
  if (res.status !== 0) {
    console.error(`FAILED (${label}):\n`, res.stderr?.split('\n').slice(-30).join('\n'))
    process.exit(1)
  }
  console.log(`OK (${label})`)
}

function samplePixel(file: string, x: number, y: number, atSeconds: number): [number, number, number] {
  const png = path.join(WORKDIR, `sample-${x}-${y}-${atSeconds}.png`)
  const res = spawnSync(ffmpegPath as string, ['-y', '-i', file, '-ss', String(atSeconds), '-update', '1', '-frames:v', '1', png], { encoding: 'utf-8' })
  if (res.status !== 0) throw new Error(`frame extraction failed: ${res.stderr}`)
  const raw = spawnSync(ffmpegPath as string, ['-y', '-i', png, '-vf', `crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  if (raw.status !== 0 || !raw.stdout) throw new Error(`pixel sample failed: ${raw.stderr?.toString()}`)
  return [raw.stdout[0], raw.stdout[1], raw.stdout[2]]
}

// ---- Synthesize test media ----
const source = path.join(WORKDIR, 'source.mp4')
const badge = path.join(WORKDIR, 'badge.png')
run(
  ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', source],
  'generate source'
)
run(['-y', '-f', 'lavfi', '-i', 'color=c=lime:size=100x100', '-frames:v', '1', badge], 'generate badge.png')

const project = createEmptyProject('export-keyframes-smoke-test')
project.canvas = { width: 320, height: 240, fps: 30 }

const sourceAsset: MediaAsset = { id: 'src', path: source, kind: 'video', name: 'source.mp4', duration: 6, width: 320, height: 240, hasAudio: true }
const badgeAsset: MediaAsset = { id: 'badge', path: badge, kind: 'image', name: 'badge.png', duration: 0, width: 100, height: 100, hasAudio: false }
project.assets = [sourceAsset, badgeAsset]

const videoTrack = project.tracks.find((t) => t.type === 'video')!
const textTrack = project.tracks.find((t) => t.type === 'text')!
const mediaDefaults = { speed: 1, reversed: false, frozen: false } as const

// ---- (a) Primary track: one clip with a STATIC non-default transform (scale 1.5x, shifted
// ---- right) and one with a KEYFRAMED scale (zoom from 1x to 2x) — the trickiest path, since
// ---- it needs ffmpeg's `scale` filter to genuinely resize every frame (verified empirically
// ---- during development: it does, via eval=frame, as long as nothing non-size-aware like geq
// ---- sits between it and the following `crop`).
const staticZoomClip: MediaClip = {
  id: 'staticzoom',
  kind: 'media',
  trackId: videoTrack.id,
  start: 0,
  duration: 3,
  assetId: 'src',
  trimIn: 0,
  trimOut: 3,
  volume: 0,
  muted: true,
  transform: { x: 0.7, y: 0.5, scale: 1.5, opacity: 1 },
  ...mediaDefaults
}
const keyframedZoomClip: MediaClip = {
  id: 'kfzoom',
  kind: 'media',
  trackId: videoTrack.id,
  start: 3,
  duration: 3,
  assetId: 'src',
  trimIn: 3,
  trimOut: 6,
  volume: 0,
  muted: true,
  transform: {
    ...defaultTransform(),
    keyframes: [
      { time: 0, x: 0.5, y: 0.5, scale: 1, opacity: 1 },
      { time: 3, x: 0.5, y: 0.5, scale: 2.5, opacity: 1 }
    ]
  },
  ...mediaDefaults
}
videoTrack.clips = [staticZoomClip, keyframedZoomClip]

// ---- (b) Overlay track: a badge that fades in while moving from the top-left toward center
// ---- and growing — exercises keyframed x/y/scale/opacity together on the overlay path.
const overlayTrack = { ...videoTrack, id: 'overlay-track', name: 'Video 2', clips: [] as Clip[] }
const overlayClip: MediaClip = {
  id: 'overlayclip',
  kind: 'media',
  trackId: overlayTrack.id,
  start: 0,
  duration: 6,
  assetId: 'badge',
  trimIn: 0,
  trimOut: 6,
  volume: 0,
  muted: true,
  transform: {
    ...defaultTransform(),
    keyframes: [
      { time: 0, x: 0.1, y: 0.1, scale: 0.15, opacity: 0 },
      { time: 2, x: 0.5, y: 0.5, scale: 0.3, opacity: 1 }
    ]
  },
  ...mediaDefaults
}
overlayTrack.clips = [overlayClip]
project.tracks.push(overlayTrack)

// ---- (c) Text clip: keyframed opacity fade in/out ----
const textClip: Clip = {
  id: 'textclip',
  kind: 'text',
  trackId: textTrack.id,
  start: 0,
  duration: 6,
  text: 'KEYFRAMED',
  fontSize: 32,
  color: 'white',
  bold: true,
  transform: {
    ...defaultTransform(),
    keyframes: [
      { time: 0, x: 0.5, y: 0.5, scale: 1, opacity: 0 },
      { time: 1, x: 0.5, y: 0.5, scale: 1, opacity: 1 },
      { time: 5, x: 0.5, y: 0.5, scale: 1, opacity: 1 },
      { time: 6, x: 0.5, y: 0.5, scale: 1, opacity: 0 }
    ]
  }
}
textTrack.clips = [textClip]

// ---- Build + run the real export plan ----
const plan = buildFfmpegPlan(project)
console.log('\nfilter_complex:\n', plan.filterComplex)

const outputPath = path.join(WORKDIR, 'output.mp4')
const args = planToFfmpegArgs(plan, outputPath)
run(args, 'export project')

const probe = spawnSync(ffmpegPath as string, ['-i', outputPath], { encoding: 'utf-8' })
const match = probe.stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
if (!match) throw new Error('could not parse output duration from ffmpeg probe')
const [, h, m, s] = match
const actualDuration = Number(h) * 3600 + Number(m) * 60 + Number(s)
console.log(`\nactual output duration: ${actualDuration}s (expected ~6s)`)
if (Math.abs(actualDuration - 6) > 0.2) throw new Error(`output duration ${actualDuration}s is too far from expected 6s`)

// ---- Pixel checks ----
// (a) Keyframed primary-track zoom: sample a fixed canvas pixel near the edge of the pattern
// at the start of kfzoom (scale 1x, t=3.1s) vs well into it (scale ~2x, t=5.9s). A genuine
// per-frame zoom should shift which part of the source lands on that fixed pixel, changing
// its color; a stuck-at-init-scale bug would show the same color both times.
const earlyZoom = samplePixel(outputPath, 300, 20, 3.1)
const lateZoom = samplePixel(outputPath, 300, 20, 5.9)
console.log(`\nprimary-track keyframed zoom: early ${earlyZoom}, late ${lateZoom} (expect different)`)
if (earlyZoom.every((v, i) => v === lateZoom[i])) {
  throw new Error('primary-track keyframed zoom did not change the frame over time — scale may be stuck at its initial value')
}

// (b) Overlay fade-in: should be invisible (background only) at t=0, visible (lime-ish) by t=2.
const beforeFade = samplePixel(outputPath, 160, 120, 0.05)
const afterFade = samplePixel(outputPath, 160, 120, 2.5)
const isLimeish = (rgb: [number, number, number]) => rgb[1] > 150 && rgb[0] < 150
console.log(`\noverlay fade-in: before ${beforeFade}, after ${afterFade} (expect after to be lime-ish)`)
if (!isLimeish(afterFade)) throw new Error(`expected a lime-ish overlay pixel at (160,120) once faded/scaled in, got ${afterFade}`)

const stat = fs.statSync(outputPath)
console.log(`\nOutput written: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`)
console.log('PASS')
