import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from './projectStore'
import { createEmptyProject, defaultTransform, type MediaAsset } from '@shared/types'

/** Seeds a clean project with one media clip on the video track and selects it. Returns the
 *  clip id. Each test starts from here so history is empty and deterministic. */
function seedOneClip(): string {
  const project = createEmptyProject('test')
  useProjectStore.getState().setProject(project)
  const asset: MediaAsset = { id: 'a', path: '/tmp/a.mp4', kind: 'video', name: 'a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: false }
  const vt = useProjectStore.getState().project.tracks.find((t) => t.type === 'video')!
  useProjectStore.getState().addAsset(asset)
  useProjectStore.getState().addMediaClipToTrack(vt.id, asset, 0)
  const clipId = useProjectStore.getState().selectedClipId!
  return clipId
}

function selectedClipTransform() {
  const st = useProjectStore.getState()
  const clip = st.project.tracks.flatMap((t) => t.clips).find((c) => c.id === st.selectedClipId)
  return clip?.transform
}

describe('projectStore — rotate / mirror', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject()
  })

  it('rotateClip adds to rotation and wraps at 360', () => {
    const id = seedOneClip()
    useProjectStore.getState().rotateClip(id, 90)
    expect(selectedClipTransform()?.rotation).toBe(90)
    useProjectStore.getState().rotateClip(id, 90)
    useProjectStore.getState().rotateClip(id, 90)
    useProjectStore.getState().rotateClip(id, 90)
    expect(selectedClipTransform()?.rotation).toBe(0) // 360 wraps to 0
  })

  it('toggleClipFlipH flips the horizontal mirror on and off', () => {
    const id = seedOneClip()
    expect(selectedClipTransform()?.flipH).toBe(false)
    useProjectStore.getState().toggleClipFlipH(id)
    expect(selectedClipTransform()?.flipH).toBe(true)
    useProjectStore.getState().toggleClipFlipH(id)
    expect(selectedClipTransform()?.flipH).toBe(false)
  })
})

describe('projectStore — undo / redo', () => {
  beforeEach(() => {
    useProjectStore.getState().newProject()
  })

  it('undo reverts the last mutation and redo re-applies it', () => {
    const id = seedOneClip()
    useProjectStore.getState().rotateClip(id, 90)
    expect(selectedClipTransform()?.rotation).toBe(90)

    useProjectStore.getState().undo()
    expect(selectedClipTransform()?.rotation).toBe(0)

    useProjectStore.getState().redo()
    expect(selectedClipTransform()?.rotation).toBe(90)
  })

  it('undo is a no-op once history is exhausted', () => {
    seedOneClip()
    // Drain the history accumulated by seeding, then an extra undo must not change anything.
    while (useProjectStore.getState().past.length > 0) useProjectStore.getState().undo()
    const drained = JSON.stringify(useProjectStore.getState().project)
    useProjectStore.getState().undo()
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(drained)
  })

  it('a new mutation after undo clears the redo stack', () => {
    const id = seedOneClip()
    useProjectStore.getState().rotateClip(id, 90) // rotation 90
    useProjectStore.getState().undo() // back to 0, future has the 90 state
    expect(useProjectStore.getState().future.length).toBeGreaterThan(0)
    useProjectStore.getState().toggleClipFlipH(id) // a new edit
    expect(useProjectStore.getState().future.length).toBe(0) // redo stack invalidated
  })

  it('removeClip is undoable', () => {
    const id = seedOneClip()
    const countBefore = useProjectStore.getState().project.tracks.flatMap((t) => t.clips).length
    useProjectStore.getState().removeClip(id)
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips).length).toBe(countBefore - 1)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips).length).toBe(countBefore)
  })
})
