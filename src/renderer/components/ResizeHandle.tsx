interface ResizeHandleProps {
  orientation: 'vertical' | 'horizontal'
  /** The current size (px) of the panel this handle resizes. */
  value: number
  onChange: (next: number) => void
  /** Set when the panel is anchored to the opposite edge from where the handle sits (e.g. the
   *  Inspector's handle is on its left edge, so dragging left should grow it, not shrink it). */
  invert?: boolean
}

/** A thin draggable bar between two panels. `vertical` resizes a width (drag left/right),
 *  `horizontal` resizes a height (drag up/down) — same raw mousedown/mousemove/mouseup pattern
 *  Timeline.tsx already uses for clip dragging, no resizable-panel library needed. */
export default function ResizeHandle({ orientation, value, onChange, invert }: ResizeHandleProps) {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startPos = orientation === 'vertical' ? e.clientX : e.clientY
    const startValue = value
    const prevCursor = document.body.style.cursor
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'

    function onMove(ev: MouseEvent) {
      const currentPos = orientation === 'vertical' ? ev.clientX : ev.clientY
      const rawDelta = currentPos - startPos
      onChange(startValue + (invert ? -rawDelta : rawDelta))
    }
    function onUp() {
      document.body.style.cursor = prevCursor
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return <div className={`resize-handle resize-handle-${orientation}`} onMouseDown={onMouseDown} />
}
