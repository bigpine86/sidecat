// ── Sidecat zone: "the cat is asleep inside its house" shared state ────────
// Lives in a module store (not React state) because both the main window's
// App logic and the SidecatSettings overlay need it — the settings panel
// shows "sleeping / wake now" without prop drilling through the expand
// machinery.
//
// The snapshot must be stable between emits (useSyncExternalStore rule), so
// time math happens HERE: a slow heartbeat recomputes `napping`/`minLeft`
// while a nap runs, and subscribers only re-render on emit.

import { useSyncExternalStore } from 'react'

export interface NapState {
  /** Epoch ms the cat comes out; 0 = not napping. */
  until: number
  napping: boolean
  /** Whole minutes left, recomputed by the heartbeat — for labels only. */
  minLeft: number
}

let state: NapState = { until: 0, napping: false, minLeft: 0 }
const listeners = new Set<() => void>()
let heartbeat: ReturnType<typeof setInterval> | null = null

function emit(): void {
  listeners.forEach((fn) => fn())
}

function recompute(): void {
  const until = state.until
  const remain = until - Date.now()
  state = {
    until,
    napping: remain > 0,
    minLeft: Math.max(0, Math.ceil(remain / 60_000)),
  }
  if (!state.napping && heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  emit()
}

export function getNapUntil(): number {
  return state.until
}

export function isNapping(): boolean {
  return state.until > Date.now()
}

export function setNapUntil(t: number): void {
  state = { ...state, until: t }
  if (t > Date.now() && !heartbeat) {
    // Keep minLeft ticking down for any watcher; stops itself at expiry.
    heartbeat = setInterval(recompute, 30_000)
  }
  recompute()
}

export function useNap(): NapState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
