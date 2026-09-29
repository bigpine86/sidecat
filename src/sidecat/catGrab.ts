import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { useConfigStore } from '../store/configStore'

// ── Sidecat zone: grab & throw ────────────────────────────────────────────────
// Closed-state pet interaction: press-and-drag relocates the cat; releasing
// with speed flings it — the window slides with friction and clamps inside
// the current monitor. App.tsx keeps only the seam in handleMouseDown.

export interface CatGrabDeps {
  setPetDragging: (v: boolean) => void
  petDragMovedRef: { current: boolean }
}

export function beginCatGrab(deps: CatGrabDeps): void {
  const { setPetDragging, petDragMovedRef } = deps
  const win = getCurrentWindow()
  petDragMovedRef.current = false
  setPetDragging(true)
  void (async () => {
    try {
      const [winPos, cursor0, monitor] = await Promise.all([
        win.outerPosition(),
        invoke<{ x: number; y: number }>('get_cursor_pos'),
        currentMonitor(),
      ])
      const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1
      const grabDx = cursor0.x - winPos.x
      const grabDy = cursor0.y - winPos.y
      const trail: { x: number; y: number; t: number }[] = [
        { x: cursor0.x, y: cursor0.y, t: performance.now() },
      ]

      const onMove = (ev: MouseEvent) => {
        const cx = ev.screenX * scale
        const cy = ev.screenY * scale
        trail.push({ x: cx, y: cy, t: performance.now() })
        if (trail.length > 10) trail.shift()
        if (Math.abs(cx - cursor0.x) + Math.abs(cy - cursor0.y) > 6 * scale) {
          petDragMovedRef.current = true
        }
        void win
          .setPosition(new PhysicalPosition(Math.round(cx - grabDx), Math.round(cy - grabDy)))
          .catch(() => {})
      }

      const onUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)

        // Release velocity from the last ~120ms of pointer movement.
        const now = performance.now()
        const recent = trail.filter((p) => now - p.t < 120)
        let vx = 0
        let vy = 0
        if (recent.length >= 2) {
          const a = recent[0]
          const b = recent[recent.length - 1]
          const dt = Math.max(1, b.t - a.t)
          vx = (b.x - a.x) / dt
          vy = (b.y - a.y) / dt
        }

        const endX = ev.screenX * scale - grabDx
        const endY = ev.screenY * scale - grabDy
        if (!petDragMovedRef.current || Math.hypot(vx, vy) < 0.25) {
          setPetDragging(false)
          return
        }

        // Fling: slide with friction, clamped inside the current monitor.
        const monX = monitor?.position.x ?? 0
        const monY = monitor?.position.y ?? 0
        const monW = monitor?.size.width ?? window.screen.width * scale
        const monH = monitor?.size.height ?? window.screen.height * scale
        const sz = useConfigStore.getState().config.petSize ?? 64
        const sizePhys = sz * scale
        let px = endX
        let py = endY
        const slide = () => {
          vx *= 0.94
          vy *= 0.94
          px = Math.max(monX, Math.min(px + vx * 16, monX + monW - sizePhys))
          py = Math.max(monY, Math.min(py + vy * 16, monY + monH - sizePhys))
          void win.setPosition(new PhysicalPosition(Math.round(px), Math.round(py))).catch(() => {})
          if (Math.hypot(vx, vy) > 0.05) {
            requestAnimationFrame(slide)
          } else {
            setPetDragging(false)
          }
        }
        requestAnimationFrame(slide)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    } catch {
      setPetDragging(false)
    }
  })()
}
