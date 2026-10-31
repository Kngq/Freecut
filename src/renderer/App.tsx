import { useEffect, useState } from 'react'
import Toolbar from './components/Toolbar'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import Inspector from './components/Inspector'
import Home from './components/Home'
import ResizeHandle from './components/ResizeHandle'
import { useProjectStore } from './state/projectStore'
import { useLayoutStore } from './state/layoutStore'

export default function App() {
  const [view, setView] = useState<'home' | 'editor'>('home')
  const mediaBinWidth = useLayoutStore((s) => s.mediaBinWidth)
  const inspectorWidth = useLayoutStore((s) => s.inspectorWidth)
  const timelineHeight = useLayoutStore((s) => s.timelineHeight)
  const setMediaBinWidth = useLayoutStore((s) => s.setMediaBinWidth)
  const setInspectorWidth = useLayoutStore((s) => s.setInspectorWidth)
  const setTimelineHeight = useLayoutStore((s) => s.setTimelineHeight)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const splitClipAtPlayhead = useProjectStore((s) => s.splitClipAtPlayhead)
  const removeClip = useProjectStore((s) => s.removeClip)
  const undo = useProjectStore((s) => s.undo)
  const redo = useProjectStore((s) => s.redo)
  const toggleClipFlipH = useProjectStore((s) => s.toggleClipFlipH)
  const rotateClip = useProjectStore((s) => s.rotateClip)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)

  useEffect(() => {
    if (view !== 'editor') return
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      // Don't hijack typing in form fields.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        // Cmd+Z = undo, Cmd+Shift+Z = redo.
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && (e.key === 'b' || e.key === 'B')) {
        // Cmd+B = split at playhead.
        e.preventDefault()
        splitClipAtPlayhead()
      } else if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        // Cmd+Shift+F = flip (rotate 90°) the selected clip.
        e.preventDefault()
        if (selectedClipId) rotateClip(selectedClipId, 90)
      } else if (mod && (e.key === 'm' || e.key === 'M')) {
        // Cmd+M = mirror (horizontal flip) the selected clip.
        e.preventDefault()
        if (selectedClipId) toggleClipFlipH(selectedClipId)
      } else if (e.code === 'Space') {
        e.preventDefault()
        setIsPlaying(!isPlaying)
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedClipId) removeClip(selectedClipId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, isPlaying, selectedClipId, setIsPlaying, splitClipAtPlayhead, removeClip, undo, redo, toggleClipFlipH, rotateClip])

  if (view === 'home') {
    return <Home onEnterEditor={() => setView('editor')} />
  }

  return (
    <div className="app" style={{ gridTemplateRows: `auto 1fr auto ${timelineHeight}px` }}>
      <Toolbar onGoHome={() => setView('home')} />
      <div className="main" style={{ gridTemplateColumns: `${mediaBinWidth}px auto 1fr auto ${inspectorWidth}px` }}>
        <MediaBin />
        <ResizeHandle orientation="vertical" value={mediaBinWidth} onChange={setMediaBinWidth} />
        <div className="preview-area">
          <Preview />
        </div>
        <ResizeHandle orientation="vertical" value={inspectorWidth} onChange={setInspectorWidth} invert />
        <Inspector />
      </div>
      <ResizeHandle orientation="horizontal" value={timelineHeight} onChange={setTimelineHeight} invert />
      <Timeline />
    </div>
  )
}
