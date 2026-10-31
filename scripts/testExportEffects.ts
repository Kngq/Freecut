import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '../src/shared/ffmpegGraph'
import {
  createEffect,
  createEmptyProject,
  defaultTransform,
  type ClipEffectType,
  type MediaAsset,
  type MediaClip,
  type TransitionType
} from '../src/shared/types'

/**
 * Validates that the effect/transition filter strings freecut generates are *real, valid
 * ffmpeg* — not just well-formed TypeScript. For each effect type and a couple of the new
 * transition types, it builds a tiny two-clip project, runs the actual ffmpeg plan, and
 * asserts a non-empty mp4 comes out. A broken filter expression (bad escaping, wrong param,
 * nonexistent xfade name) makes ffmpeg exit non-zero, which fails the test.
 */
const WORKDIR = process.env.FREECUT_TEST_DIR || path.join(process.cwd(), '.scratch-effects-export')
fs.mkdirSync(WORKDIR, { recursive: true })

function run(args: string[], label: string): { ok: boolean; stderr: string } {
  const res = spawnSync(ffmpegPath as string, args, { encoding: 'utf-8' })
  if (res.status !== 0) {
    return { ok: false, stderr: res.stderr?.split('\n').slice(-25).join('\n') ?? '' }
  }
  return { ok: true, stderr: '' }
}

// ---- Synthesize two short test clips ----
const clipA = path.join(WORKDIR, 'a.mp4')
const clipB = path.join(WORKDIR, 'b.mp4')
run(
  ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x854:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipA],
  'gen a'
).ok || process.exit(1)
run(
  ['-y', '-f', 'lavfi', '-i', 'color=c=green:size=480x854:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipB],
  'gen b'
).ok || process.exit(1)

const assetA: MediaAsset = { id: 'a', path: clipA, kind: 'video', name: 'a.mp4', duration: 2, width: 480, height: 854, hasAudio: false }
const assetB: MediaAsset = { id: 'b', path: clipB, kind: 'video', name: 'b.mp4', duration: 2, width: 480, height: 854, hasAudio: false }
const mediaDefaults = { speed: 1, reversed: false, frozen: false, transform: defaultTransform() } as const

function buildProject(opts: { effect?: ClipEffectType; transition?: TransitionType }) {
  const project = createEmptyProject('effects-export')
  project.canvas = { width: 480, height: 854, fps: 30 }
  project.assets = [assetA, assetB]
  const videoTrack = project.tracks.find((t) => t.type === 'video')!
  const c1: MediaClip = { id: 'c1', kind: 'media', trackId: videoTrack.id, start: 0, duration: 2, assetId: 'a', trimIn: 0, trimOut: 2, volume: 1, muted: false, ...mediaDefaults }
  const c2: MediaClip = {
    id: 'c2',
    kind: 'media',
    trackId: videoTrack.id,
    start: 2,
    duration: 2,
    assetId: 'b',
    trimIn: 0,
    trimOut: 2,
    volume: 1,
    muted: false,
    ...mediaDefaults,
    transitionIn: opts.transition ? { type: opts.transition, duration: 0.5 } : undefined,
    effects: opts.effect ? [createEffect(opts.effect, `fx-${opts.effect}`)] : undefined
  }
  videoTrack.clips = [c1, c2]
  return project
}

const effectTypes: ClipEffectType[] = ['kenBurns', 'shake', 'blur', 'vignette', 'grain', 'blackWhite', 'flash', 'mirror']
const transitionTypes: TransitionType[] = ['dipToWhite', 'dissolve', 'slideLeft', 'wipeRight', 'zoomIn', 'circleOpen']

let failures = 0

for (const effect of effectTypes) {
  const project = buildProject({ effect })
  const plan = buildFfmpegPlan(project)
  const out = path.join(WORKDIR, `effect-${effect}.mp4`)
  const res = run(planToFfmpegArgs(plan, out), `effect ${effect}`)
  if (!res.ok || !fs.existsSync(out) || fs.statSync(out).size < 1000) {
    console.error(`FAIL effect=${effect}\n  filter: ${plan.filterComplex}\n  ${res.stderr}`)
    failures++
  } else {
    console.log(`OK   effect=${effect} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`)
  }
}

for (const transition of transitionTypes) {
  const project = buildProject({ transition })
  const plan = buildFfmpegPlan(project)
  const out = path.join(WORKDIR, `transition-${transition}.mp4`)
  const res = run(planToFfmpegArgs(plan, out), `transition ${transition}`)
  if (!res.ok || !fs.existsSync(out) || fs.statSync(out).size < 1000) {
    console.error(`FAIL transition=${transition}\n  filter: ${plan.filterComplex}\n  ${res.stderr}`)
    failures++
  } else {
    console.log(`OK   transition=${transition} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`)
  }
}

// ---- Combined: multiple effects stacked on one clip ----
{
  const project = buildProject({ transition: 'slideLeft' })
  const v = project.tracks.find((t) => t.type === 'video')!
  const c2 = v.clips[1] as MediaClip
  c2.effects = [createEffect('vignette', 'v1'), createEffect('grain', 'g1'), createEffect('mirror', 'm1')]
  const plan = buildFfmpegPlan(project)
  const out = path.join(WORKDIR, 'combined.mp4')
  const res = run(planToFfmpegArgs(plan, out), 'combined')
  if (!res.ok || !fs.existsSync(out) || fs.statSync(out).size < 1000) {
    console.error(`FAIL combined\n  filter: ${plan.filterComplex}\n  ${res.stderr}`)
    failures++
  } else {
    console.log(`OK   combined effect stack + transition (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`)
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${effectTypes.length + transitionTypes.length + 1} export scenarios, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
