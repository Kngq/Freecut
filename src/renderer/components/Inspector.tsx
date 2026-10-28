import { canMergeWithNext, useProjectStore } from '../state/projectStore'
import type { SpeedKeyframe } from '@shared/types'

export default function Inspector() {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const removeClip = useProjectStore((s) => s.removeClip)
  const mergeWithNext = useProjectStore((s) => s.mergeWithNext)
  const setTransition = useProjectStore((s) => s.setTransition)
  const updateTextClip = useProjectStore((s) => s.updateTextClip)
  const updateMediaClipProps = useProjectStore((s) => s.updateMediaClipProps)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setClipSpeedKeyframes = useProjectStore((s) => s.setClipSpeedKeyframes)

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

      {track.type === 'video' && clip.kind === 'media' && (() => {
        const hasCurve = (clip.speedKeyframes?.length ?? 0) >= 2
        const curve = clip.speedKeyframes ?? []

        function updateCurve(next: SpeedKeyframe[]) {
          setClipSpeedKeyframes(clip.id, next)
        }

        return (
          <>
            <div className="field-row">
              <label>
                <input
                  type="checkbox"
                  checked={hasCurve}
                  onChange={(e) => {
                    if (e.target.checked) {
                      updateCurve([
                        { time: clip.trimIn, speed: clip.speed },
                        { time: clip.trimOut, speed: clip.speed }
                      ])
                    } else {
                      setClipSpeedKeyframes(clip.id, undefined)
                    }
                  }}
                />{' '}
                Use speed curve
              </label>
            </div>

            {hasCurve ? (
              <div className="field-row">
                <label>Speed curve (source time → speed)</label>
                {curve.map((kf, i) => (
                  <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                    <input
                      type="number"
                      step={0.1}
                      value={kf.time}
                      style={{ width: 64 }}
                      title="Source-relative time (seconds)"
                      onChange={(e) => {
                        const next = [...curve]
                        next[i] = { ...next[i], time: Number(e.target.value) }
                        updateCurve(next)
                      }}
                    />
                    <input
                      type="number"
                      step={0.05}
                      min={0.1}
                      max={4}
                      value={kf.speed}
                      style={{ width: 64 }}
                      title="Speed multiplier"
                      onChange={(e) => {
                        const next = [...curve]
                        next[i] = { ...next[i], speed: Number(e.target.value) }
                        updateCurve(next)
                      }}
                    />
                    <button
                      disabled={curve.length <= 2}
                      title="Remove point"
                      onClick={() => updateCurve(curve.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  style={{ width: '100%' }}
                  onClick={() => {
                    const a = curve[curve.length - 2]
                    const b = curve[curve.length - 1]
                    updateCurve([...curve, { time: (a.time + b.time) / 2, speed: (a.speed + b.speed) / 2 }])
                  }}
                >
                  + Add point
                </button>
              </div>
            ) : (
              <div className="field-row">
                <label>Speed ({clip.speed.toFixed(2)}x)</label>
                <input
                  type="range"
                  min={0.1}
                  max={4}
                  step={0.05}
                  value={clip.speed}
                  onChange={(e) => setClipSpeed(clip.id, Number(e.target.value))}
                />
              </div>
            )}
          </>
        )
      })()}

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
