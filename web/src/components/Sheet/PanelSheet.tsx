import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLayout } from '../../layout'
import { Blueprint } from '../Landing/Blueprint'

/**
 * The box the result panel and the ward panel share (app.css .panel), on the landing card's drafting
 * sheet (Landing/Blueprint.tsx), whose outer rule is the panel's edge: the content scrolls inside the
 * ruled area, and `footer` stays under it.
 *
 * On a phone (layout.ts, the sheet layout) the same box lies along the bottom of the screen. It rests
 * at the layout's peek height, with the scene, the plan or the map above it, and opens to just under
 * the search bar: by its handle (a button, so the keyboard and screen readers open it too), by a pull
 * up anywhere on it, and shut again by a pull down from the top of its content. The footer stays on
 * screen either way.
 */

/** A pull this far, or a flick this fast, moves the sheet to its other stop; less and it springs back. */
const SNAP_TRAVEL_PX = 48
const FLICK_PX_PER_MS = 0.45
/** A touch has to move this far before it counts as a pull, so a tap on a tab stays a tap. */
const PULL_START_PX = 8

type Pull = {
  y: number
  x: number
  height: number
  fromHandle: boolean
  atTop: boolean
  mode: 'undecided' | 'pull' | 'scroll'
  lastY: number
  lastT: number
  /** Pixels per millisecond; positive while the sheet grows. */
  speed: number
}

interface Props {
  children: ReactNode
  footer?: ReactNode
  busy?: boolean
  className?: string
  /** The panel's accessible name, where its content does not give one. */
  label?: string
  /** Names the sheet's handle. Without it the sheet stays at rest: for the loading and error states,
   *  whose few lines fit. */
  handleLabel?: string
  /** A new value (a new address, a new ward) puts the sheet back at rest, scrolled to its top. */
  resetKey?: string
}

export function PanelSheet({ children, footer, busy = false, className, label, handleLabel, resetKey = '' }: Props) {
  const layout = useLayout()
  const sheet = layout.mode === 'sheet'
  const canOpen = sheet && handleLabel !== undefined
  const panel = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const [open, setOpen] = useState(false)
  const [seenKey, setSeenKey] = useState(resetKey)
  if (seenKey !== resetKey) {
    setSeenKey(resetKey)
    setOpen(false)
  }
  const isOpen = canOpen && open

  // The scrollbar runs down the band beside the ruled area, so app.css takes its width (0 where
  // scrollbars float over the page) out of the band's padding instead of the content.
  useLayoutEffect(() => {
    const el = body.current
    if (el) el.style.setProperty('--scrollbar', `${el.offsetWidth - el.clientWidth}px`)
  }, [sheet])

  // At rest the content starts from its top again.
  useEffect(() => {
    if (sheet && !isOpen && body.current) body.current.scrollTop = 0
  }, [sheet, isOpen, resetKey])

  const peekPx = layout.sheetPeekPx
  const fullPx = layout.height - layout.sheetTopPx

  useEffect(() => {
    const el = panel.current
    const scroller = body.current
    if (!canOpen || !el || !scroller) return
    let pull: Pull | null = null

    const settle = (next: boolean) => {
      // The attribute first and the pulled height off in the same breath, so the sheet eases from
      // where the finger left it to its stop; React then renders the same attribute.
      el.dataset.sheet = next ? 'full' : 'peek'
      delete el.dataset.dragging
      el.style.height = ''
      setOpen(next)
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        pull = null
        return
      }
      const touch = event.touches[0]
      const target = event.target
      pull = {
        y: touch.clientY,
        x: touch.clientX,
        height: el.offsetHeight,
        fromHandle: target instanceof Element && target.closest('.sheet-handle') !== null,
        atTop: scroller.scrollTop <= 0,
        mode: 'undecided',
        lastY: touch.clientY,
        lastT: event.timeStamp,
        speed: 0,
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!pull || pull.mode === 'scroll') return
      const touch = event.touches[0]
      const dy = touch.clientY - pull.y
      const dx = touch.clientX - pull.x
      if (pull.mode === 'undecided') {
        if (Math.abs(dy) < PULL_START_PX && Math.abs(dx) < PULL_START_PX) return
        const opened = el.dataset.sheet === 'full'
        // Sideways belongs to whatever scrolls sideways (the design tabs on a short screen). An open
        // sheet scrolls its content, except from its handle or when pulled down from the top.
        const pulls = Math.abs(dy) > Math.abs(dx) && (!opened || pull.fromHandle || (pull.atTop && dy > 0))
        pull.mode = pulls ? 'pull' : 'scroll'
        if (!pulls) return
        el.dataset.dragging = ''
      }
      event.preventDefault()
      const height = Math.min(fullPx, Math.max(peekPx, pull.height - dy))
      el.style.height = `${height}px`
      const dt = event.timeStamp - pull.lastT
      if (dt > 0) pull.speed = (pull.lastY - touch.clientY) / dt
      pull.lastY = touch.clientY
      pull.lastT = event.timeStamp
    }

    const onTouchEnd = () => {
      const ended = pull
      pull = null
      if (!ended || ended.mode !== 'pull') return
      const opened = el.dataset.sheet === 'full'
      const travel = el.offsetHeight - ended.height
      const next = opened
        ? !(travel < -SNAP_TRAVEL_PX || ended.speed < -FLICK_PX_PER_MS)
        : travel > SNAP_TRAVEL_PX || ended.speed > FLICK_PX_PER_MS
      settle(next)
    }

    // A mouse wheel over the resting sheet opens it: its content cannot scroll until it is open.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY > 0 && el.dataset.sheet !== 'full') settle(true)
    }

    // Tabbing to something below the fold opens the sheet rather than scrolling it out from under itself.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element
      if (el.dataset.sheet === 'full' || !target.matches(':focus-visible')) return
      if (target.getBoundingClientRect().bottom > scroller.getBoundingClientRect().bottom) settle(true)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('focusin', onFocusIn)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('focusin', onFocusIn)
      delete el.dataset.dragging
      el.style.height = ''
    }
  }, [canOpen, peekPx, fullPx])

  return (
    <aside
      ref={panel}
      className={className ? `panel ${className}` : 'panel'}
      aria-label={label}
      aria-busy={busy || undefined}
      data-sheet={sheet ? (isOpen ? 'full' : 'peek') : undefined}
    >
      <Blueprint logo={false} edge />
      {canOpen && (
        <button
          type="button"
          className="sheet-handle"
          aria-label={handleLabel}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={() => setOpen(!isOpen)}
        />
      )}
      <div ref={body} id={bodyId} className="panel-body">
        {children}
      </div>
      {footer}
    </aside>
  )
}
