import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip } from '../src/shared/types'

const WORKDIR = process.env.FREECUT_TEST_DIR || '/private/tmp/claude-501/-Users-kng-projects-freecut/371b1583-5078-4296-a572-064ebb316fe7/scratchpad/export-test-freeze'
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

// ---- Synthesize a 6s moving test clip (testsrc2 has a visible moving pattern/timecode, so a
// ---- frozen frame is visually distinguishable from the surrounding motion) ----
const source = path.join(WORKDIR, 'source.mp4')
run(
  ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source],
  'generate source'
)

// ---- before (2s) -> freeze (1s hold) -> after (4s), back to back on the primary video
// ---- track. This is exactly the three-way split insertFreezeFrame produces. ----
const project = createEmptyProject('export-freeze-smoke-test')
project.canvas = { width: 320, height: 240, fps: 30 }

const asset: MediaAsset = { id: 'a', path: source, kind: 'video', name: 'source.mp4', duration: 6, width: 320, height: 240, hasAudio: false }
project.assets = [asset]

const videoTrack = project.tracks.find((t) => t.type === 'video')!

const mediaDefaults = { speed: 1, speedKeyframes: undefined, reversed: false, transform: defaultTransform() } as const

const before: MediaClip = {
  id: 'before',
  kind: 'media',
  trackId: videoTrack.id,
  start: 0,
  duration: 2,
  assetId: 'a',
  trimIn: 0,
  trimOut: 2,
  volume: 1,
  muted: false,
  frozen: false,
  ...mediaDefaults
}

const freeze: MediaClip = {
  id: 'freeze',
  kind: 'media',
  trackId: videoTrack.id,
  start: before.duration,
  duration: 1,
  assetId: 'a',
  trimIn: 2,
  trimOut: 2,
  volume: 1,
  muted: true,
  frozen: true,
  ...mediaDefaults
}

const after: MediaClip = {
  id: 'after',
  kind: 'media',
  trackId: videoTrack.id,
  start: before.duration + freeze.duration,
  duration: 4,
  assetId: 'a',
  trimIn: 2,
  trimOut: 6,
  volume: 1,
  muted: false,
  frozen: false,
  ...mediaDefaults
}

videoTrack.clips = [before, freeze, after]

const expectedDuration = before.duration + freeze.duration + after.duration
console.log(`expected total duration: ${expectedDuration}s`)

// ---- Build + run the real export plan ----
const plan = buildFfmpegPlan(project)
console.log('\nfilter_complex:\n', plan.filterComplex)
if (!plan.filterComplex.includes('tpad=stop_mode=clone')) {
  throw new Error('expected a tpad filter for the frozen segment — none found in the filter graph')
}

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
console.log(`\nactual output duration: ${actualDuration}s (expected ~${expectedDuration}s)`)
if (Math.abs(actualDuration - expectedDuration) > 0.2) {
  throw new Error(`output duration ${actualDuration}s is too far from expected ${expectedDuration}s`)
}

const stat = fs.statSync(outputPath)
console.log(`\nOutput written: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`)
console.log('PASS')
