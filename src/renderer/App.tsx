import { useEffect, useState } from 'react'
import Toolbar from './components/Toolbar'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import Inspector from './components/Inspector'
import Home from './components/Home'
import { useProjectStore } from './state/projectStore'

export default function App() {
  const [view, setView] = useState<'home' | 'editor'>('home')
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
    <div className="app">
      <Toolbar onGoHome={() => setView('home')} />
      <div className="main">
        <MediaBin />
        <div className="preview-area">
          <Preview />
        </div>
        <Inspector />
      </div>
      <Timeline />
    </div>
  )
}
