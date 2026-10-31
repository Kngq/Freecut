import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app, net } from 'electron'
import ffmpegPath from 'ffmpeg-static'
import type { CaptionSegment, CaptionStatus } from '@shared/ipc'

/**
 * Local, fully-offline speech-to-text for auto-captions, built on whisper.cpp.
 *
 * Design goals:
 *  - No network at transcribe time, and no cloud API ever. The GGML model is downloaded ONCE
 *    (from Hugging Face) into the app's data dir and reused forever after.
 *  - No mandatory native compilation: we invoke a `whisper-cli` BINARY found on PATH / in the
 *    usual Homebrew locations (`brew install whisper-cpp`). If it's absent we report that
 *    cleanly so the UI can tell the user how to enable captions, rather than crashing.
 *  - Audio is extracted to 16 kHz mono WAV with the ffmpeg we already bundle.
 *
 * The model file (ggml-base.en.bin, ~142 MB) lives at:
 *   <userData>/whisper/ggml-base.en.bin
 */

const MODEL_NAME = 'ggml-base.en.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`

function whisperDir(): string {
  return path.join(app.getPath('userData'), 'whisper')
}
function modelPath(): string {
  return path.join(whisperDir(), MODEL_NAME)
}

/** Candidate locations for a prebuilt whisper-cli binary (Homebrew arm64/intel, PATH). */
const WHISPER_BIN_CANDIDATES = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cpp',
  '/usr/local/bin/whisper-cpp'
]

async function findWhisperBinary(): Promise<string | null> {
  for (const candidate of WHISPER_BIN_CANDIDATES) {
    if (await fileExists(candidate)) return candidate
  }
  // Fall back to PATH resolution.
  const fromPath = await which('whisper-cli')
  if (fromPath) return fromPath
  return which('whisper-cpp')
}

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/which', [bin])
    let out = ''
    proc.stdout.on('data', (c) => (out += c))
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => resolve(code === 0 && out.trim() ? out.trim() : null))
  })
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** Reports whether captions can run: is the whisper binary present, and is the model downloaded. */
export async function captionStatus(): Promise<CaptionStatus> {
  const [binary, hasModel] = await Promise.all([findWhisperBinary(), fileExists(modelPath())])
  return {
    binaryAvailable: binary !== null,
    binaryPath: binary ?? undefined,
    modelDownloaded: hasModel,
    modelName: MODEL_NAME,
    installHint: binary === null ? 'Install whisper.cpp to enable captions: `brew install whisper-cpp`.' : undefined
  }
}

/** Downloads the GGML model into the app data dir (idempotent, atomic). Returns the final path. */
export async function downloadCaptionModel(): Promise<{ ok: boolean; error?: string }> {
  if (await fileExists(modelPath())) return { ok: true }
  await fs.mkdir(whisperDir(), { recursive: true })
  const tmp = `${modelPath()}.download`
  try {
    await new Promise<void>((resolve, reject) => {
      const request = net.request(MODEL_URL)
      request.on('response', (response) => {
        const status = (response as unknown as { statusCode: number }).statusCode
        if (status >= 300 && status < 400) {
          // net.request follows redirects by default; if not, surface it.
        }
        if (status >= 400) {
          reject(new Error(`model download failed: HTTP ${status}`))
          return
        }
        const out = createWriteStream(tmp)
        response.on('data', (chunk) => out.write(chunk))
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

/** Extracts 16 kHz mono 16-bit PCM WAV from a media file (whisper's required input format). */
function extractWav(inputPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg not available'))
    const args = ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]
    const proc = spawn(ffmpegPath, args)
    let stderr = ''
    proc.stderr.on('data', (c) => (stderr += c))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg wav extract exited ${code}: ${stderr.slice(-300)}`))))
  })
}

interface WhisperJson {
  transcription?: Array<{
    offsets?: { from: number; to: number } // milliseconds
    text?: string
  }>
}

/**
 * Transcribes a media file to timestamped caption segments, fully locally. Steps:
 *  1. ensure the model is present (caller should have downloaded it; we double-check),
 *  2. extract a 16kHz mono WAV with ffmpeg,
 *  3. run `whisper-cli -m model -f wav -oj` which writes `<wav>.json`,
 *  4. parse the `transcription[]` offsets (ms) into {start,end,text} seconds.
 */
export async function transcribeToCaptions(inputPath: string): Promise<{ ok: boolean; segments?: CaptionSegment[]; error?: string }> {
  const binary = await findWhisperBinary()
  if (!binary) return { ok: false, error: 'whisper.cpp is not installed. Run `brew install whisper-cpp`.' }
  if (!(await fileExists(modelPath()))) return { ok: false, error: 'Caption model not downloaded yet.' }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'freecut-caption-'))
  const wavPath = path.join(work, 'audio.wav')
  const jsonPath = `${wavPath}.json`
  try {
    await extractWav(inputPath, wavPath)

    await new Promise<void>((resolve, reject) => {
      // -oj writes <wav>.json next to the wav; -of sets the output base (without extension).
      const args = ['-m', modelPath(), '-f', wavPath, '-oj', '-of', wavPath]
      const proc = spawn(binary, args)
      let stderr = ''
      proc.stderr.on('data', (c) => (stderr += c))
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper exited ${code}: ${stderr.slice(-300)}`))))
    })

    const raw = await fs.readFile(jsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as WhisperJson
    const segments: CaptionSegment[] = (parsed.transcription ?? [])
      .map((t) => ({
        start: (t.offsets?.from ?? 0) / 1000,
        end: (t.offsets?.to ?? 0) / 1000,
        text: (t.text ?? '').trim()
      }))
      .filter((s) => s.text.length > 0 && s.end > s.start)
    return { ok: true, segments }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
