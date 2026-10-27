import { spawn } from 'node:child_process'
import path from 'node:path'
// @ts-expect-error - no types published
import ffprobePkg from 'ffprobe-static'
import type { ProbeResult } from '@shared/ipc'

const ffprobePath: string = (ffprobePkg as { path: string }).path

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

export function probeMedia(filePath: string): Promise<ProbeResult | null> {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXT.has(ext)) {
    return Promise.resolve({ kind: 'image', duration: 0, hasAudio: false })
  }
  if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]
    const proc = spawn(ffprobePath, args)
    let stdout = ''
    proc.stdout.on('data', (chunk) => (stdout += chunk))
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null)
      try {
        const data = JSON.parse(stdout)
        const streams: Array<Record<string, unknown>> = data.streams ?? []
        const videoStream = streams.find((s) => s.codec_type === 'video')
        const audioStream = streams.find((s) => s.codec_type === 'audio')
        const duration = Number(data.format?.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0)
        const kind: ProbeResult['kind'] = videoStream ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : 'video'
        resolve({
          kind,
          duration: Number.isFinite(duration) ? duration : 0,
          width: videoStream ? Number(videoStream.width) : undefined,
          height: videoStream ? Number(videoStream.height) : undefined,
          hasAudio: Boolean(audioStream)
        })
      } catch {
        resolve(null)
      }
    })
  })
}
