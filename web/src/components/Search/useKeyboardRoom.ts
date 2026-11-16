import { useEffect, type RefObject } from 'react'

/**
 * Keeps the list of addresses in sight. A phone's keyboard covers the lower half of the page without
 * changing the page's size, so:
 * - the list is never taller than the room between the box and the keyboard (on a desktop, the
 *   window's bottom edge): app.css reads `--search-room` and scrolls the rest of the list;
 * - on the first screen, where the box sits part-way down the card, the card rides up while the
 *   keyboard is open (`lift`), as far as its own top, so the title stays in sight and the list has
 *   the room under the box.
 *   The page is marked `data-keyboard` meanwhile, and app.css takes the button in the top corner out
 *   of the box's way.
 */

/** Left clear between the list and the keyboard, and the least the list is ever given (px). */
const ROOM_GAP_PX = 12
const ROOM_MIN_PX = 96
/** Left clear above the card, or above the box on a short screen, when the card rides up (px from
 *  the top of what shows). */
const LIFT_TOP_PX = 12
/** The list's room the card rides up for: two addresses on a phone (px). */
const ROOM_WANTED_PX = 150
/** The page has lost at least this much height to something before it counts as a keyboard (px). */
const KEYBOARD_MIN_PX = 120

export function useKeyboardRoom(
  input: RefObject<HTMLInputElement | null>,
  list: RefObject<HTMLElement | null>,
  lift: boolean,
): void {
  useEffect(() => {
    const field = input.current
    const drop = list.current
    if (!field || !drop) return
    const viewport = window.visualViewport
    const card = lift ? field.closest<HTMLElement>('.landing-card') : null
    const app = card?.closest<HTMLElement>('.app') ?? null
    // The tallest the window has been at this width: its height with no keyboard, for the browsers
    // that shrink the window itself when one opens.
    let tallest = { width: window.innerWidth, height: window.innerHeight }

    const update = () => {
      if (window.innerWidth !== tallest.width) tallest = { width: window.innerWidth, height: window.innerHeight }
      else tallest.height = Math.max(tallest.height, window.innerHeight)
      const shownTop = viewport?.offsetTop ?? 0
      const shownHeight = viewport?.height ?? window.innerHeight
      const keyboardUp = document.activeElement === field && tallest.height - shownHeight > KEYBOARD_MIN_PX

      // Where the box is with the card where the page laid it out: the card may be part-way through
      // its move, so its present offset is taken back out.
      const box = field.getBoundingClientRect()
      const riddenUp = card ? new DOMMatrixReadOnly(getComputedStyle(card).transform).m42 : 0
      const restTop = box.top - riddenUp
      // No further than its own top reaching the top of what shows, so the title stays in sight;
      // past that (the box itself at the top, as far as it ever goes) only on a screen so short
      // that the list would otherwise get less than ROOM_WANTED_PX.
      let rise = 0
      if (card && keyboardUp) {
        const roomAtRest = shownTop + shownHeight - (restTop + box.height) - ROOM_GAP_PX
        const cardRestTop = card.getBoundingClientRect().top - riddenUp
        const keepsTitle = cardRestTop - shownTop - LIFT_TOP_PX
        const boxAtTop = restTop - shownTop - LIFT_TOP_PX
        const needed = ROOM_WANTED_PX - roomAtRest
        if (needed > 0) rise = Math.max(0, Math.min(boxAtTop, Math.max(keepsTitle, needed)))
      }
      if (card) card.style.transform = rise > 0 ? `translateY(${-rise}px)` : ''
      if (app) app.toggleAttribute('data-keyboard', rise > 0)

      const room = shownTop + shownHeight - (restTop - rise + box.height) - ROOM_GAP_PX
      drop.style.setProperty('--search-room', `${Math.max(ROOM_MIN_PX, Math.round(room))}px`)
    }

    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    field.addEventListener('focus', update)
    field.addEventListener('blur', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      field.removeEventListener('focus', update)
      field.removeEventListener('blur', update)
      if (card) card.style.transform = ''
      app?.removeAttribute('data-keyboard')
    }
  }, [input, list, lift])
}
