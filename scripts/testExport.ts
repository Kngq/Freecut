import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import { createEmptyProject, defaultTransform, type MediaAsset, type MediaClip, type Clip } from '../src/shared/types'

const WORKDIR = process.env.FREECUT_TEST_DIR || '/private/tmp/claude-501/-Users-kng-projects-freecut/371b1583-5078-4296-a572-064ebb316fe7/scratchpad/export-test'
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

// ---- Synthesize test media ----
const clipA = path.join(WORKDIR, 'clipA.mp4')
const clipB = path.join(WORKDIR, 'clipB.mp4')
const logo = path.join(WORKDIR, 'logo.png')
const music = path.join(WORKDIR, 'music.wav')

run(
  ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x854:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clipA],
  'generate clipA'
)
run(
  ['-y', '-f', 'lavfi', '-i', 'color=c=blue:size=480x854:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', clipB],
  'generate clipB'
)
run(['-y', '-f', 'lavfi', '-i', 'color=c=red:size=200x200', '-frames:v', '1', logo], 'generate logo.png')
run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', music], 'generate music.wav')

// ---- Build a project exercising: primary-track crossfade, secondary-track image overlay,
// ---- text overlay, and a standalone audio track ----
const project = createEmptyProject('export-smoke-test')
project.canvas = { width: 480, height: 854, fps: 30 }

const assetA: MediaAsset = { id: 'a', path: clipA, kind: 'video', name: 'clipA.mp4', duration: 3, width: 480, height: 854, hasAudio: true }
const assetB: MediaAsset = { id: 'b', path: clipB, kind: 'video', name: 'clipB.mp4', duration: 3, width: 480, height: 854, hasAudio: true }
const assetLogo: MediaAsset = { id: 'logo', path: logo, kind: 'image', name: 'logo.png', duration: 0, hasAudio: false }
const assetMusic: MediaAsset = { id: 'music', path: music, kind: 'audio', name: 'music.wav', duration: 4, hasAudio: true }
project.assets = [assetA, assetB, assetLogo, assetMusic]

const videoTrack = project.tracks.find((t) => t.type === 'video')!
const audioTrack = project.tracks.find((t) => t.type === 'audio')!
const textTrack = project.tracks.find((t) => t.type === 'text')!

const mediaDefaults = { speed: 1, reversed: false, frozen: false, transform: defaultTransform() } as const

const clip1: MediaClip = { id: 'c1', kind: 'media', trackId: videoTrack.id, start: 0, duration: 3, assetId: 'a', trimIn: 0, trimOut: 3, volume: 1, muted: false, ...mediaDefaults }
const clip2: MediaClip = {
  id: 'c2',
  kind: 'media',
  trackId: videoTrack.id,
  start: 2.5, // repacked position: 3 - 0.5s crossfade
  duration: 3,
  assetId: 'b',
  trimIn: 0,
  trimOut: 3,
  volume: 1,
  muted: false,
  transitionIn: { type: 'crossfade', duration: 0.5 },
  ...mediaDefaults
}
videoTrack.clips = [clip1, clip2]

const overlayTrack = { ...videoTrack, id: 'overlay-track', name: 'Video 2', clips: [] as Clip[] }
const logoClip: MediaClip = { id: 'logoclip', kind: 'media', trackId: overlayTrack.id, start: 1, duration: 1, assetId: 'logo', trimIn: 0, trimOut: 1, volume: 0, muted: true, ...mediaDefaults }
overlayTrack.clips = [logoClip]
project.tracks.push(overlayTrack)

const musicClip: MediaClip = { id: 'musicclip', kind: 'media', trackId: audioTrack.id, start: 1, duration: 3, assetId: 'music', trimIn: 0, trimOut: 3, volume: 0.8, muted: false, ...mediaDefaults }
audioTrack.clips = [musicClip]

const textClip: Clip = {
  id: 'textclip',
  kind: 'text',
  trackId: textTrack.id,
  start: 0.5,
  duration: 2,
  text: 'Hello: freecut!',
  fontSize: 48,
  color: 'yellow',
  bold: true,
  transform: { ...defaultTransform(), x: 0.5, y: 0.1 }
}
textTrack.clips = [textClip]

// ---- Build + run the real export plan ----
const plan = buildFfmpegPlan(project)
console.log('\nfilter_complex:\n', plan.filterComplex)

const outputPath = path.join(WORKDIR, 'output.mp4')
const args = planToFfmpegArgs(plan, outputPath)
run(args, 'export project')

const probe = spawnSync(ffmpegPath as string, ['-i', outputPath], { encoding: 'utf-8' })
console.log('\n--- ffmpeg probe of output ---')
console.log(probe.stderr)

const stat = fs.statSync(outputPath)
console.log(`\nOutput written: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`)
console.log('PASS')
