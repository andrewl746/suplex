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
 *
 * Whatever a pull does, the sheet ends on one of its stops with nothing of the pull left on it. A
 * pull follows one finger and ignores any other; it is finished, never dropped, when the touch is
 * cancelled, the page is hidden or the sheet is drawn again part-way through; and a touch that finds
 * a pull's leftovers clears them first. app.css keeps the browser's own scrolling and zooming off a
 * sheet that is not open, so the page under it never moves with a pull.
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
/** A pull by the handle can end in a click on it; one this soon after is the pull's, not a tap (ms). */
const HANDLE_CLICK_AFTER_PULL_MS = 400

type Pull = {
  /** The finger this pull follows. */
  id: number
  /** What it landed on: the touch's events go there for as long as it lasts. */
  target: EventTarget
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

/** Which sheet the page's `--sheet-rest` belongs to: the one drawn last. A sheet on its way out (the
 *  lot's, as the ward's comes in) must not put its own height back. */
const restOwner = new WeakMap<HTMLElement, HTMLElement>()

/** The put-away height for app.css (--sheet-min) and, while this sheet is put away, the same height on
 *  the page (--sheet-rest) for everything that sits on the sheet. Safe to call at any time. */
function carryRest(panel: HTMLElement, stop: Stop): void {
  const min = `${minHeight(panel)}px`
  if (panel.style.getPropertyValue('--sheet-min') !== min) panel.style.setProperty('--sheet-min', min)
  const app = panel.closest<HTMLElement>('.app')
  if (!app || restOwner.get(app) !== panel) return
  const rest = stop === 'min' ? min : ''
  if (app.style.getPropertyValue('--sheet-rest') !== rest) {
    if (rest) app.style.setProperty('--sheet-rest', rest)
    else app.style.removeProperty('--sheet-rest')
  }
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
  /** When a pull by the handle last ended, for the click that can follow it. */
  const handlePullEndedAt = useRef(-Infinity)

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

  // This sheet is the one the page's --sheet-rest follows, from when it is drawn until it goes.
  useLayoutEffect(() => {
    const el = panel.current
    const app = el?.closest<HTMLElement>('.app')
    if (!el || !app || !sheet) return
    restOwner.set(app, el)
    return () => {
      if (restOwner.get(app) !== el) return
      restOwner.delete(app)
      app.style.removeProperty('--sheet-rest')
    }
  }, [sheet])

  // After every draw: the heights as they now are (the footer can change), and nothing of a pull left
  // on a sheet that is not being pulled.
  const pulling = useRef(false)
  useLayoutEffect(() => {
    const el = panel.current
    if (!el || !sheet) return
    carryRest(el, at)
    if (!pulling.current && (el.style.height || el.dataset.dragging !== undefined)) {
      el.style.height = ''
      delete el.dataset.dragging
    }
  })

  // The stops' heights as the layout now has them, read when a pull needs them: a window that changes
  // size part-way through a pull (a phone's toolbar sliding away) must not end the pull.
  const heights = useRef({ peek: 0, full: 0 })
  useEffect(() => {
    heights.current = { peek: layout.sheetPeekPx, full: layout.height - layout.sheetTopPx }
  }, [layout])

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
      pulling.current = false
      carryRest(el, next)
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
        ['peek', heights.current.peek],
        ['full', heights.current.full],
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

    const touchOf = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
      return null
    }

    const onTouchMove = (event: Event) => {
      if (!pull || pull.mode === 'scroll') return
      const touch = touchOf((event as TouchEvent).touches, pull.id)
      if (!touch) return
      const dy = touch.clientY - pull.y
      const dx = touch.clientX - pull.x
      if (pull.mode === 'undecided') {
        if (Math.abs(dy) < PULL_START_PX && Math.abs(dx) < PULL_START_PX) return
        // Sideways belongs to whatever scrolls sideways (the design tabs on a short screen). An open
        // sheet scrolls its content, except from its handle or when pulled down from the top.
        const pulls = Math.abs(dy) > Math.abs(dx) && (pull.from !== 'full' || pull.fromHandle || (pull.atTop && dy > 0))
        pull.mode = pulls ? 'pull' : 'scroll'
        if (!pulls) return
        pulling.current = true
        el.dataset.dragging = ''
      }
      if (event.cancelable) event.preventDefault()
      const height = Math.min(heights.current.full, Math.max(minHeight(el), pull.height - dy))
      el.style.height = `${height}px`
      const dt = event.timeStamp - pull.lastT
      if (dt > 0) pull.speed = (pull.lastY - touch.clientY) / dt
      pull.lastY = touch.clientY
      pull.lastT = event.timeStamp
    }

    // A touch's events go to what it landed on. That is inside the sheet, so they reach the sheet's own
    // listeners below; but if what it landed on leaves the page while the finger is down (the content
    // drawn again), they would reach nothing, so the same handlers also listen on the thing itself and
    // answer only then.
    const ifGone = (handler: (event: Event) => void) => (event: Event) => {
      if (event.target instanceof Node && el.contains(event.target)) return
      handler(event)
    }
    const moveIfGone = ifGone(onTouchMove)
    const endIfGone = ifGone((event) => onTouchEnd(event))

    /** Ends the pull, however it ended: the sheet goes to a stop and the touch is let go of. */
    const finish = () => {
      const ended = pull
      if (!ended) return
      pull = null
      ended.target.removeEventListener('touchmove', moveIfGone)
      ended.target.removeEventListener('touchend', endIfGone)
      ended.target.removeEventListener('touchcancel', endIfGone)
      if (ended.mode !== 'pull') return
      if (ended.fromHandle) handlePullEndedAt.current = performance.now()
      settle(stopAfter(ended, el.offsetHeight))
    }

    const onTouchEnd = (event: Event) => {
      // Another finger lifting is not this pull's end.
      if (pull && touchOf((event as TouchEvent).touches, pull.id)) return
      finish()
    }

    const onTouchStart = (event: TouchEvent) => {
      // One finger pulls the sheet. Any other that lands meanwhile is ignored, not obeyed.
      if (pull) return
      // Nothing is pulling, so nothing of a pull belongs on the sheet: if an earlier one was lost
      // (its touch taken by the system and never handed back), clear what it left.
      if (el.style.height || el.dataset.dragging !== undefined) settle(now())
      const touch = event.changedTouches[0]
      const target = event.target
      if (!touch || !target) return
      pull = {
        id: touch.identifier,
        target,
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
      target.addEventListener('touchmove', moveIfGone, { passive: false })
      target.addEventListener('touchend', endIfGone)
      target.addEventListener('touchcancel', endIfGone)
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

    // The page going away under a finger (a call, the app switcher) takes the touch with it.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') finish()
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('focusin', onFocusIn)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', finish)
    window.addEventListener('blur', finish)
    return () => {
      finish()
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', finish)
      window.removeEventListener('blur', finish)
      pulling.current = false
      delete el.dataset.dragging
      el.style.height = ''
    }
  }, [canMove])

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
          // Up a stop; from open, back to rest. Not for the click a pull by the handle can end in.
          onClick={() => {
            if (performance.now() - handlePullEndedAt.current < HANDLE_CLICK_AFTER_PULL_MS) return
            setStop(at === 'peek' ? 'full' : 'peek')
          }}
        />
      )}
      {/* Put away, the content has no height: it is out of the keyboard's and screen readers' reach too. */}
      <div ref={body} id={bodyId} className="panel-body" inert={at === 'min'}>
        {children}
      </div>
      {footer}
    </aside>
  )
}
