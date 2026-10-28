import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import ffmpegPath from 'ffmpeg-static'

/**
 * Codecs Chromium's <video>/<audio> can actually decode (verified on this machine: h264 plays
 * directly, and hevc too via hardware-accelerated decode — though hevc support varies more by
 * platform). Everything else — ProRes, DNxHD, Apple Intermediate Codec, etc. — demuxes "fine"
 * (duration/canplay/readyState all look correct) but never produces a decodable frame: no
 * error event, no rejected play() promise, just videoWidth/videoHeight stuck at 0 forever.
 * ffmpeg (which export uses directly, not the browser) decodes all of these natively, so the
 * fix for preview is a transcoded H.264 proxy, cached per source file.
 */
const SAFE_VIDEO_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'theora'])
const SAFE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le', 'flac'])

function needsProxy(videoCodec?: string, audioCodec?: string): boolean {
  if (videoCodec && !SAFE_VIDEO_CODECS.has(videoCodec)) return true
  if (audioCodec && !SAFE_AUDIO_CODECS.has(audioCodec)) return true
  return false
}

// Dedupes concurrent requests for the same source file (e.g. the same asset used by several
// clips) so only one ffmpeg transcode ever runs for it at a time.
const inFlight = new Map<string, Promise<string | null>>()

export async function ensurePreviewProxy(filePath: string, videoCodec?: string, audioCodec?: string): Promise<string | null> {
  if (!needsProxy(videoCodec, audioCodec) || !ffmpegPath) return null

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null

  const key = crypto.createHash('sha1').update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest('hex')
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = buildProxy(filePath, key).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

async function buildProxy(filePath: string, key: string): Promise<string | null> {
  // Deliberately NOT under app.getPath('userData'): net.fetch (which the freecut-media://
  // handler uses) silently fails to read files there — likely Electron treating its own
  // userData/session storage area as off-limits to generic file fetches. Confirmed empirically:
  // the identical file content fetches fine from the OS temp dir but fails from userData.
  const dir = path.join(app.getPath('temp'), 'freecut-preview-proxies')
  await fs.mkdir(dir, { recursive: true })
  const outPath = path.join(dir, `${key}.mp4`)

  const cached = await fs.access(outPath).then(
    () => true,
    () => false
  )
  if (cached) return outPath

  const tmpPath = `${outPath}.tmp.mp4`
  try {
    await new Promise<void>((resolve, reject) => {
      const args = ['-y', '-i', filePath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tmpPath]
      const proc = spawn(ffmpegPath as string, args)
      let stderr = ''
      proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))))
    })
    await fs.rename(tmpPath, outPath)
    return outPath
  } catch (err) {
    console.error('[freecut] preview proxy generation failed for', filePath, err)
    await fs.unlink(tmpPath).catch(() => {})
    return null
  }
}
