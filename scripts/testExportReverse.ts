import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, effectiveDuration, type MediaAsset, type MediaClip } from '../src/shared/types'

const WORKDIR = process.env.FREECUT_TEST_DIR || '/private/tmp/claude-501/-Users-kng-projects-freecut/371b1583-5078-4296-a572-064ebb316fe7/scratchpad/export-test-reverse'
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

// testsrc2 has a visibly moving pattern + timecode-like readout, so a reversed export is
// visually distinguishable from forward (unlike a plain color source).
const source = path.join(WORKDIR, 'source.mp4')
run(
  ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', source],
  'generate source'
)

// Two clips back to back on the primary track: one plain reversed (flat 1x speed -> exercises
// the "reversed, single segment" branch of trimmedSegmentLabel/addAudioClip), one reversed AND
// 2x speed (exercises reverse composing with the speed-segment assembly, still single segment
// since there's no curve here, but `reversed` alone is enough to force the general path).
const project = createEmptyProject('export-reverse-smoke-test')
project.canvas = { width: 320, height: 240, fps: 30 }

const asset: MediaAsset = { id: 'a', path: source, kind: 'video', name: 'source.mp4', duration: 4, width: 320, height: 240, hasAudio: true }
project.assets = [asset]

const videoTrack = project.tracks.find((t) => t.type === 'video')!

const plainReversed: MediaClip = {
  id: 'rev1x',
  kind: 'media',
  trackId: videoTrack.id,
  start: 0,
  duration: 0,
  assetId: 'a',
  trimIn: 0,
  trimOut: 4,
  volume: 1,
  muted: false,
  speed: 1,
  reversed: true,
  frozen: false,
  transform: defaultTransform()
}
plainReversed.duration = effectiveDuration(plainReversed)

const fastReversed: MediaClip = {
  id: 'rev2x',
  kind: 'media',
  trackId: videoTrack.id,
  start: plainReversed.duration,
  duration: 0,
  assetId: 'a',
  trimIn: 0,
  trimOut: 4,
  volume: 1,
  muted: false,
  speed: 2,
  reversed: true,
  frozen: false,
  transform: defaultTransform()
}
fastReversed.duration = effectiveDuration(fastReversed)

videoTrack.clips = [plainReversed, fastReversed]

console.log(`expected durations: rev1x=${plainReversed.duration}s rev2x=${fastReversed.duration}s total=${plainReversed.duration + fastReversed.duration}s`)
if (plainReversed.duration !== 4) throw new Error(`expected plainReversed.duration === 4, got ${plainReversed.duration}`)
if (fastReversed.duration !== 2) throw new Error(`expected fastReversed.duration === 2, got ${fastReversed.duration}`)

const plan = buildFfmpegPlan(project)
console.log('\nfilter_complex:\n', plan.filterComplex)
if (!plan.filterComplex.includes('reverse') || !plan.filterComplex.includes('areverse')) {
  throw new Error('expected both a video `reverse` and an audio `areverse` filter in the plan')
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
const expectedDuration = plainReversed.duration + fastReversed.duration
console.log(`\nactual output duration: ${actualDuration}s (expected ~${expectedDuration}s)`)
if (Math.abs(actualDuration - expectedDuration) > 0.2) {
  throw new Error(`output duration ${actualDuration}s is too far from expected ${expectedDuration}s`)
}

const stat = fs.statSync(outputPath)
console.log(`\nOutput written: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`)
console.log('PASS')
