import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import { SequenceContext, type SequenceState } from './useSequence'
import type { Timeline } from './timeline'

type Restart = 'start' | 'replay'

/**
 * Owns the sequence clock. A new lot plays the whole sequence; a new design on the same lot jumps
 * back to step 4 so the street stays built and steps 4 to 7 replay (MASTERSPEC 6.3). So does the
 * same lot shown again, back from the plan view or the ward (MASTERSPEC 6.6).
 *
 * The restart is applied on the next frame drawn while the scene shows, before any other frame
 * callback: the hidden canvas draws only stray frames (WarmUp's, and one more as the scene hides),
 * on which the clock holds a timestamp in milliseconds.
 *
 * The canvas's clock starts again from zero each time the scene is hidden and each time it is shown
 * (react-three-fiber does that whenever the frameloop changes). It is carried on from the last
 * frame drawn instead, so every time taken from it earlier (t0, the camera's last drag, the labels'
 * last camera move) stays in the past. Left at zero, the timeline fell back to before its start:
 * the lot stood empty for as long as the scene had run before the sequence last restarted (a design
 * picked, or an address opened without a flight), and then the whole sequence played again.
 */
export function Sequence({
  lotKey,
  designKey,
  timeline,
  reduced,
  children,
}: {
  lotKey: string
  designKey: string
  timeline: Timeline
  reduced: boolean
  children: ReactNode
}) {
  const state = useRef<SequenceState>({ t0: 0, timeline, reduced })
  const last = useRef<{ lotKey: string; designKey: string } | null>(null)
  const restart = useRef<Restart | null>(null)
  /** The clock at the last frame drawn. */
  const drawnAt = useRef(0)

  useLayoutEffect(() => {
    const s = state.current
    s.timeline = timeline
    s.reduced = reduced
    const previous = last.current
    if (!previous || previous.lotKey !== lotKey) restart.current = 'start'
    else if (previous.designKey !== designKey) restart.current = 'replay'
    last.current = { lotKey, designKey }
  }, [lotKey, designKey, timeline, reduced])

  // Negative priority: before the camera controls (-1) and every component (0).
  useFrame(({ clock, frameloop }) => {
    const shownAgain = clock.elapsedTime < drawnAt.current
    if (shownAgain) clock.elapsedTime += drawnAt.current
    drawnAt.current = clock.elapsedTime
    if (frameloop === 'never') return
    const r = restart.current ?? (shownAgain ? 'replay' : null)
    if (!r) return
    const s = state.current
    s.t0 = clock.elapsedTime - (r === 'replay' ? s.timeline.oldHouse.start : 0)
    restart.current = null
  }, -2)

  return <SequenceContext.Provider value={state}>{children}</SequenceContext.Provider>
}
