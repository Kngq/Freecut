import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import ffmpegPath from 'ffmpeg-static'
import type { Waveform } from '@shared/ipc'

/**
 * Extracts an audio-waveform peak summary for a media file: decodes to mono 8 kHz PCM (s16le) and
 * reduces it to BUCKET_COUNT normalized peak magnitudes (0..1). The renderer draws these as a
 * symmetric bar graph under a clip's thumbnails. A fixed small bucket count keeps the JSON tiny
 * and is plenty of resolution once scaled across a clip — the renderer resamples to the clip's
 * pixel width.
 *
 * Cached in the OS temp dir with the same sha1(path:mtime:size) key + atomic-rename + in-flight
 * dedupe pattern as the preview proxy (see proxy.ts for why temp and not userData).
 */
const BUCKET_COUNT = 400
const SAMPLE_RATE = 8000

const inFlight = new Map<string, Promise<Waveform | null>>()

export async function ensureWaveform(filePath: string): Promise<Waveform | null> {
  if (!ffmpegPath) return null

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null

  const key = crypto.createHash('sha1').update(`wf:${filePath}:${stat.mtimeMs}:${stat.size}`).digest('hex')
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = buildWaveform(filePath, key).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

async function buildWaveform(filePath: string, key: string): Promise<Waveform | null> {
  const dir = path.join(app.getPath('temp'), 'freecut-waveforms')
  await fs.mkdir(dir, { recursive: true })
  const outPath = path.join(dir, `${key}.json`)

  const cached = await fs.readFile(outPath, 'utf-8').then(
    (raw) => JSON.parse(raw) as Waveform,
    () => null
  )
  if (cached) return cached

  try {
    const pcm = await decodePcm(filePath)
    if (!pcm || pcm.length === 0) return null
    const peaks = reduceToPeaks(pcm, BUCKET_COUNT)
    const waveform: Waveform = { peaks }
    await fs.writeFile(outPath, JSON.stringify(waveform), 'utf-8')
    return waveform
  } catch (err) {
    console.error('[freecut] waveform generation failed for', filePath, err)
    return null
  }
}

/** Runs ffmpeg to produce raw mono 16-bit little-endian PCM on stdout and collects it. */
function decodePcm(filePath: string): Promise<Int16Array | null> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-i', filePath, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-']
    const proc = spawn(ffmpegPath as string, args)
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`))
      const buf = Buffer.concat(chunks)
      if (buf.length < 2) return resolve(null)
      // Reinterpret the byte buffer as Int16. byteOffset/length guard against an odd trailing byte.
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
      resolve(samples)
    })
  })
}

/** Reduces raw samples to `buckets` peak magnitudes in 0..1 (max |sample| per bucket / 32768). */
function reduceToPeaks(samples: Int16Array, buckets: number): number[] {
  const peaks = new Array<number>(buckets).fill(0)
  const per = samples.length / buckets
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * per)
    const end = Math.min(samples.length, Math.floor((i + 1) * per))
    let peak = 0
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j])
      if (v > peak) peak = v
    }
    peaks[i] = peak / 32768
  }
  return peaks
}
