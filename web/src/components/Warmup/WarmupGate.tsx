import { type CSSProperties, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { WARMUP_URL } from '../../api/config'
import { fetchWarmup } from '../../api/warmup'
import { labels } from '../../copy'
import { Blueprint } from '../Landing/Blueprint'
import { HandTitle } from '../Landing/HandTitle'

/** How often the server is asked how far it is, while it loads. */
const POLL_MS = 400
/** A warm server answers faster than this, and then no loading screen flashes: on the first load,
 *  and on a later check, where a slow connection alone must not bring the screen back. */
const SHOW_AFTER_MS = 300
const SHOW_AGAIN_AFTER_MS = 700
/** Within a step the bar creeps towards the step's end and closes about two thirds of the gap in
 *  this long, so a long step still moves. It never passes a step the server has not reached. */
const CREEP_MS = 3000
/** The server sleeps after a few idle minutes. Once this long has passed since it last answered, the
 *  next sign of the visitor (a move, a key, a return to the tab) asks again, which also wakes it. */
const ASK_AGAIN_AFTER_MS = 2 * 60_000
/** A start-up this long has failed. */
const GIVE_UP_MS = 90_000
/** The same fade as the landing card's (app.css, .landing-leaving). */
const FADE_MS = 300

type Cover = 'off' | 'on' | 'leaving'

interface View {
  cover: Cover
  /** Why the start-up failed, as the server names it ("paused" once the month's hosting budget is spent). */
  failed: string | null
  /** 0 to 1: how full the bar is drawn. */
  shown: number
  step: string
}

const STEPS: Record<string, string> = labels.warmup.steps
const START: View = { cover: 'off', failed: null, shown: 0, step: 'waking' }
/** The server's name for a month's hosting budget used up (deploy/server/serve.py, PAUSED). */
const PAUSED = 'paused'

/**
 * Holds the app back until the live server has loaded the city, behind a loading screen in the
 * landing card's own look. The server sleeps when nobody is visiting (deploy/server/serve.py), so
 * the first visitor waits a few seconds, and every API request gives up after 3 s (api/config.ts):
 * without this the first search would fail. Without VITE_WARMUP_URL the app renders at once.
 *
 * `preload` is the app's own code on its way; the screen stays until it has arrived too.
 */
export function WarmupGate({ children, preload }: { children: ReactNode; preload: Promise<unknown> }) {
  const [open, setOpen] = useState(WARMUP_URL === null)
  const [view, setView] = useState<View>(START)
  /** Each new value starts a check: the first load, then every return after a quiet spell. */
  const [check, setCheck] = useState(0)
  const answeredAt = useRef(0)
  const checking = useRef(false)

  useEffect(() => {
    if (WARMUP_URL === null) return
    const abort = new AbortController()
    const startedAt = performance.now()
    let timer = 0
    let step = ''
    let stepAt = startedAt
    let shown = 0
    checking.current = true

    const cover = (patch: Partial<View>) => setView((v) => ({ ...v, cover: 'on', ...patch }))
    const showTimer = window.setTimeout(() => cover({}), check === 0 ? SHOW_AFTER_MS : SHOW_AGAIN_AFTER_MS)
    const stop = () => {
      window.clearTimeout(showTimer)
      checking.current = false
    }

    async function ask() {
      const status = await fetchWarmup(abort.signal).catch(() => null)
      if (abort.signal.aborted) return
      const now = performance.now()
      if (status?.ready) {
        answeredAt.current = now
        setView((v) => (v.cover === 'on' ? { ...v, shown: 1, step: 'app' } : v))
        const arrived = await preload.then(
          () => true,
          () => false,
        )
        if (abort.signal.aborted) return
        stop()
        if (!arrived) return cover({ failed: 'app' })
        setOpen(true)
        setView((v) => (v.cover === 'on' ? { ...v, cover: 'leaving', step: 'ready' } : v))
        timer = window.setTimeout(() => setView(START), FADE_MS)
        return
      }
      if (status?.error || now - startedAt > GIVE_UP_MS) {
        stop()
        return cover({ failed: status?.error ?? 'timeout' })
      }
      if (status) {
        if (status.step !== step) {
          step = status.step
          stepAt = now
        }
        const gap = status.until - status.progress
        shown = Math.max(shown, status.progress + gap * (1 - Math.exp(-(now - stepAt) / CREEP_MS)))
        cover({ shown, step })
      }
      timer = window.setTimeout(ask, POLL_MS)
    }
    void ask()

    return () => {
      abort.abort()
      window.clearTimeout(timer)
      stop()
    }
  }, [check, preload])

  // Ask again when the visitor comes back after a quiet spell: the server may have gone to sleep.
  useEffect(() => {
    if (WARMUP_URL === null) return
    const seen = () => {
      if (checking.current || document.visibilityState !== 'visible') return
      if (performance.now() - answeredAt.current > ASK_AGAIN_AFTER_MS) setCheck((n) => n + 1)
    }
    window.addEventListener('pointermove', seen, { passive: true })
    window.addEventListener('keydown', seen)
    window.addEventListener('focus', seen)
    document.addEventListener('visibilitychange', seen)
    return () => {
      window.removeEventListener('pointermove', seen)
      window.removeEventListener('keydown', seen)
      window.removeEventListener('focus', seen)
      document.removeEventListener('visibilitychange', seen)
    }
  }, [])

  return (
    <>
      {open && <Suspense fallback={null}>{children}</Suspense>}
      {view.cover !== 'off' && <WarmupScreen view={view} />}
    </>
  )
}

function WarmupScreen({ view }: { view: View }) {
  const percent = Math.round(view.shown * 100)
  return (
    <section className={view.cover === 'leaving' ? 'warmup warmup-leaving' : 'warmup'} aria-busy={!view.failed}>
      <div className="landing-card warmup-card">
        <Blueprint />
        <div className="landing-head">
          <HandTitle />
        </div>
        {view.failed === PAUSED ? (
          <div className="warmup-failed" role="alert">
            <p>{labels.warmup.paused}</p>
          </div>
        ) : view.failed ? (
          <div className="warmup-failed" role="alert">
            <p>{labels.ui.load_error}</p>
            <button type="button" className="chip" onClick={() => window.location.reload()}>
              {labels.warmup.retry}
            </button>
          </div>
        ) : (
          <div className="warmup-progress">
            <div className="warmup-row">
              <span aria-live="polite">{STEPS[view.step] ?? STEPS.waking}</span>
              <span className="warmup-percent" aria-hidden="true">
                {percent}
                {labels.units.pct}
              </span>
            </div>
            <div
              className="warmup-bar"
              role="progressbar"
              aria-label={labels.warmup.progress_aria}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="warmup-fill" style={{ '--warmup-shown': view.shown } as CSSProperties} />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
