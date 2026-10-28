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
  const selectedClipId = useProjectStore((s) => s.selectedClipId)

  useEffect(() => {
    if (view !== 'editor') return
    function onKeyDown(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.code === 'Space') {
        e.preventDefault()
        setIsPlaying(!isPlaying)
      } else if (e.key === 's') {
        splitClipAtPlayhead()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (selectedClipId) removeClip(selectedClipId)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, isPlaying, selectedClipId, setIsPlaying, splitClipAtPlayhead, removeClip])

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
