// ── Sidecat zone: where the house window sits ─────────────────────────────
// HouseWindow owns the real placement — it parks on the primary monitor's
// bottom-right corner, just above the taskbar. We reproduce that formula
// here so other features ("send the cat home", nap re-entry) can find the
// same spot without IPC between the two windows. Keep HOUSE_PX and the
// margin in sync with HouseWindow.tsx.

import { primaryMonitor } from '@tauri-apps/api/window'

const HOUSE_PX = 56

export interface HouseAnchor {
  /** Physical-px top-left for the cat window standing on the doorstep —
   *  bottom-aligned with the house's right half, overlapping it slightly. */
  doorX: number
  doorY: number
  /** Physical-px top-left for the cat having just stepped OUT — the spot it
   *  slides to when it comes back out (left of the house). */
  stepX: number
  stepY: number
}

export async function houseAnchor(spriteSize: number): Promise<HouseAnchor | null> {
  try {
    const mon = await primaryMonitor()
    if (!mon) return null
    const scale = mon.scaleFactor || 1
    // Same taskbar estimate HouseWindow uses: total minus available height.
    const taskbarH = (window.screen.height - window.screen.availHeight) * scale
    const margin = 8 * scale
    const house = HOUSE_PX * scale
    const houseX = mon.position.x + mon.size.width - house - margin
    const houseBottom = mon.position.y + mon.size.height - taskbarH - margin
    const cat = spriteSize * scale
    return {
      doorX: Math.round(houseX + house - cat),
      doorY: Math.round(houseBottom - cat),
      stepX: Math.round(houseX - cat - 4 * scale),
      stepY: Math.round(houseBottom - cat),
    }
  } catch {
    return null
  }
}
