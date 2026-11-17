import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLayout } from '../../layout'
import { Blueprint } from '../Landing/Blueprint'

/**
 * The box the result panel and the ward panel share (app.css .panel), on the landing card's drafting
 * sheet (Landing/Blueprint.tsx), whose outer rule is the panel's edge: the content scrolls inside the
 * ruled area, and `footer` stays under it.
 *
 * On a phone (layout.ts, the sheet layout) the same box lies along the bottom of the screen, with the
 * scene, the plan or the map above it, and has three stops:
 * - at rest ('peek'), at the layout's peek height;
 * - open ('full'), up to just under the search bar, where its content scrolls;
 * - put away ('min'), down to its handle and its footer, so the picture has the screen. The footer
 *   stays because the screening line is on it, and that line is on screen with every result.
 * A pull anywhere on the sheet moves it between them (from the open sheet, a pull by the handle or
 * down from the top of its content), a long pull past the middle stop, and its handle is a button, so
 * the keyboard and screen readers open it too. While it is put away, `--sheet-rest` on the page holds
 * its height, and what sits on the sheet (the map's controls, the scene's labels) follows it down.
 */

type Stop = 'min' | 'peek' | 'full'

/** A pull this far, or a flick this fast, moves the sheet to its next stop; less and it springs back. */
const SNAP_TRAVEL_PX = 48
const FLICK_PX_PER_MS = 0.45
/** A touch has to move this far before it counts as a pull, so a tap on a tab stays a tap. */
const PULL_START_PX = 8
/** Put away, the sheet is its footer under the frame's top band (app.css pads the sheet by it). */
const TOP_BAND_PX = 20
/** The put-away height until the footer has been measured. */
const MIN_FALLBACK_PX = 84

type Pull = {
  y: number
  x: number
  height: number
  from: Stop
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

/** The sheet's put-away height: the top band and the footer. */
function minHeight(panel: HTMLElement): number {
  const footer = panel.querySelector<HTMLElement>(':scope > .panel-footer')
  return footer ? TOP_BAND_PX + footer.offsetHeight : MIN_FALLBACK_PX
}

export function PanelSheet({ children, footer, busy = false, className, label, handleLabel, resetKey = '' }: Props) {
  const layout = useLayout()
  const sheet = layout.mode === 'sheet'
  const canMove = sheet && handleLabel !== undefined
  const panel = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const [stop, setStop] = useState<Stop>('peek')
  const [seenKey, setSeenKey] = useState(resetKey)
  if (seenKey !== resetKey) {
    setSeenKey(resetKey)
    setStop('peek')
  }
  const at: Stop = canMove ? stop : 'peek'

  // The scrollbar runs down the band beside the ruled area, so app.css takes its width (0 where
  // scrollbars float over the page) out of the band's padding instead of the content.
  useLayoutEffect(() => {
    const el = body.current
    if (el) el.style.setProperty('--scrollbar', `${el.offsetWidth - el.clientWidth}px`)
  }, [sheet])

  // Unless it is open, the content starts from its top again.
  useEffect(() => {
    if (sheet && at !== 'full' && body.current) body.current.scrollTop = 0
  }, [sheet, at, resetKey])

  // The put-away height for app.css (--sheet-min), and, while the sheet is put away, the same height
  // on the page (--sheet-rest) for everything that sits on the sheet. Another sheet (the plan's, the
  // ward's) starts at rest, so leaving nothing behind here is enough.
  useLayoutEffect(() => {
    const el = panel.current
    if (!el || !sheet) return
    const app = el.closest<HTMLElement>('.app')
    const min = minHeight(el)
    el.style.setProperty('--sheet-min', `${min}px`)
    if (at === 'min') app?.style.setProperty('--sheet-rest', `${min}px`)
    return () => {
      el.style.removeProperty('--sheet-min')
      app?.style.removeProperty('--sheet-rest')
    }
  }, [sheet, at, footer])

  const peekPx = layout.sheetPeekPx
  const fullPx = layout.height - layout.sheetTopPx

  useEffect(() => {
    const el = panel.current
    const scroller = body.current
    if (!canMove || !el || !scroller) return
    let pull: Pull | null = null
    const now = (): Stop => (el.dataset.sheet as Stop | undefined) ?? 'peek'

    const settle = (next: Stop) => {
      // The attribute first and the pulled height off in the same breath, so the sheet eases from
      // where the finger left it to its stop; React then renders the same attribute. The page's
      // --sheet-rest goes with it, so what sits on the sheet moves at the same time.
      const min = minHeight(el)
      el.style.setProperty('--sheet-min', `${min}px`)
      const app = el.closest<HTMLElement>('.app')
      if (next === 'min') app?.style.setProperty('--sheet-rest', `${min}px`)
      else app?.style.removeProperty('--sheet-rest')
      el.dataset.sheet = next
      delete el.dataset.dragging
      el.style.height = ''
      setStop(next)
    }

    /** Where a pull that ended at `height` leaves the sheet: back where it began unless it went far or
     *  fast enough, else the next stop that way, or the one after if it was pulled well past that. */
    const stopAfter = (ended: Pull, height: number): Stop => {
      const stops: [Stop, number][] = [
        ['min', minHeight(el)],
        ['peek', peekPx],
        ['full', fullPx],
      ]
      const travel = height - ended.height
      const way =
        travel > SNAP_TRAVEL_PX || (travel >= 0 && ended.speed > FLICK_PX_PER_MS)
          ? 1
          : travel < -SNAP_TRAVEL_PX || (travel <= 0 && ended.speed < -FLICK_PX_PER_MS)
            ? -1
            : 0
      const from = stops.findIndex(([name]) => name === ended.from)
      for (let i = from + way; way !== 0 && i >= 0 && i < stops.length; i += way) {
        const last = i === 0 || i === stops.length - 1
        if (last || (way > 0 ? stops[i][1] >= height - SNAP_TRAVEL_PX : stops[i][1] <= height + SNAP_TRAVEL_PX)) return stops[i][0]
      }
      return ended.from
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
        from: now(),
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
        // Sideways belongs to whatever scrolls sideways (the design tabs on a short screen). An open
        // sheet scrolls its content, except from its handle or when pulled down from the top.
        const pulls = Math.abs(dy) > Math.abs(dx) && (pull.from !== 'full' || pull.fromHandle || (pull.atTop && dy > 0))
        pull.mode = pulls ? 'pull' : 'scroll'
        if (!pulls) return
        el.dataset.dragging = ''
      }
      event.preventDefault()
      // Under the finger the content's own padding still stands (app.css eases it away as the sheet
      // settles), so the sheet stops that much short of its put-away height until it is let go.
      const style = getComputedStyle(scroller)
      const floor = minHeight(el) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const height = Math.min(fullPx, Math.max(floor, pull.height - dy))
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
      settle(stopAfter(ended, el.offsetHeight))
    }

    // A mouse wheel over the sheet brings it up a stop: its content cannot scroll until it is open.
    const onWheel = (event: WheelEvent) => {
      const stopNow = now()
      if (event.deltaY > 0 && stopNow !== 'full') settle(stopNow === 'min' ? 'peek' : 'full')
    }

    // Tabbing to something below the fold opens the sheet rather than scrolling it out from under itself.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element
      if (now() === 'full' || !target.matches(':focus-visible')) return
      if (target.getBoundingClientRect().bottom > scroller.getBoundingClientRect().bottom) settle('full')
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
  }, [canMove, peekPx, fullPx])

  return (
    <aside
      ref={panel}
      className={className ? `panel ${className}` : 'panel'}
      aria-label={label}
      aria-busy={busy || undefined}
      data-sheet={sheet ? at : undefined}
    >
      <Blueprint logo={false} edge />
      {canMove && (
        <button
          type="button"
          className="sheet-handle"
          aria-label={handleLabel}
          aria-expanded={at === 'full'}
          aria-controls={bodyId}
          // Up a stop; from open, back to rest.
          onClick={() => setStop(at === 'peek' ? 'full' : 'peek')}
        />
      )}
      <div ref={body} id={bodyId} className="panel-body">
        {children}
      </div>
      {footer}
    </aside>
  )
}
