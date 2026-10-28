import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function mediaUrlToFilePath(url: string): string {
  let pathname = decodeURIComponent(new URL(url).pathname)
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1) // Windows: /C:/x -> C:/x
  return pathname
}

/**
 * Serves a local file for the freecut-media:// scheme by reading it directly with Node's fs in
 * the main process, with manual byte-range support (required for <video> scrubbing/seeking) —
 * deliberately NOT net.fetch(pathToFileURL(...)), which goes through Chromium's sandboxed
 * Network Service utility process. That process silently failed ("Failed to fetch", no real
 * error) to read files outside a narrow set of locations in testing — Desktop, the app's own
 * userData dir, and even its own OS temp dir all failed, while plain Node fs (as used here)
 * reads all of them fine. This is consistent with macOS TCC treating the Network Service's
 * file access differently from the main process's for this unsigned/ad-hoc-signed build.
 */
export async function handleMediaRequest(request: Request): Promise<Response> {
  const filePath = mediaUrlToFilePath(request.url)
  let stats
  try {
    stats = await stat(filePath)
  } catch (err) {
    console.error('[freecut-media] stat failed for', JSON.stringify(filePath), 'from url', request.url, err)
    return new Response('Not found', { status: 404 })
  }

  const contentType = mimeTypeFor(filePath)
  const range = request.headers.get('range')

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range)
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1
    if (start >= stats.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stats.size}` } })
    }
    const stream = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType
      }
    })
  }

  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Length': String(stats.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType
    }
  })
}
