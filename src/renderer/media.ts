import type { MediaAsset } from '@shared/types'

/** MIME type used when dragging an already-imported asset from the media bin. */
export const ASSET_DRAG_MIME = 'application/x-freecut-asset'

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p
}

/** Probes each path and returns the assets that could be read. Unreadable files are reported once. */
export async function assetsFromPaths(paths: string[]): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = []
  const skipped: string[] = []
  for (const path of paths) {
    const probe = await window.api.probeMedia(path)
    if (!probe) {
      skipped.push(basename(path))
      continue
    }
    assets.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      kind: probe.kind,
      name: basename(path),
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio
    })
  }
  if (skipped.length > 0) alert(`Could not import:\n${skipped.join('\n')}`)
  return assets
}

/** Absolute paths of OS files in a drop event (empty if none, e.g. an in-app drag). */
export function droppedFilePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => window.api.getPathForFile(file))
    .filter((p) => p.length > 0)
}

export function isMediaDrag(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(ASSET_DRAG_MIME) || types.includes('Files')
}
