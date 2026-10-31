import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { app } from 'electron'
import ffmpegPath from 'ffmpeg-static'
import type { ThumbnailCover } from '@shared/ipc'

/**
 * Generates a thumbnail sprite sheet for a video: FRAME_COUNT frames sampled evenly across the
 * source, scaled to FRAME_HEIGHT, laid out left-to-right in one PNG. The renderer slices this
 * sprite across a timeline clip, so a clip zoomed very wide shows many distinct frames (not one
 * repeated/upscaled frame). Entirely local — the bundled ffmpeg-static binary runs on-device.
 *
 * For image assets the caller uses the image file itself (frames=1); this handles videos.
 *
 * Cached in the OS temp dir with the same sha1(path:mtime:size) key + atomic-rename + in-flight
 * dedupe pattern as the preview proxy (see proxy.ts for why temp and not userData).
 */
const FRAME_COUNT = 40
const FRAME_HEIGHT = 120

const inFlight = new Map<string, Promise<ThumbnailCover | null>>()

/** Thumbnail sprite for a VIDEO file. Returns null for failure / missing ffmpeg. */
export async function ensureVideoCover(filePath: string): Promise<ThumbnailCover | null> {
  if (!ffmpegPath) return null

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat) return null

  // Key includes the frame count/height so changing those regenerates rather than serving a
  // stale layout from an older build.
  const key = crypto
    .createHash('sha1')
    .update(`sprite:${FRAME_COUNT}x${FRAME_HEIGHT}:${filePath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex')
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = buildSprite(filePath, key).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

async function buildSprite(filePath: string, key: string): Promise<ThumbnailCover | null> {
  const dir = path.join(app.getPath('temp'), 'freecut-thumbnails')
  await fs.mkdir(dir, { recursive: true })
  const outPath = path.join(dir, `${key}.png`)
  const metaPath = path.join(dir, `${key}.json`)

  // Cache hit: both the image and its sidecar metadata (frame dimensions) must exist.
  const cachedMeta = await fs.readFile(metaPath, 'utf-8').then(
    (raw) => JSON.parse(raw) as ThumbnailCover,
    () => null
  )
  if (cachedMeta && (await fileExists(outPath))) return cachedMeta

  const tmpPath = `${outPath}.tmp.png`
  try {
    // thumbnail=... picks a representative frame per group; `tile=Nx1` concatenates the chosen
    // frames into a single horizontal strip. scale fixes the height, width auto (even).
    const vf = `thumbnail,scale=-2:${FRAME_HEIGHT},tile=${FRAME_COUNT}x1`
    await new Promise<void>((resolve, reject) => {
      const args = ['-y', '-i', filePath, '-frames:v', '1', '-vf', vf, '-vsync', 'vfr', tmpPath]
      const proc = spawn(ffmpegPath as string, args)
      let stderr = ''
      proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))))
    })
    await fs.rename(tmpPath, outPath)

    // Read the finished sprite's pixel dimensions from the PNG header to learn the per-frame
    // size. `tile=FRAME_COUNTx1` always emits exactly FRAME_COUNT cells (padding short sources
    // with black), so the per-frame width is simply totalWidth / FRAME_COUNT.
    const { width: totalWidth, height } = await pngSize(outPath)
    const frameWidth = Math.max(1, Math.round(totalWidth / FRAME_COUNT))
    const meta: ThumbnailCover = { path: outPath, frames: FRAME_COUNT, frameWidth, frameHeight: height }
    await fs.writeFile(metaPath, JSON.stringify(meta), 'utf-8')
    return meta
  } catch (err) {
    console.error('[freecut] thumbnail sprite generation failed for', filePath, err)
    await fs.unlink(tmpPath).catch(() => {})
    return null
  }
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

/** Reads a PNG's pixel width/height from its IHDR header (bytes 16-23, big-endian). Avoids
 *  pulling in an image library just to learn the sprite dimensions. */
async function pngSize(pngPath: string): Promise<{ width: number; height: number }> {
  const fh = await fs.open(pngPath, 'r')
  try {
    const buf = Buffer.alloc(24)
    await fh.read(buf, 0, 24, 0)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } finally {
    await fh.close()
  }
}
