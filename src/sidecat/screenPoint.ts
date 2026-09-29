// ── Sidecat zone: cross-monitor coordinate resolution ─────────────────────────
// Mixed-DPI multi-monitor setups (e.g. 2x Retina laptop + 1x external) make
// physical-pixel position math ambiguous: get_cursor_pos scales CGEvent's
// logical points by the PRIMARY monitor's scale factor, while a window's
// currentMonitor() bounds are physical in ITS OWN scale. Comparing them mixes
// coordinate spaces — panels land off-screen or clipped on the second display.
//
// The unambiguous space is GLOBAL LOGICAL POINTS. Dividing the Rust cursor
// reading by the primary scale always yields it, on any monitor. These helpers
// resolve "where is the cursor / which monitor is it on" in that space, so
// callers clamp in logical coords and position via LogicalPosition (global
// points, scale-independent).

import { invoke } from '@tauri-apps/api/core'
import { availableMonitors, currentMonitor, primaryMonitor } from '@tauri-apps/api/window'

export interface LogicalRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CursorPlacement {
  /** Cursor in global logical points. */
  x: number
  y: number
  /** Logical bounds of the monitor containing the cursor (fallback: cat's monitor, then primary screen guess). */
  mon: LogicalRect
  /** Primary monitor scale — multiply logical coords by this to get the
   *  "primary-scaled physical" numbers that PhysicalPosition/invoke paths
   *  already speak elsewhere in the codebase. */
  primaryScale: number
}

function toLogicalRect(m: {
  position: { x: number; y: number }
  size: { width: number; height: number }
  scaleFactor: number
}): LogicalRect {
  return {
    x: m.position.x / m.scaleFactor,
    y: m.position.y / m.scaleFactor,
    w: m.size.width / m.scaleFactor,
    h: m.size.height / m.scaleFactor,
  }
}

export async function cursorLogicalPoint(): Promise<CursorPlacement> {
  const [cursor, allMons, primary, catMon] = await Promise.all([
    invoke<{ x: number; y: number }>('get_cursor_pos'),
    availableMonitors(),
    primaryMonitor(),
    currentMonitor(),
  ])

  const primaryScale = primary?.scaleFactor ?? catMon?.scaleFactor ?? window.devicePixelRatio ?? 1
  const x = cursor.x / primaryScale
  const y = cursor.y / primaryScale

  const mon = allMons
    .map(toLogicalRect)
    .find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ??
    (catMon ? toLogicalRect(catMon) : null) ?? {
      x: 0,
      y: 0,
      w: window.screen.availWidth,
      h: window.screen.availHeight,
    }

  return { x, y, mon, primaryScale }
}
