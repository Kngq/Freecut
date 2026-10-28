import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, effectiveDuration, type MediaAsset, type MediaClip } from '../src/shared/types'

const WORKDIR = process.env.FREECUT_TEST_DIR || '/private/tmp/claude-501/-Users-kng-projects-freecut/371b1583-5078-4296-a572-064ebb316fe7/scratchpad/export-test-speed'
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

// ---- Synthesize a 6s test clip with audio ----
const source = path.join(WORKDIR, 'source.mp4')
run(
  ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', source],
  'generate source'
)

// ---- One clip at a flat 2x speed, one with a 2-segment speed curve, back to back on the
// ---- primary video track. Both exercise the multi-segment concat path (the curve clip has
// ---- an interior keyframe boundary; the flat clip is the single-segment fast path). ----
const project = createEmptyProject('export-speed-smoke-test')
project.canvas = { width: 320, height: 240, fps: 30 }

const asset: MediaAsset = { id: 'a', path: source, kind: 'video', name: 'source.mp4', duration: 6, width: 320, height: 240, hasAudio: true }
project.assets = [asset]

const videoTrack = project.tracks.find((t) => t.type === 'video')!

const mediaDefaults = { reversed: false, frozen: false, transform: defaultTransform() } as const

// Flat 2x speed over the full 6s source -> 3s on the timeline.
const flatClip: MediaClip = {
  id: 'flat',
  kind: 'media',
  trackId: videoTrack.id,
  start: 0,
  duration: 0, // recomputed below via effectiveDuration, like repackVideoTrack would do
  assetId: 'a',
  trimIn: 0,
  trimOut: 6,
  volume: 1,
  muted: false,
  speed: 2,
  ...mediaDefaults
}
flatClip.duration = effectiveDuration(flatClip)

// Curve: [0,3) at 1x + [3,6) at 2x -> 3 + 1.5 = 4.5s on the timeline.
const curveClip: MediaClip = {
  id: 'curve',
  kind: 'media',
  trackId: videoTrack.id,
  start: flatClip.duration,
  duration: 0,
  assetId: 'a',
  trimIn: 0,
  trimOut: 6,
  volume: 1,
  muted: false,
  speed: 1,
  speedKeyframes: [
    { time: 0, speed: 1 },
    { time: 3, speed: 2 }
  ],
  ...mediaDefaults
}
curveClip.duration = effectiveDuration(curveClip)
videoTrack.clips = [flatClip, curveClip]

console.log(`expected durations: flat=${flatClip.duration}s curve=${curveClip.duration}s total=${flatClip.duration + curveClip.duration}s`)
if (flatClip.duration !== 3) throw new Error(`expected flatClip.duration === 3, got ${flatClip.duration}`)
if (curveClip.duration !== 4.5) throw new Error(`expected curveClip.duration === 4.5, got ${curveClip.duration}`)

// ---- Build + run the real export plan ----
const plan = buildFfmpegPlan(project)
console.log('\nfilter_complex:\n', plan.filterComplex)

const outputPath = path.join(WORKDIR, 'output.mp4')
const args = planToFfmpegArgs(plan, outputPath)
run(args, 'export project')

const probe = spawnSync(ffmpegPath as string, ['-i', outputPath], { encoding: 'utf-8' })
console.log('\n--- ffmpeg probe of output ---')
console.log(probe.stderr)

const match = probe.stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
if (!match) throw new Error('could not parse output duration from ffmpeg probe')
const [, h, m, s] = match
const actualDuration = Number(h) * 3600 + Number(m) * 60 + Number(s)
const expectedDuration = flatClip.duration + curveClip.duration
console.log(`\nactual output duration: ${actualDuration}s (expected ~${expectedDuration}s)`)
if (Math.abs(actualDuration - expectedDuration) > 0.2) {
  throw new Error(`output duration ${actualDuration}s is too far from expected ${expectedDuration}s`)
}

const stat = fs.statSync(outputPath)
console.log(`\nOutput written: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`)
console.log('PASS')
