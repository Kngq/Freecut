import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { buildFfmpegPlan, planToFfmpegArgs } from '@shared/ffmpegGraph'
import { projectDuration, type Project } from '@shared/types'
import type { ExportProgress, ExportResult } from '@shared/ipc'

export function exportProject(
  project: Project,
  outputPath: string,
  onProgress: (p: ExportProgress) => void
): Promise<ExportResult> {
  const totalDuration = Math.max(projectDuration(project), 0.1)

  let plan
  try {
    plan = buildFfmpegPlan(project)
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }

  if (!ffmpegPath) {
    return Promise.resolve({ ok: false, error: 'ffmpeg binary not found (ffmpeg-static did not resolve a path)' })
  }
  const resolvedFfmpegPath: string = ffmpegPath

  const args = planToFfmpegArgs(plan, outputPath)

  return new Promise((resolve) => {
    onProgress({ ratio: 0, message: 'Starting ffmpeg…' })
    const proc = spawn(resolvedFfmpegPath, args)
    let stderr = ''

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (match) {
        const [, h, m, s] = match
        const seconds = Number(h) * 3600 + Number(m) * 60 + Number(s)
        const ratio = Math.min(seconds / totalDuration, 0.99)
        onProgress({ ratio, message: `Encoding… ${Math.round(ratio * 100)}%` })
      }
    })

    proc.on('error', (err) => {
      resolve({ ok: false, error: err.message })
    })

    proc.on('close', (code) => {
      if (code === 0) {
        onProgress({ ratio: 1, message: 'Done' })
        resolve({ ok: true, outputPath })
      } else {
        const tail = stderr.split('\n').slice(-20).join('\n')
        resolve({ ok: false, error: `ffmpeg exited with code ${code}\n${tail}` })
      }
    })
  })
}
