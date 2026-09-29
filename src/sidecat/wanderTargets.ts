// ── Sidecat zone: edge-biased wander targets ──────────────────────────────────
// usePetMovement calls this one function; the policy itself lives here so an
// upstream merge can never overwrite how the cat picks its destinations.
//
// ~72% of targets land in a band along one edge of the pet's current monitor,
// so the cat lives at the screen margins and doesn't cover the user's work.
// The remaining picks go anywhere — occasional centre visits keep it charming
// rather than annoying.

export interface MonBounds {
  x: number
  y: number
  width: number
  height: number
}

// Where the cat is allowed to roam, chosen in Settings:
//   free   — every monitor's edge is fair game
//   single — confined to whichever monitor it currently sits on
//   home   — treats the primary monitor as home and wanders back when away
export type MonitorScope = 'free' | 'single' | 'home'

const EDGE_BIAS = 0.72
const EDGE_BAND_PX = 140
// In 'home' scope the cat still gets to play away from home sometimes —
// 25% of picks stay on the away monitor, the rest point back home.
const HOMESICK_BIAS = 0.75

function pickInMon(mon: MonBounds, windowSize: number, scale: number): { x: number; y: number } {
  const margin = windowSize * scale
  const spanW = Math.max(1, mon.width - margin * 2)
  const spanH = Math.max(1, mon.height - margin * 2)
  const band = Math.min(EDGE_BAND_PX * scale, Math.min(mon.width, mon.height) / 4)

  if (Math.random() < EDGE_BIAS) {
    const edge = Math.floor(Math.random() * 4)
    const r1 = Math.random()
    const r2 = Math.random()
    switch (edge) {
      case 0: // top band
        return { x: mon.x + margin + r1 * spanW, y: mon.y + margin + r2 * band }
      case 1: // bottom band
        return { x: mon.x + margin + r1 * spanW, y: mon.y + mon.height - margin - r2 * band }
      case 2: // left band
        return { x: mon.x + margin + r1 * band, y: mon.y + margin + r2 * spanH }
      default: // right band
        return { x: mon.x + mon.width - margin - r1 * band, y: mon.y + margin + r2 * spanH }
    }
  }
  return {
    x: mon.x + margin + Math.random() * spanW,
    y: mon.y + margin + Math.random() * spanH,
  }
}

export function pickWanderTarget(
  mon: MonBounds,
  windowSize: number,
  scale: number,
  scope: MonitorScope = 'free',
  homeMon: MonBounds | null = null,
  onHome = true
): { x: number; y: number } {
  // Homesick: on an away monitor, mostly aim at the home monitor's edge —
  // the normal monitor-cross sequence carries the pet back there.
  if (scope === 'home' && !onHome && homeMon && Math.random() < HOMESICK_BIAS) {
    return pickInMon(homeMon, windowSize, scale)
  }
  return pickInMon(mon, windowSize, scale)
}
