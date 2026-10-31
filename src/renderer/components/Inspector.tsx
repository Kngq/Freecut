import { useState } from 'react'
import { canMergeWithNext, useProjectStore } from '../state/projectStore'
import {
  EFFECT_CATALOG,
  FONT_CATALOG,
  TRANSITION_CATALOG,
  aspectPresetFor,
  effectCatalogEntry,
  projectDuration,
  type ClipEffect,
  type ClipEffectType,
  type ClipTransform,
  type SpeedKeyframe,
  type TransformKeyframe,
  type TransitionType
} from '@shared/types'

/** Position/scale/opacity editor shared by text and media clips (both have `transform` on
 *  ClipBase) — static sliders, or an editable (time, x, y, scale, opacity) keyframe list once
 *  "Use keyframes" is checked. Mirrors the speed-curve editor's shape in this same file. */
function TransformFields({
  transform,
  duration,
  onChange
}: {
  transform: ClipTransform
  duration: number
  onChange: (t: ClipTransform) => void
}) {
  const hasKf = (transform.keyframes?.length ?? 0) >= 2
  const kfs = transform.keyframes ?? []

  function updateKeyframes(next: TransformKeyframe[]) {
    onChange({ ...transform, keyframes: next })
  }

  function patchKeyframe(i: number, patch: Partial<TransformKeyframe>) {
    const next = [...kfs]
    next[i] = { ...next[i], ...patch }
    updateKeyframes(next)
  }

  return (
    <>
      <div className="field-row">
        <label>
          <input
            type="checkbox"
            checked={hasKf}
            onChange={(e) => {
              if (e.target.checked) {
                const base = { x: transform.x, y: transform.y, scale: transform.scale, opacity: transform.opacity }
                updateKeyframes([
                  { time: 0, ...base },
                  { time: duration, ...base }
                ])
              } else {
                onChange({ ...transform, keyframes: undefined })
              }
            }}
          />{' '}
          Use keyframes
        </label>
      </div>

      {hasKf ? (
        <div className="field-row">
          <label>Keyframes (time, x, y, scale, opacity)</label>
          {kfs.map((kf, i) => (
            <div key={i} style={{ display: 'flex', gap: 3, marginBottom: 4, alignItems: 'center' }}>
              <input
                type="number"
                step={0.1}
                value={kf.time}
                style={{ width: 40 }}
                title="Clip-local time (seconds)"
                onChange={(e) => patchKeyframe(i, { time: Number(e.target.value) })}
              />
              <input type="number" step={0.05} min={0} max={1} value={kf.x} style={{ width: 40 }} title="X (0-1)" onChange={(e) => patchKeyframe(i, { x: Number(e.target.value) })} />
              <input type="number" step={0.05} min={0} max={1} value={kf.y} style={{ width: 40 }} title="Y (0-1)" onChange={(e) => patchKeyframe(i, { y: Number(e.target.value) })} />
              <input
                type="number"
                step={0.05}
                min={0.1}
                max={4}
                value={kf.scale}
                style={{ width: 40 }}
                title="Scale"
                onChange={(e) => patchKeyframe(i, { scale: Number(e.target.value) })}
              />
              <input
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={kf.opacity}
                style={{ width: 40 }}
                title="Opacity"
                onChange={(e) => patchKeyframe(i, { opacity: Number(e.target.value) })}
              />
              <button disabled={kfs.length <= 2} title="Remove point" onClick={() => updateKeyframes(kfs.filter((_, idx) => idx !== i))}>
                ×
              </button>
            </div>
          ))}
          <button
            style={{ width: '100%' }}
            onClick={() => {
              const a = kfs[kfs.length - 2]
              const b = kfs[kfs.length - 1]
              updateKeyframes([
                ...kfs,
                { time: (a.time + b.time) / 2, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scale: (a.scale + b.scale) / 2, opacity: (a.opacity + b.opacity) / 2 }
              ])
            }}
          >
            + Add point
          </button>
        </div>
      ) : (
        <>
          <div className="field-row">
            <label>Position X ({transform.x.toFixed(2)})</label>
            <input type="range" min={0} max={1} step={0.01} value={transform.x} onChange={(e) => onChange({ ...transform, x: Number(e.target.value) })} />
          </div>
          <div className="field-row">
            <label>Position Y ({transform.y.toFixed(2)})</label>
            <input type="range" min={0} max={1} step={0.01} value={transform.y} onChange={(e) => onChange({ ...transform, y: Number(e.target.value) })} />
          </div>
          <div className="field-row">
            <label>Scale ({transform.scale.toFixed(2)}x)</label>
            <input type="range" min={0.1} max={4} step={0.05} value={transform.scale} onChange={(e) => onChange({ ...transform, scale: Number(e.target.value) })} />
          </div>
          <div className="field-row">
            <label>Opacity ({Math.round(transform.opacity * 100)}%)</label>
            <input type="range" min={0} max={1} step={0.01} value={transform.opacity} onChange={(e) => onChange({ ...transform, opacity: Number(e.target.value) })} />
          </div>
        </>
      )}
    </>
  )
}

/** Add/remove/configure the per-clip effect stack. Each effect is a labeled row with a remove
 *  button and one slider per catalog param. Mirrors TransformFields' shape. The rendering math
 *  lives in shared/effects.ts (preview) and ffmpegGraph.ts (export). */
function EffectFields({
  effects,
  onAdd,
  onRemove,
  onParam
}: {
  effects: ClipEffect[]
  onAdd: (type: ClipEffectType) => void
  onRemove: (effectId: string) => void
  onParam: (effectId: string, key: string, value: number) => void
}) {
  return (
    <div className="field-row">
      <label>Effects</label>
      {effects.length === 0 && <div className="empty-hint" style={{ marginBottom: 6 }}>No effects.</div>}
      {effects.map((effect) => {
        const entry = effectCatalogEntry(effect.type)
        return (
          <div key={effect.id} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 6, marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong style={{ fontSize: 12 }}>{entry?.label ?? effect.type}</strong>
              <button title="Remove effect" onClick={() => onRemove(effect.id)}>
                ×
              </button>
            </div>
            {entry?.params.map((p) => {
              const value = typeof effect.params[p.key] === 'number' ? effect.params[p.key] : p.default
              return (
                <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ flex: '0 0 96px', fontSize: 11, color: 'var(--text-dim)' }}>{p.label}</span>
                  <input
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={value}
                    style={{ flex: 1 }}
                    onChange={(e) => onParam(effect.id, p.key, Number(e.target.value))}
                  />
                  <span style={{ flex: '0 0 36px', fontSize: 11, textAlign: 'right' }}>{value}</span>
                </div>
              )
            })}
          </div>
        )
      })}
      <select
        value=""
        style={{ width: '100%' }}
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value as ClipEffectType)
          e.target.value = ''
        }}
      >
        <option value="">+ Add effect…</option>
        {EFFECT_CATALOG.map((entry) => (
          <option key={entry.type} value={entry.type}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export default function Inspector() {
  const project = useProjectStore((s) => s.project)
  const filePath = useProjectStore((s) => s.filePath)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const [tab, setTab] = useState<'video' | 'speed' | 'animation'>('video')
  const removeClip = useProjectStore((s) => s.removeClip)
  const mergeWithNext = useProjectStore((s) => s.mergeWithNext)
  const setTransition = useProjectStore((s) => s.setTransition)
  const setTransitionType = useProjectStore((s) => s.setTransitionType)
  const addClipEffect = useProjectStore((s) => s.addClipEffect)
  const removeClipEffect = useProjectStore((s) => s.removeClipEffect)
  const updateClipEffectParam = useProjectStore((s) => s.updateClipEffectParam)
  const updateTextClip = useProjectStore((s) => s.updateTextClip)
  const updateMediaClipProps = useProjectStore((s) => s.updateMediaClipProps)
  const setClipSpeed = useProjectStore((s) => s.setClipSpeed)
  const setClipSpeedKeyframes = useProjectStore((s) => s.setClipSpeedKeyframes)
  const setClipReversed = useProjectStore((s) => s.setClipReversed)
  const setClipTransform = useProjectStore((s) => s.setClipTransform)

  let found: { track: typeof project.tracks[number]; clip: typeof project.tracks[number]['clips'][number]; index: number } | null = null
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === selectedClipId)
    if (index !== -1) {
      found = { track, clip: track.clips[index], index }
      break
    }
  }

  if (!found) {
    const { width, height, fps, colorSpace } = project.canvas
    const preset = aspectPresetFor(width, height)
    const aspectLabel = preset ? preset.label : `${width}:${height} (custom)`
    const proxied = project.assets.filter((a) => a.previewPath).length
    const totalDur = projectDuration(project)
    const mm = String(Math.floor(totalDur / 60)).padStart(2, '0')
    const ss = String(Math.round(totalDur % 60)).padStart(2, '0')
    return (
      <div className="panel inspector">
        <h3>Project</h3>
        <dl className="detail-list">
          <div className="detail-row"><dt>Name</dt><dd>{project.name}</dd></div>
          <div className="detail-row"><dt>File path</dt><dd className="detail-path" title={filePath ?? 'Unsaved'}>{filePath ?? 'Unsaved'}</dd></div>
          <div className="detail-row"><dt>Aspect ratio</dt><dd>{aspectLabel}</dd></div>
          <div className="detail-row"><dt>Resolution</dt><dd>{width} × {height}</dd></div>
          <div className="detail-row"><dt>Frame rate</dt><dd>{fps} fps</dd></div>
          <div className="detail-row"><dt>Color space</dt><dd>{colorSpace ?? 'Rec. 709 / sRGB'}</dd></div>
          <div className="detail-row"><dt>Duration</dt><dd>{mm}:{ss}</dd></div>
          <div className="detail-row"><dt>Tracks</dt><dd>{project.tracks.length}</dd></div>
          <div className="detail-row"><dt>Media</dt><dd>{project.assets.length} asset{project.assets.length === 1 ? '' : 's'}</dd></div>
          <div className="detail-row"><dt>Proxy</dt><dd>{proxied > 0 ? `${proxied} proxied for preview` : 'None'}</dd></div>
        </dl>
        <div className="empty-hint" style={{ marginTop: 12 }}>Select a clip to edit its properties.</div>
      </div>
    )
  }

  const { track, clip, index } = found
  const firstVideoTrack = project.tracks.find((t) => t.type === 'video')
  const canHaveTransition = track.type === 'video' && track.id === firstVideoTrack?.id && index > 0
  const canMerge = clip.kind === 'media' && canMergeWithNext(project, clip.id)
  // Tabs only apply to media clips ON A VIDEO TRACK (they have speed + animation to adjust).
  // Audio clips show their single volume/mute editor; text clips show the text editor.
  const showTabs = clip.kind === 'media' && track.type === 'video'
  const showVideoTab = !showTabs || tab === 'video'
  const showSpeedTab = showTabs && tab === 'speed'
  const showAnimationTab = showTabs && tab === 'animation'

  return (
    <div className="panel inspector">
      <h3>Inspector</h3>

      <div className="field-row">
        <label>Start / Duration</label>
        <div>
          {clip.start.toFixed(2)}s · {clip.duration.toFixed(2)}s
        </div>
      </div>

      {showTabs && (
        <div className="inspector-tabs">
          <button className={`inspector-tab ${tab === 'video' ? 'active' : ''}`} onClick={() => setTab('video')}>Video</button>
          <button className={`inspector-tab ${tab === 'speed' ? 'active' : ''}`} onClick={() => setTab('speed')}>Adjust Speed</button>
          <button className={`inspector-tab ${tab === 'animation' ? 'active' : ''}`} onClick={() => setTab('animation')}>Animation</button>
        </div>
      )}

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
            <label>Font</label>
            <select
              value={clip.fontFamily ?? 'sans'}
              style={{ width: '100%' }}
              onChange={(e) => updateTextClip(clip.id, { fontFamily: e.target.value })}
            >
              {FONT_CATALOG.map((f) => (
                <option key={f.id} value={f.id} style={{ fontFamily: f.family }}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label>Color</label>
            <input type="text" value={clip.color} onChange={(e) => updateTextClip(clip.id, { color: e.target.value })} />
          </div>
          <div className="field-row">
            <label>
              <input type="checkbox" checked={clip.bold} onChange={(e) => updateTextClip(clip.id, { bold: e.target.checked })} /> Bold
            </label>
          </div>
          <TransformFields transform={clip.transform} duration={clip.duration} onChange={(t) => updateTextClip(clip.id, { transform: t })} />
        </>
      )}

      {clip.kind === 'media' && showVideoTab && (
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
          <EffectFields
            effects={clip.effects ?? []}
            onAdd={(type) => addClipEffect(clip.id, type)}
            onRemove={(effectId) => removeClipEffect(clip.id, effectId)}
            onParam={(effectId, key, value) => updateClipEffectParam(clip.id, effectId, key, value)}
          />
        </>
      )}

      {track.type === 'video' && clip.kind === 'media' && showSpeedTab && (() => {
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

            <div className="field-row">
              <label>
                <input
                  type="checkbox"
                  checked={clip.reversed}
                  onChange={(e) => setClipReversed(clip.id, e.target.checked)}
                />{' '}
                Reversed
              </label>
            </div>
          </>
        )
      })()}

      {clip.kind === 'media' && showAnimationTab && (
        <TransformFields transform={clip.transform} duration={clip.duration} onChange={(t) => setClipTransform(clip.id, t)} />
      )}

      {canHaveTransition && showVideoTab && (
        <>
          <div className="field-row">
            <label>Transition in ({(clip.transitionIn?.duration ?? 0).toFixed(2)}s)</label>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={clip.transitionIn?.duration ?? 0}
              onChange={(e) => setTransition(clip.id, Number(e.target.value))}
            />
          </div>
          {clip.transitionIn && clip.transitionIn.duration > 0 && (
            <div className="field-row">
              <label>Transition type</label>
              <select
                value={clip.transitionIn.type}
                style={{ width: '100%' }}
                onChange={(e) => setTransitionType(clip.id, e.target.value as TransitionType)}
              >
                {TRANSITION_CATALOG.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
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
