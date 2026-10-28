import { canMergeWithNext, useProjectStore } from '../state/projectStore'

export default function Inspector() {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const removeClip = useProjectStore((s) => s.removeClip)
  const mergeWithNext = useProjectStore((s) => s.mergeWithNext)
  const setTransition = useProjectStore((s) => s.setTransition)
  const updateTextClip = useProjectStore((s) => s.updateTextClip)
  const updateMediaClipProps = useProjectStore((s) => s.updateMediaClipProps)

  let found: { track: typeof project.tracks[number]; clip: typeof project.tracks[number]['clips'][number]; index: number } | null = null
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === selectedClipId)
    if (index !== -1) {
      found = { track, clip: track.clips[index], index }
      break
    }
  }

  if (!found) {
    return (
      <div className="panel inspector">
        <h3>Inspector</h3>
        <div className="empty-hint">Select a clip to edit its properties.</div>
      </div>
    )
  }

  const { track, clip, index } = found
  const firstVideoTrack = project.tracks.find((t) => t.type === 'video')
  const canHaveTransition = track.type === 'video' && track.id === firstVideoTrack?.id && index > 0
  const canMerge = clip.kind === 'media' && canMergeWithNext(project, clip.id)

  return (
    <div className="panel inspector">
      <h3>Inspector</h3>

      <div className="field-row">
        <label>Start / Duration</label>
        <div>
          {clip.start.toFixed(2)}s · {clip.duration.toFixed(2)}s
        </div>
      </div>

      {clip.kind === 'text' && (
        <>
          <div className="field-row">
            <label>Text</label>
            <input type="text" value={clip.text} onChange={(e) => updateTextClip(clip.id, { text: e.target.value })} />
          </div>
          <div className="field-row">
            <label>Font size</label>
            <input
              type="number"
              value={clip.fontSize}
              onChange={(e) => updateTextClip(clip.id, { fontSize: Number(e.target.value) })}
            />
          </div>
          <div className="field-row">
            <label>Color</label>
            <input type="text" value={clip.color} onChange={(e) => updateTextClip(clip.id, { color: e.target.value })} />
          </div>
          <div className="field-row">
            <label>Position X ({clip.transform.x.toFixed(2)})</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clip.transform.x}
              onChange={(e) => updateTextClip(clip.id, { transform: { ...clip.transform, x: Number(e.target.value) } })}
            />
          </div>
          <div className="field-row">
            <label>Position Y ({clip.transform.y.toFixed(2)})</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clip.transform.y}
              onChange={(e) => updateTextClip(clip.id, { transform: { ...clip.transform, y: Number(e.target.value) } })}
            />
          </div>
          <div className="field-row">
            <label>
              <input type="checkbox" checked={clip.bold} onChange={(e) => updateTextClip(clip.id, { bold: e.target.checked })} /> Bold
            </label>
          </div>
        </>
      )}

      {clip.kind === 'media' && (
        <>
          <div className="field-row">
            <label>Volume ({Math.round(clip.volume * 100)}%)</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clip.volume}
              onChange={(e) => updateMediaClipProps(clip.id, { volume: Number(e.target.value) })}
            />
          </div>
          <div className="field-row">
            <label>
              <input type="checkbox" checked={clip.muted} onChange={(e) => updateMediaClipProps(clip.id, { muted: e.target.checked })} /> Muted
            </label>
          </div>
        </>
      )}

      {canHaveTransition && (
        <div className="field-row">
          <label>Transition in ({(clip.transitionIn?.duration ?? 0).toFixed(2)}s crossfade)</label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={clip.transitionIn?.duration ?? 0}
            onChange={(e) => setTransition(clip.id, Number(e.target.value))}
          />
        </div>
      )}

      {canMerge && (
        <button onClick={() => mergeWithNext(clip.id)} style={{ width: '100%', marginTop: 12 }} title="Rejoin with the next clip (undoes a Split)">
          Merge with next clip
        </button>
      )}

      <button onClick={() => removeClip(clip.id)} style={{ width: '100%', marginTop: 12 }}>
        Delete clip
      </button>
    </div>
  )
}
