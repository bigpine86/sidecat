// ── Sidecat zone: cross-monitor positioning ───────────────────────────────────
// Mixed-DPI multi-monitor setups (e.g. 2x Retina laptop + 1x external) make
// window positioning treacherous: get_cursor_pos scales CGEvent's logical
// points by the PRIMARY monitor's scale, monitor bounds arrive in EACH
// monitor's own physical scale, and PhysicalPosition→point conversion divides
// by the moved window's CURRENT monitor scale. Mixing these spaces put panels
// off-screen or clipped on the second display.
//
// The convention that provably round-trips in this app (openBubble, pet
// movement): PhysicalPosition(p) lands at global point p / winScale, where
// winScale is the scale factor of the monitor the window currently sits on.
// So positioning the window on ITS OWN monitor is always safe — encode the
// logical destination as logical × winScale. These helpers stay inside that
// guaranteed space: panels open centred on the cat's own monitor.

import { currentMonitor } from '@tauri-apps/api/window'

export interface LogicalRect {
  x: number
  y: number
  w: number
  h: number
}

export interface MonitorPlacement {
  /** Logical bounds of the monitor containing the cat window. */
  mon: LogicalRect
  /** Scale factor of the cat's monitor — multiply logical coords by this to
   *  get the PhysicalPosition value that lands there. */
  winScale: number
}

export async function catMonitorPlacement(): Promise<MonitorPlacement> {
  const catMon = await currentMonitor()
  if (!catMon) {
    return {
      mon: { x: 0, y: 0, w: window.screen.availWidth, h: window.screen.availHeight },
      winScale: window.devicePixelRatio || 1,
    }
  }
  return {
    mon: {
      x: catMon.position.x / catMon.scaleFactor,
      y: catMon.position.y / catMon.scaleFactor,
      w: catMon.size.width / catMon.scaleFactor,
      h: catMon.size.height / catMon.scaleFactor,
    },
    winScale: catMon.scaleFactor,
  }
}

/** Centre a w×h logical panel on the cat's monitor; returns the global
 *  physical-pixel position to feed PhysicalPosition/set_position. */
export function centeredPanelPosition(
  place: MonitorPlacement,
  w: number,
  h: number
): { x: number; y: number } {
  const { mon, winScale } = place
  const xLog = mon.x + Math.max(0, (mon.w - w) / 2)
  const yLog = mon.y + Math.max(0, (mon.h - h) / 2)
  return { x: Math.round(xLog * winScale), y: Math.round(yLog * winScale) }
}
