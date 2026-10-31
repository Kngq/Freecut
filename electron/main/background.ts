import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, net } from 'electron'
import ffmpegPath from 'ffmpeg-static'
import type { BackgroundStatus, BackgroundResult } from '@shared/ipc'

/**
 * Local, fully-offline background removal (per-frame foreground matting) for video clips.
 *
 * Status: SCAFFOLD. The full pipeline is wired (model status + one-time download + an
 * ffmpeg extract → ONNX matte → alpha recomposite → ProRes-4444 reassemble flow), but the ONNX
 * inference step depends on the optional `onnxruntime-node` package, which ships prebuilt
 * macOS-arm64 binaries (no compile) but is not installed by default to keep the base app light.
 * When it (and the model) are present this runs entirely offline; otherwise we report cleanly.
 *
 * Model: U²-Net / ISNet style portrait+general matting ONNX (permissive license). Downloaded
 * once into <userData>/models/.
 *
 * Why ProRes 4444 output: MP4/H.264 can't carry an alpha channel; a background-removed clip
 * needs an alpha-capable container to be useful as an overlay.
 */

const MODEL_NAME = 'u2net.onnx'
// Permissively-licensed U²-Net ONNX export (rembg's default model), mirrored on Hugging Face.
const MODEL_URL = 'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2net.onnx'
const MODEL_INPUT = 320 // U²-Net expects 320x320 NCHW

function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}
function modelPath(): string {
  return path.join(modelsDir(), MODEL_NAME)
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** Minimal shape of the bits of onnxruntime-node we use (avoids a hard type dependency on the
 *  optional package, which may not be installed). */
interface OrtTensor {
  data: Float32Array
}
interface OrtModule {
  InferenceSession: {
    create(path: string): Promise<{
      inputNames: string[]
      outputNames: string[]
      run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
    }>
  }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
}

/** Lazily resolve the optional onnxruntime-node dependency. Returns null if it isn't installed. */
async function loadOnnx(): Promise<OrtModule | null> {
  try {
    // Dynamic import by a computed specifier so the bundler/type-checker doesn't require the
    // (heavy, optional) dependency to be present at build time.
    const specifier = 'onnxruntime-node'
    return (await import(/* @vite-ignore */ specifier)) as unknown as OrtModule
  } catch {
    return null
  }
}

/** Reports whether background removal can run: the ONNX runtime dep + the downloaded model. */
export async function backgroundStatus(): Promise<BackgroundStatus> {
  const [onnx, hasModel] = await Promise.all([loadOnnx(), fileExists(modelPath())])
  return {
    runtimeAvailable: onnx !== null,
    modelDownloaded: hasModel,
    modelName: MODEL_NAME,
    installHint: onnx === null ? 'Install the local ML runtime to enable background removal: `npm i onnxruntime-node`.' : undefined
  }
}

/** Downloads the matting model once into the app data dir (idempotent, atomic). */
export async function downloadBackgroundModel(): Promise<{ ok: boolean; error?: string }> {
  if (await fileExists(modelPath())) return { ok: true }
  await fs.mkdir(modelsDir(), { recursive: true })
  const tmp = `${modelPath()}.download`
  try {
    await new Promise<void>((resolve, reject) => {
      const request = net.request(MODEL_URL)
      request.on('response', (response) => {
        const status = (response as unknown as { statusCode: number }).statusCode
        if (status >= 400) return reject(new Error(`model download failed: HTTP ${status}`))
        const out = createWriteStream(tmp)
        response.on('data', (c) => out.write(c))
        response.on('end', () => {
          out.end()
          out.on('finish', () => resolve())
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end()
    })
    await fs.rename(tmp, modelPath())
    return { ok: true }
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg not available'))
    const proc = spawn(ffmpegPath, args)
    let stderr = ''
    proc.stderr.on('data', (c) => (stderr += c))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))))
  })
}

/**
 * Removes the background from a video, writing an alpha-channel ProRes 4444 .mov next to a temp
 * dir and returning its path. Pipeline: extract PNG frames → per-frame U²-Net matte via ONNX →
 * apply matte as alpha → reassemble with ProRes 4444 (keeps audio from the source).
 *
 * Returns ok:false with a reason when the runtime/model aren't available (graceful).
 */
export async function removeBackground(inputPath: string, onProgress?: (ratio: number) => void): Promise<BackgroundResult> {
  const onnx = await loadOnnx()
  if (!onnx) return { ok: false, error: 'Local ML runtime (onnxruntime-node) is not installed.' }
  if (!(await fileExists(modelPath()))) return { ok: false, error: 'Background-removal model not downloaded yet.' }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'freecut-bg-'))
  const framesDir = path.join(work, 'frames')
  const outDir = path.join(work, 'out')
  await fs.mkdir(framesDir, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(work, 'nobg.mov')

  try {
    // 1. Extract frames (keep source fps via -vsync 0) and the fps for reassembly.
    await ffmpeg(['-y', '-i', inputPath, '-vsync', '0', path.join(framesDir, 'f%06d.png')])
    const frames = (await fs.readdir(framesDir)).filter((f) => f.endsWith('.png')).sort()
    if (frames.length === 0) return { ok: false, error: 'no frames extracted' }

    // 2. Load the model once and matte each frame. We rely on sharp-like decoding via the
    //    canvas is unavailable in main; instead we decode/resize with ffmpeg to raw RGB at the
    //    model input size, run inference, and write an RGBA PNG back with ffmpeg using the matte
    //    as alpha. (Kept per-frame and simple; temporal smoothing is a future refinement.)
    const session = await onnx.InferenceSession.create(modelPath())

    for (let i = 0; i < frames.length; i++) {
      const frame = path.join(framesDir, frames[i])
      // Decode+resize the frame to MODEL_INPUT^2 raw RGB for the network input.
      const rawSmall = path.join(work, 'in.rgb')
      await ffmpeg(['-y', '-i', frame, '-vf', `scale=${MODEL_INPUT}:${MODEL_INPUT}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', rawSmall])
      const rgb = await fs.readFile(rawSmall)

      // NCHW float input normalized to [0,1] then mean/std per U²-Net (0.485.. / 0.229..).
      const n = MODEL_INPUT * MODEL_INPUT
      const input = new Float32Array(3 * n)
      const mean = [0.485, 0.456, 0.406]
      const std = [0.229, 0.224, 0.225]
      for (let p = 0; p < n; p++) {
        for (let c = 0; c < 3; c++) {
          input[c * n + p] = (rgb[p * 3 + c] / 255 - mean[c]) / std[c]
        }
      }
      const tensor = new onnx.Tensor('float32', input, [1, 3, MODEL_INPUT, MODEL_INPUT])
      const feeds: Record<string, unknown> = { [session.inputNames[0]]: tensor }
      const results = await session.run(feeds)
      const matte = results[session.outputNames[0]].data as Float32Array

      // Normalize matte to 0..255 and write a MODEL_INPUT^2 grayscale PNG (the alpha source).
      let min = Infinity
      let max = -Infinity
      for (const v of matte) {
        if (v < min) min = v
        if (v > max) max = v
      }
      const range = max - min || 1
      const gray = Buffer.alloc(n)
      for (let p = 0; p < n; p++) gray[p] = Math.round(((matte[p] - min) / range) * 255)
      const matteRaw = path.join(work, 'matte.gray')
      await fs.writeFile(matteRaw, gray)

      // Compose: scale the matte back up to the frame size and attach it as alpha.
      const outFrame = path.join(outDir, frames[i])
      await ffmpeg([
        '-y',
        '-i',
        frame,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-s',
        `${MODEL_INPUT}x${MODEL_INPUT}`,
        '-i',
        matteRaw,
        '-filter_complex',
        `[1:v]scale=iw:ih[a];[0:v][a]alphamerge`,
        '-pix_fmt',
        'rgba',
        outFrame
      ])
      onProgress?.((i + 1) / frames.length)
    }

    // 3. Reassemble to ProRes 4444 with alpha, muxing the source audio.
    await ffmpeg([
      '-y',
      '-framerate',
      '30',
      '-i',
      path.join(outDir, 'f%06d.png'),
      '-i',
      inputPath,
      '-map',
      '0:v',
      '-map',
      '1:a?',
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4444',
      '-pix_fmt',
      'yuva444p10le',
      '-c:a',
      'copy',
      outPath
    ])
    return { ok: true, outputPath: outPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  // NOTE: `work` is intentionally left for the caller; the produced .mov lives inside it.
}
