import { useSyncExternalStore } from 'react'

/** The result panel's width on a wide screen (MASTERSPEC 6.2). The 3D camera centres the lot in what is left. */
export const PANEL_WIDTH_PX = 420

/**
 * How the page is laid out. On a wide screen the result panel is a column down the right side. On a
 * phone held upright it is a sheet along the bottom, which rests at `sheetPeekPx` and can be pulled up
 * over the scene. app.css lays the page out from `data-layout` and the variables App.tsx sets from
 * here, so the numbers below are the only copy.
 */
export type LayoutMode = 'side' | 'sheet'

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Layout {
  mode: LayoutMode
  /** A phone, upright or on its side: the ward map's picker and legend take their short forms. */
  compact: boolean
  width: number
  height: number
  /** The panel's column in the side layout, its outer margin included (--panel-width). */
  panelWidthPx: number
  /** The sheet's resting height in the sheet layout (--sheet-peek). */
  sheetPeekPx: number
  /** The sheet's top edge when pulled all the way up: just under the search bar (--sheet-top). */
  sheetTopPx: number
  /** What the panel and the search bar cover. The lot, the plan and the ward are centred in the rest. */
  insets: Insets
}

/** A sheet below this width whichever way the screen is turned, and up to SHEET_PORTRAIT_MAX_PX upright. */
const SHEET_MAX_PX = 600
const SHEET_PORTRAIT_MAX_PX = 720
/** The side panel narrows with the window: this share of its width, between these limits. */
const PANEL_SHARE = 0.41
const PANEL_MIN_PX = 340
/** The sheet rests at this share of the screen's height, between these limits: room for the address,
 *  the four design tabs and the footer (app.css lays the tabs in one row on a short screen). */
const SHEET_PEEK_SHARE = 0.46
const SHEET_PEEK_MIN_PX = 236
const SHEET_PEEK_MAX_PX = 320
/** The search bar over the sheet layout: its bottom edge, and the sheet's top edge when fully open. */
const SHEET_BAR_BOTTOM_PX = 68
const SHEET_TOP_PX = 72
/** A side layout no taller than this is a phone on its side (app.css uses the same height). */
const SHORT_MAX_PX = 520

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function compute(width: number, height: number): Layout {
  const sheet = width <= SHEET_MAX_PX || (width <= SHEET_PORTRAIT_MAX_PX && height >= width)
  if (sheet) {
    const sheetPeekPx = clamp(Math.round(height * SHEET_PEEK_SHARE), SHEET_PEEK_MIN_PX, SHEET_PEEK_MAX_PX)
    return {
      mode: 'sheet',
      compact: true,
      width,
      height,
      panelWidthPx: 0,
      sheetPeekPx,
      sheetTopPx: SHEET_TOP_PX,
      insets: { top: SHEET_BAR_BOTTOM_PX, right: 0, bottom: sheetPeekPx, left: 0 },
    }
  }
  const panelWidthPx = clamp(Math.round(width * PANEL_SHARE), PANEL_MIN_PX, PANEL_WIDTH_PX)
  return {
    mode: 'side',
    compact: height <= SHORT_MAX_PX,
    width,
    height,
    panelWidthPx,
    sheetPeekPx: 0,
    sheetTopPx: 0,
    insets: { top: 0, right: panelWidthPx, bottom: 0, left: 0 },
  }
}

let cached: Layout | null = null

/** The layout for the window as it is now. The same object until the window's size changes. */
export function currentLayout(): Layout {
  const { innerWidth: width, innerHeight: height } = window
  if (!cached || cached.width !== width || cached.height !== height) cached = compute(width, height)
  return cached
}

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, currentLayout)
}

/** The page's size less what covers it. */
function clearArea(layout: Layout): { width: number; height: number } {
  const { width, height, insets } = layout
  return { width: width - insets.left - insets.right, height: height - insets.top - insets.bottom }
}

/**
 * How much further back the lot's rest view stands so the lot still fits the clear part of the page.
 * The camera's field of view spans the page's full height, so a sheet over the lower half, or a
 * narrow upright screen, leaves the lot less room than the rest distance (Lot3D/view.ts) was set for.
 * 1 on any wide screen, so nothing changes there; in steps, so a few pixels never move the camera.
 */
const FIT_HEIGHT_SHARE = 0.72
const FIT_WIDTH_SHARE = 0.6
const FIT_STEP = 0.05
const FIT_MAX = 2

export function viewFit(layout: Layout = currentLayout()): number {
  const clear = clearArea(layout)
  if (clear.width <= 0 || clear.height <= 0) return 1
  const need = Math.max(1, (FIT_HEIGHT_SHARE * layout.height) / clear.height, (FIT_WIDTH_SHARE * layout.height) / clear.width)
  return Math.min(FIT_MAX, Math.ceil(need / FIT_STEP - 1e-6) * FIT_STEP)
}

/** Room left round the ward when the map fits it: beside the panel, or between the design picker and
 *  the legend over the sheet. The base map's flight out ends on the same view (BaseMap.tsx). */
const WARD_FIT_PADDING_PX = 40
const WARD_FIT_PADDING_COMPACT_PX = 16
/** The short picker's and the short legend's heights with their margins (wardStage.css), which the
 *  ward stays clear of. */
const WARD_PICKER_COMPACT_PX = 68
const WARD_LEGEND_COMPACT_PX = 64

export function wardFitPadding(layout: Layout = currentLayout()): Insets {
  const { insets } = layout
  if (layout.compact) {
    const p = WARD_FIT_PADDING_COMPACT_PX
    return {
      top: WARD_PICKER_COMPACT_PX + p,
      right: insets.right + p,
      bottom: insets.bottom + WARD_LEGEND_COMPACT_PX + p,
      left: p,
    }
  }
  const p = WARD_FIT_PADDING_PX
  return { top: p, right: insets.right + p, bottom: p, left: p }
}
