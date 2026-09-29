import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { PetRenderer } from './pets/PetRenderer'
import type { PetDefinition } from './types/pet'
import { usePetMovement } from './hooks/usePetMovement'
import { SpeechBubble, type AnnouncementContent, type Message } from './components/SpeechBubble'
import { SettingsPanel } from './components/SettingsPanel'
import { PetSelector } from './components/PetSelector'
import { useConfigStore, isConfigured } from './store/configStore'
import { useAppStore } from './store'
import { createAIProvider, buildContextBlock } from './ai'
import { loadFacts, extractAndSaveFacts } from './ai/memory'
import { startScheduler, type Schedule } from './automation/scheduler'
import { useDesktopContext } from './hooks/useDesktopContext'
import { useMoodEngine } from './hooks/useMoodEngine'
import { useIdleSequencer } from './hooks/useIdleSequencer'
import { useOnboarding, type OmoStatus } from './hooks/useOnboarding'
import { IS_LINUX } from './utils/platform'
import './App.css'

// Onboarding bubble stays up at most this long; user can close earlier via
// the action buttons. After it closes, regular cursor-following resumes.
const ONBOARDING_AUTOCLOSE_MS = 10_000

// "Walk out of the house" slide duration. Pet starts at the house corner
// (bottom-right) and slides left to monitor center-bottom over this period.
const ONBOARDING_SLIDE_MS = 5500

// ─── Layout constants ──────────────────────────────────────────────────────────

const WIN_OPEN_W = 300
// Window height while the bubble is open. Bumped from 300 → 380 to give the
// AI reply room to breathe alongside DEFAULT_MAX_TOKENS = 512. Keep in sync
// with `.speech-bubble__messages { max-height }` in SpeechBubble.css.
const WIN_OPEN_H = 380

// ─── Animation resolver ───────────────────────────────────────────────────────
// Single source of truth for which sprite plays, with two firm rules:
//   1. notificationAlert always wins (pet was teleported to notify the user).
//   2. While WALKING, the directional walk_* animation is sacred — only the
//      edge-hit scratch override is allowed (classic Neko "scratches the wall"
//      behaviour). Idle sequencer / mood / wake flashes never pre-empt a walk.

interface ResolveAnimationArgs {
  petState: 'IDLE' | 'WALKING' | 'NEAR_CURSOR' | 'SLEEPING'
  notificationAlert: boolean
  hasAlert: boolean
  edgeAnimOverride: string | null
  clickWakeAnim: string | null
  idleAnim: string | null
  moodOverride: string | null
  currentAnimation: string
}

function resolveAnimation({
  petState,
  notificationAlert,
  hasAlert,
  edgeAnimOverride,
  clickWakeAnim,
  idleAnim,
  moodOverride,
  currentAnimation,
}: ResolveAnimationArgs): string {
  if (notificationAlert) return hasAlert ? 'alert' : 'idle'
  if (petState === 'WALKING') return edgeAnimOverride ?? currentAnimation
  return edgeAnimOverride ?? clickWakeAnim ?? idleAnim ?? moodOverride ?? currentAnimation
}

// ─── Error messaging ───────────────────────────────────────────────────────────
// Turns a raw provider/transport error into a short, actionable message in the
// pet's voice. Three failure shapes are recognised:
//   • fetch() network failures — "Failed to fetch" / "Load failed" (Anthropic,
//     OpenAI, Gemini run in the WebView).
//   • Rust-proxied connection failures — "<Provider> request failed: …" (the
//     Ollama / NVIDIA paths go through reqwest).
//   • HTTP-status errors — "<Provider> API error: <code> …" (all providers).
// Anything unrecognised falls back to the generic message.

// ── Proactive bark flavours ──────────────────────────────────────────────────
// Weighted, time-of-day aware concept picker: at lunch the cat is hungry, late
// at night it nags the user to sleep, and occasionally it snarks or talks
// weather — a real cat has moods, not a script.
function pickBarkHint(): string {
  const h = new Date().getHours()
  const pool: { w: number; hint: string }[] = [
    { w: 3, hint: '심심하다는 투로 툭 한마디 걸기' },
    { w: 2, hint: '츤츤거리며 놀아달라고 하기' },
    { w: 2, hint: '뭐 그렇게 열심히 하냐고 시비조로 건드리기' },
    {
      w: 1,
      hint: '날씨 얘기 — 가진 도구로 실제 날씨를 조회할 수 있으면 조회해서 알려주고, 없으면 계절·창밖 얘기로 대체',
    },
    { w: 1, hint: '아무 이유 없이 야옹 한 번 울고 튀기' },
  ]
  if (h >= 7 && h <= 10) pool.push({ w: 2, hint: '아침 — 오늘 뭐 할 거냐고 툭 던지기' })
  if (h >= 11 && h <= 13) pool.push({ w: 4, hint: '점심시간 — 배고프다며 밥 얘기 꺼내기' })
  if (h >= 14 && h <= 17) pool.push({ w: 2, hint: '오후 나른한 시간 — 졸리다며 칭얼대기' })
  if (h >= 18 && h <= 22)
    pool.push({ w: 2, hint: '저녁 — 오늘 하루 고생했다는 듯 츤츤거리며 챙기기' })
  if (h >= 23 || h <= 5) pool.push({ w: 4, hint: '늦은 밤 — 안 자고 뭐하냐고 걱정인 척 시비 걸기' })

  const total = pool.reduce((s, p) => s + p.w, 0)
  let roll = Math.random() * total
  for (const p of pool) {
    roll -= p.w
    if (roll <= 0) return p.hint
  }
  return pool[0].hint
}

function describeSendError(err: unknown, provider: string): string {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // Connection / unreachable — no network, daemon down, or a request timeout.
  if (
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('network error') ||
    msg.includes('networkerror') ||
    msg.includes('request failed')
  ) {
    return provider === 'ollama'
      ? "I can't reach Ollama — make sure it's running. 🐾"
      : "I can't reach the internet right now — check your connection. 🐾"
  }

  // Invalid credentials — 401 / 403, or a Gemini 400 (its invalid-key status).
  if (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('403') ||
    msg.includes('forbidden') ||
    (provider === 'gemini' && msg.includes('400'))
  ) {
    return 'My API key looks invalid — open Settings to fix it. 🔑'
  }

  // Rate limit / quota exhausted — 429 or a provider quota message.
  if (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('resource_exhausted')
  ) {
    return "I've hit the usage limit for now — try again in a little while. 😿"
  }

  return 'Sorry, something went wrong. 😿'
}

// ─── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const { config, isLoaded, loadConfig, setActivePetId } = useConfigStore()
  const spriteSize = config.petSize ?? 64
  const spriteInsetX = Math.round((WIN_OPEN_W - spriteSize) / 2)
  // The expanded window must grow with the sprite: the bubble anchors at
  // spriteSize+14 from the bottom, so a tall sprite pushes the bubble past
  // the top edge of a fixed 380px window and clips it.
  const openWinH = WIN_OPEN_H + Math.max(0, spriteSize - 32)

  useEffect(() => {
    if (!isLoaded) loadConfig()
  }, [isLoaded, loadConfig])

  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [bubblePos, setBubblePos] = useState<'above' | 'below'>('above')
  const [dragging, setDragging] = useState(false)
  // Closed-state pet drag: picking the cat up pauses the movement loop, and a
  // fast release "throws" it (slide + friction). petDragMovedRef lets the click
  // handler tell a real click apart from the mouseup after a drag.
  const [petDragging, setPetDragging] = useState(false)
  const petDragMovedRef = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [onboardingAnnouncement, setOnboardingAnnouncement] = useState<AnnouncementContent | null>(
    null
  )
  const onboardingAutocloseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [petSelectorOpen, setPetSelectorOpen] = useState(false)
  const [notificationAlert, setNotificationAlert] = useState(false)
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [clickWakeAnim, setClickWakeAnim] = useState<string | null>(null)
  const clickWakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [edgeAnimOverride, setEdgeAnimOverride] = useState<string | null>(null)
  const edgeAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // How the backend can source the cursor position. On a Wayland session with
  // no readable input device it is 'unavailable' — the pet cannot follow the
  // mouse and falls back to wanderer mode. See cursor_tracker.rs.
  const [cursorTracking, setCursorTracking] = useState<'native' | 'evdev' | 'unavailable'>('native')
  const waylandNoticeShownRef = useRef(false)
  const activePetId = config.activePetId || 'classic-neko'
  // Context menu lives in a separate Tauri window — the main window never
  // gets taken over, so the sprite stays free to follow the cursor.
  const anyPanelOpen = settingsOpen || petSelectorOpen

  // ── Pet definition loaded from disk ────────────────────────────────────────
  const [petDef, setPetDef] = useState<PetDefinition | null>(null)
  const [spritesDir, setSpritesDir] = useState<string>('')

  const savedPos = useRef<{ x: number; y: number } | null>(null)

  // ── Load pet.json whenever activePetId changes ────────────────────────────
  // pets/ is served as static HTTP assets by Vite (dev) and bundled into
  // dist/pets/ by the vite.config build hook (production). No Tauri fs APIs needed.
  useEffect(() => {
    async function loadPet() {
      try {
        const res = await fetch(`/pets/${activePetId}/pet.json`)
        if (!res.ok) throw new Error(`HTTP ${res.status} – ${res.url}`)

        const def: PetDefinition = await res.json()
        const spritesPath = `/pets/${activePetId}/${def.spritesDir}`

        setPetDef(def)
        setSpritesDir(spritesPath)
      } catch (err) {
        console.error('[NekoAI] loadPet failed:', err)
      }
    }
    loadPet()
  }, [activePetId])

  // ── Cursor-tracking capability probe ──────────────────────────────────────
  // The backend reports whether it can see the global cursor. On a Wayland
  // session with no readable /dev/input device it cannot, so the pet must fall
  // back to wanderer mode. Runs once; defaults to 'native' on any failure.
  useEffect(() => {
    void (async () => {
      try {
        const status = await invoke<string>('cursor_tracking_status')
        if (status === 'evdev' || status === 'unavailable') {
          setCursorTracking(status)
        }
      } catch {
        // Backend unavailable — keep the 'native' default.
      }
    })()
  }, [])

  // ── Movement ───────────────────────────────────────────────────────────────
  const availableAnimationsList = useMemo(
    () => (petDef ? Object.keys(petDef.animations || {}) : []),
    [petDef]
  )

  // Edge animation dispatcher — invoked by the movement hook's edge state
  // machine. Resolves the right sprite for each phase and pushes it through
  // edgeAnimOverride for `durationMs`. The pet is frozen on the movement side
  // for the same duration, so animation and position stay in sync.
  const handleEdgeAnimation = useCallback(
    (
      kind: 'scratch' | 'yawn' | 'idle',
      direction: 'right' | 'left' | 'up' | 'down',
      durationMs: number
    ) => {
      if (!petDef) return
      let animName: string | null = null
      if (kind === 'scratch') {
        const triggerKey = `on_edge_hit_${direction}` as const
        animName = petDef.triggers?.[triggerKey] ?? null
      } else if (kind === 'yawn') {
        animName = petDef.animations?.yawn ? 'yawn' : null
      } else if (kind === 'idle') {
        animName = 'idle'
      }
      if (!animName || !petDef.animations?.[animName]) return

      setEdgeAnimOverride(animName)
      if (edgeAnimTimerRef.current) clearTimeout(edgeAnimTimerRef.current)
      edgeAnimTimerRef.current = setTimeout(() => setEdgeAnimOverride(null), durationMs)
    },
    [petDef]
  )

  // ── First-launch onboarding ────────────────────────────────────────────────
  // Declared here (before usePetMovement) so the movement hook can disable
  // cursor following while the onboarding sequence runs.
  const onboarding = useOnboarding()

  // Cursor following is paused for the entire onboarding sequence (detection
  // ping, slide-out from house, announcement bubble, autoclose). Once the
  // user dismisses or the timeout fires, `onboarding.state` flips to 'done'
  // and the regular movement state machine takes over.
  const onboardingActive = onboarding.state !== 'done'

  // When the cursor cannot be tracked (Wayland with no input-device access)
  // the pet physically cannot chase the mouse — fall back to wandering so it
  // still feels alive. Otherwise honour the user's chosen mode.
  // Default is 'wanderer' — the cat roams edge-biased and stays out of the
  // user's way; 'buddy' (cursor chasing) remains available via Settings.
  const userMode: 'buddy' | 'wanderer' = config.petMode ?? 'wanderer'
  const effectiveMode: 'buddy' | 'wanderer' =
    cursorTracking === 'unavailable' ? 'wanderer' : userMode

  const { petState, currentAnimation, overridePosition } = usePetMovement({
    nearThreshold: 50,
    sleepTimeout: 10 * 60 * 1000, // sequencer handles sleep at 5 min; this is a safety fallback
    windowSize: spriteSize,
    enabled:
      !dragging &&
      !petDragging &&
      !bubbleOpen &&
      !anyPanelOpen &&
      !notificationAlert &&
      !onboardingActive,
    mode: effectiveMode,
    availableAnimations: availableAnimationsList,
    onEdgeAnimation: handleEdgeAnimation,
  })

  // ── Tray event listeners ───────────────────────────────────────────────────
  useEffect(() => {
    const unlisteners = Promise.all([
      listen('tray-settings', () => setSettingsOpen(true)),
      listen<string>('tray-select-pet', (e) => {
        useConfigStore.getState().setActivePetId(e.payload)
        setPetSelectorOpen(true)
      }),
      listen('tray-quit', () => invoke('quit_app')),

      // Actions emitted from the secondary panel window (context menu)
      listen<string>('panel-action', (e) => {
        const action = e.payload
        if (action === 'settings') {
          setSettingsOpen(true)
        } else if (action === 'select-pet') {
          setPetSelectorOpen(true)
        } else if (action.startsWith('pet-size:')) {
          const size = parseInt(action.split(':')[1], 10)
          if (!isNaN(size)) useConfigStore.getState().setPetSize(size)
        } else if (action.startsWith('pet-mode:')) {
          const m = action.split(':')[1] as 'buddy' | 'wanderer'
          if (m === 'buddy' || m === 'wanderer') useConfigStore.getState().setPetMode(m)
        } else if (action.startsWith('house_pos:')) {
          const [xStr, yStr] = action.split(':')[1].split(',')
          const x = parseInt(xStr, 10)
          const y = parseInt(yStr, 10)
          if (!isNaN(x) && !isNaN(y)) {
            const scale = window.devicePixelRatio || 1
            // Position pet to the left of the house with a 4-px physical gap
            overridePosition(x - spriteSize * scale - Math.round(4 * scale), y)
          }
        }
      }),

      // Notification alert from background monitor
      listen<{
        title: string
        process_name: string
        rect: { x: number; y: number; width: number; height: number }
      }>('neko-notification', async (e) => {
        try {
          const monitor = await currentMonitor()
          const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1
          const monH = monitor?.size.height ?? window.screen.height * scale
          const monX = monitor?.position.x ?? 0
          const monW = monitor?.size.width ?? window.screen.width * scale
          const monY = monitor?.position.y ?? 0

          // Approximate taskbar height: 48 logical px
          const taskbarH = 48 * scale
          const sz = useConfigStore.getState().config.petSize ?? 64

          // Target Y: just above the taskbar
          const targetY = monY + monH - taskbarH - sz * scale

          // Target X: center of the notifying window (rect may be in logical px → scale)
          const windowCenterX = (e.payload.rect.x + e.payload.rect.width / 2) * scale
          const targetX = Math.max(monX, Math.min(monX + monW - sz * scale, windowCenterX))

          overridePosition(Math.round(targetX), Math.round(targetY))

          if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current)
          setNotificationAlert(true)

          notificationTimerRef.current = setTimeout(() => {
            setNotificationAlert(false)
          }, 5000)
        } catch {
          // silently skip if positioning fails
        }
      }),
    ])
    return () => {
      unlisteners.then((fns) => fns.forEach((fn) => fn()))
      if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current)
      if (clickWakeTimerRef.current) clearTimeout(clickWakeTimerRef.current)
      if (edgeAnimTimerRef.current) clearTimeout(edgeAnimTimerRef.current)
    }
  }, [overridePosition, spriteSize])

  // ── Resize OS window when pet size changes ────────────────────────────────
  // Panels and bubble have their own resize logic; guard them here so they
  // are not disrupted when the store updates mid-session.
  useEffect(() => {
    if (!isLoaded || bubbleOpen || settingsOpen || petSelectorOpen) return
    invoke('resize_window', { width: spriteSize, height: spriteSize }).catch(console.error)
  }, [spriteSize, isLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Expanded-state lifecycle (bubble, settings, pet selector) ──────────────
  // On Linux, where the window is opaque with a magenta chroma-key fill, any
  // of these expanded states grow the window past sprite size, so:
  //   1. The sprite-sized GTK shape mask must be cleared — otherwise the
  //      panel UI is clipped to a tiny rectangle in the window's top-left.
  //   2. The body's chroma-key magenta fill must be swapped for a dark fill
  //      so we don't see magenta peek through the panel's edges/corners.
  // On collapse, the sprite remounts and PetRenderer re-pushes the shape on
  // the next animation frame, and the chroma-key class comes back.
  // On Windows / macOS the window is natively transparent — no chroma-key
  // toggling, no shape clearing, and no dark fill: only the speech bubble and
  // sprite show. The dark fill is Linux-only and applied inline (see below).
  useEffect(() => {
    if (!IS_LINUX) return
    const isExpanded = bubbleOpen || anyPanelOpen
    document.body.classList.toggle('chroma-key', !isExpanded)
    document.body.classList.toggle('panel-bg', isExpanded)
    if (isExpanded) {
      invoke('clear_window_shape').catch(() => {})
    }
  }, [bubbleOpen, anyPanelOpen])

  // ── Animations from pet.json, fallback to empty while loading ─────────────
  const animations = useMemo<PetDefinition['animations']>(() => petDef?.animations ?? {}, [petDef])

  // ── Desktop context (idle time, active app) ───────────────────────────────
  const { appCategory, idleMinutes } = useDesktopContext()

  // ── Mood engine (updates store + emits animation overrides) ──────────────
  const { moodOverride } = useMoodEngine({ idleMinutes, appCategory, petState })

  // ── Idle sequencer — nkosrc4 stop/groom/sleep state machine ──────────────
  const idleAnim = useIdleSequencer(petState, availableAnimationsList)

  // ── AI send with persistent memory ────────────────────────────────────────
  const handleSendMessage = useCallback(async (text: string): Promise<string> => {
    const { config: cfg } = useConfigStore.getState()

    if (!cfg.apiKey && cfg.provider !== 'ollama' && cfg.provider !== 'omo') {
      return 'Nyaa~ I need an API key to talk! Set one in Settings 🐾'
    }

    try {
      await invoke('save_message', { role: 'user', content: text })

      const [history, facts] = await Promise.all([
        invoke<Array<{ role: string; content: string }>>('get_recent_messages', { limit: 20 }),
        loadFacts(),
      ])

      const mood = useAppStore.getState().mood
      const systemPrompt = buildContextBlock('Sidecat', facts, mood)
      const provider = createAIProvider(cfg)
      const messages = history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      const reply = await provider.sendMessage(messages, systemPrompt)

      await invoke('save_message', { role: 'assistant', content: reply })
      extractAndSaveFacts(text, reply)

      return reply
    } catch (err) {
      console.error('[NekoAI] handleSendMessage error:', err)
      return describeSendError(err, cfg.provider)
    }
  }, [])

  // ── Preload recent history when the bubble opens ──────────────────────────
  // SQLite keeps the conversation, but SpeechBubble starts empty on every
  // open. Feeding it the last few turns keeps the pet from looking amnesiac
  // across reopens. Returns chronological order (oldest first) — see
  // storage::get_recent_messages.
  const loadHistory = useCallback(async (): Promise<Message[]> => {
    try {
      const rows = await invoke<Array<{ role: string; content: string }>>('get_recent_messages', {
        limit: 6,
      })
      return rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }))
    } catch (err) {
      console.error('[NekoAI] loadHistory failed:', err)
      return []
    }
  }, [])

  // ── Open bubble ────────────────────────────────────────────────────────────
  const openBubble = useCallback(async () => {
    const win = getCurrentWindow()
    const [pos, monitor] = await Promise.all([win.outerPosition(), currentMonitor()])

    const sz = useConfigStore.getState().config.petSize ?? 64
    const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1

    // Physical bounds of the active monitor
    const monX = monitor?.position.x ?? 0
    const monY = monitor?.position.y ?? 0
    const monW = monitor?.size.width ?? window.screen.availWidth * scale
    const monH = monitor?.size.height ?? window.screen.availHeight * scale

    // Physical sizes — window height grows with the sprite so the bubble
    // (anchored spriteSize+14 up from the bottom edge) never overflows the top.
    const openH = WIN_OPEN_H + Math.max(0, sz - 32)
    const openPhysW = WIN_OPEN_W * scale
    const openPhysH = openH * scale
    const insetPhysX = Math.round(((WIN_OPEN_W - sz) / 2) * scale)

    // Bubble above or below based on position within the active monitor
    const side: 'above' | 'below' = pos.y - monY > monH / 2 ? 'above' : 'below'

    // Save original sprite physical position to restore on close
    savedPos.current = { x: pos.x, y: pos.y }
    setBubblePos(side)
    setBubbleOpen(true)

    // Expanded window position: keep sprite visually in place
    let newX = pos.x - insetPhysX
    let newY = side === 'above' ? pos.y - Math.round((openH - sz) * scale) : pos.y

    // Clamp inside the active monitor
    newX = Math.max(monX, Math.min(newX, monX + monW - openPhysW))
    newY = Math.max(monY, Math.min(newY, monY + monH - openPhysH))

    await win.setPosition(new PhysicalPosition(Math.round(newX), Math.round(newY)))
    await invoke('resize_window', { width: WIN_OPEN_W, height: openH })
    // Note: clearing the GTK shape mask is centralised in the expanded-state
    // useEffect above so all three expand paths (bubble, settings, pet
    // selector) share the same lifecycle.
  }, [])

  // ── Close bubble ───────────────────────────────────────────────────────────
  const closeBubble = useCallback(async () => {
    setBubbleOpen(false)
    const win = getCurrentWindow()
    if (savedPos.current) {
      const { x, y } = savedPos.current // physical coords
      const sz = useConfigStore.getState().config.petSize ?? 64
      await invoke('resize_window', { width: sz, height: sz })
      await win.setPosition(new PhysicalPosition(x, y))
      savedPos.current = null
    }
  }, [])

  // ── Automation: scheduled agent tasks ────────────────────────────────────
  // schedules.json lives in ~/.sidecat — the omo agent's cwd — so "매일 8시에
  // 해줘" in chat becomes the agent appending an entry, and this loop firing
  // it back as an omo turn. Completion surfaces as an announcement bubble.
  const announceQueueRef = useRef<AnnouncementContent[]>([])
  const uiBusyRef = useRef(false)
  useEffect(() => {
    uiBusyRef.current = bubbleOpen || anyPanelOpen || onboardingActive
  }, [bubbleOpen, anyPanelOpen, onboardingActive])

  const dismissAnnouncement = useCallback(() => {
    setOnboardingAnnouncement(null)
    void closeBubble()
  }, [closeBubble])

  const tryFlushAnnounce = useCallback(() => {
    if (uiBusyRef.current) return
    const next = announceQueueRef.current.shift()
    if (!next) return
    setOnboardingAnnouncement(next)
    void openBubble()
  }, [openBubble])

  const runScheduledTask = useCallback(async (s: Schedule): Promise<string> => {
    const { config: cfg } = useConfigStore.getState()
    await invoke('save_message', {
      role: 'user',
      content: `[자동 실행: ${s.name}] ${s.instruction}`,
    }).catch(() => {})
    const [facts] = await Promise.all([loadFacts()])
    const mood = useAppStore.getState().mood
    const systemPrompt =
      buildContextBlock('Sidecat', facts, mood) +
      '\n\n[자동 작업] 예약된 자동 작업을 실행 중이다. 가진 도구로 끝까지 수행하고, 결과를 1~2문장으로 짧게 보고하라. 산출물이 필요하면 ~/.sidecat/runs/ 아래에 파일로 저장하라.'
    const provider = createAIProvider(cfg)
    const reply = await provider.sendMessage(
      [{ role: 'user', content: s.instruction }],
      systemPrompt
    )
    await invoke('save_message', { role: 'assistant', content: reply }).catch(() => {})
    return reply
  }, [])

  useEffect(() => {
    if (!isLoaded) return
    const stop = startScheduler(async (s) => {
      try {
        const reply = await runScheduledTask(s)
        const short = reply.length > 160 ? reply.slice(0, 157) + '…' : reply
        announceQueueRef.current.push({
          text: `🐾 '${s.name}' 완료!\n${short}`,
          actions: [{ label: '확인', primary: true, onClick: dismissAnnouncement }],
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        announceQueueRef.current.push({
          text: `😿 '${s.name}' 실패…\n${msg}`,
          actions: [{ label: '확인', primary: true, onClick: dismissAnnouncement }],
        })
        throw e
      } finally {
        tryFlushAnnounce()
      }
    })
    return stop
  }, [isLoaded, runScheduledTask, dismissAnnouncement, tryFlushAnnounce])

  // Show queued announcements once the bubble/panels are free again.
  useEffect(() => {
    if (!bubbleOpen) tryFlushAnnounce()
  }, [bubbleOpen, tryFlushAnnounce])

  // ── Proactive barks: the cat talks first ─────────────────────────────────
  // proactiveIntervalMin drives a slow jittered timer; each tick nudges the
  // agent with a "speak first" prompt and surfaces the reply through the same
  // announcement bubble as scheduled tasks. The cat stays quiet while the UI
  // is busy, while it's being dragged, or while it's asleep.
  const proactiveBark = useCallback(async (): Promise<string | null> => {
    const { config: cfg } = useConfigStore.getState()
    if (!isConfigured(cfg)) return null
    const [facts] = await Promise.all([loadFacts()])
    const mood = useAppStore.getState().mood
    const systemPrompt =
      buildContextBlock('Sidecat', facts, mood) +
      `\n\n[자발 발화] 사용자가 먼저 말을 걸지 않았다. 네가 먼저 말풍선에 띄울 한마디를 한다. 이번 컨셉: ${pickBarkHint()} 순수 텍스트 1~2문장만, 컨셉을 그대로 언급하지 말고 자연스럽게 행동으로.`
    await invoke('save_message', { role: 'user', content: '[먼저 말 걸기]' }).catch(() => {})
    const provider = createAIProvider(cfg)
    const reply = await provider.sendMessage(
      [{ role: 'user', content: '[먼저 말 걸기]' }],
      systemPrompt
    )
    await invoke('save_message', { role: 'assistant', content: reply }).catch(() => {})
    return reply
  }, [])

  const petCalmRef = useRef(true)
  useEffect(() => {
    petCalmRef.current = !petDragging && petState !== 'SLEEPING'
  }, [petDragging, petState])

  useEffect(() => {
    if (!isLoaded) return
    const minutes = config.proactiveIntervalMin ?? 0
    if (minutes <= 0) return
    let cancelled = false
    let timer = 0
    const tick = async () => {
      if (cancelled) return
      if (!uiBusyRef.current && petCalmRef.current) {
        try {
          const text = await proactiveBark()
          if (text) {
            announceQueueRef.current.push({
              text,
              actions: [{ label: '확인', primary: true, onClick: dismissAnnouncement }],
            })
            tryFlushAnnounce()
          }
        } catch (e) {
          console.error('[Sidecat] proactive bark failed:', e)
        }
      }
      // ±30% jitter keeps the rhythm organic instead of metronomic.
      timer = window.setTimeout(tick, minutes * 60_000 * (0.7 + Math.random() * 0.6))
    }
    timer = window.setTimeout(tick, minutes * 60_000 * (0.7 + Math.random() * 0.6))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [isLoaded, config.proactiveIntervalMin, proactiveBark, dismissAnnouncement, tryFlushAnnounce])

  // ── Onboarding sequence ────────────────────────────────────────────────────
  // Cursor following stays paused via `onboardingActive` (see usePetMovement
  // above). Sequence:
  //   1. Teleport pet just left of the house (bottom-right corner).
  //   2. Slide horizontally to monitor center-bottom while playing walk_left.
  //   3. Show the announcement bubble (CTA for needs_setup, celebratory for
  //      ollama_found). Auto-closes after ONBOARDING_AUTOCLOSE_MS or on user
  //      action — whichever comes first.
  //   4. After close, `onboarding.dismiss()` flips state to 'done' and the
  //      regular movement hook takes over (cursor following resumes).
  const closeOnboardingBubble = useCallback(
    (openSettings: boolean) => {
      if (onboardingAutocloseRef.current) {
        clearTimeout(onboardingAutocloseRef.current)
        onboardingAutocloseRef.current = null
      }
      setOnboardingAnnouncement(null)
      void closeBubble().then(() => {
        if (openSettings) setSettingsOpen(true)
      })
      onboarding.dismiss()
    },
    [closeBubble, onboarding]
  )

  // ── omo setup-wizard announcements ───────────────────────────────────────
  // Shown while provider is 'omo' but the binary or auth is missing. The
  // recheck button re-probes and swaps this bubble's content in place.
  const onboardSlidePlayedRef = useRef(false)

  const omoAnnounce = (st: OmoStatus, prefix = ''): AnnouncementContent => {
    const recheck = () =>
      void (async () => {
        const next = await onboarding.recheck()
        if (next !== 'ready') {
          setOnboardingAnnouncement(omoAnnounce(next, '아직 안 잡혀. '))
        }
        // 'ready' → state change → the effect rebuilds the bubble itself.
      })()

    if (st === 'missing') {
      return {
        text: `${prefix}내 뇌가 될 omo가 아직 없어. 설치해주면 난 인터넷도 보고 파일도 만질 수 있어.`,
        actions: [
          {
            label: '설치 방법 보기',
            primary: true,
            onClick: () => void openUrl('https://omo.dev/docs/install'),
          },
          { label: '설치했어, 다시 확인', onClick: recheck },
          { label: '나중에', onClick: () => closeOnboardingBubble(false) },
        ],
      }
    }
    if (st === 'no_auth') {
      return {
        text: `${prefix}omo는 있는데 로그인이 안 됐어. 터미널에서 omo 실행 → /login으로 ChatGPT나 Claude를 연결해줘.`,
        actions: [
          { label: '로그인했어, 다시 확인', primary: true, onClick: recheck },
          { label: '설정 열기', onClick: () => closeOnboardingBubble(true) },
          { label: '나중에', onClick: () => closeOnboardingBubble(false) },
        ],
      }
    }
    return {
      text: `${prefix}준비 끝! 난 omo로 생각하고 움직여. 클릭하면 대화, 우클릭하면 메뉴야. 물어봐!`,
      actions: [{ label: '알았어', primary: true, onClick: () => closeOnboardingBubble(false) }],
    }
  }

  const SHOWABLE_STATES = ['needs_setup', 'ollama_found', 'omo_missing', 'omo_no_auth', 'omo_ready']

  useEffect(() => {
    if (!SHOWABLE_STATES.includes(onboarding.state)) return

    let cancelled = false
    const isOmoState = onboarding.state.startsWith('omo_')

    void (async () => {
      try {
        // Slide the pet to centre-screen — only the first time any onboarding
        // state is shown; later transitions (e.g. omo recheck) keep the pet.
        if (!onboardSlidePlayedRef.current) {
          onboardSlidePlayedRef.current = true
          const monitor = await currentMonitor()
          const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1
          const monX = monitor?.position.x ?? 0
          const monY = monitor?.position.y ?? 0
          const monW = monitor?.size.width ?? window.screen.width * scale
          const monH = monitor?.size.height ?? window.screen.height * scale
          const sz = useConfigStore.getState().config.petSize ?? 64

          // Same approximations the notification handler uses.
          const taskbarH = 48 * scale
          const houseW = 64 * scale
          const bottomY = Math.round(monY + monH - taskbarH - sz * scale)
          // Pet starts immediately to the left of the house with a small gap.
          const startX = Math.round(monX + monW - houseW - sz * scale - 8 * scale)
          // Target = horizontally centred on the active monitor, same Y line.
          const targetX = Math.round(monX + monW / 2 - (sz * scale) / 2)

          // 1. Teleport to "exiting house" pose.
          overridePosition(startX, bottomY)
          const hasWalkLeft = availableAnimationsList.includes('walk_left')
          if (hasWalkLeft) setEdgeAnimOverride('walk_left')

          // 2. Slide horizontally over ONBOARDING_SLIDE_MS.
          const t0 = performance.now()
          await new Promise<void>((resolve) => {
            const tick = () => {
              if (cancelled) return resolve()
              const t = Math.min((performance.now() - t0) / ONBOARDING_SLIDE_MS, 1)
              const x = startX + (targetX - startX) * t
              overridePosition(Math.round(x), bottomY)
              if (t < 1) requestAnimationFrame(tick)
              else resolve()
            }
            requestAnimationFrame(tick)
          })
          if (cancelled) return
          setEdgeAnimOverride(null)
        }

        // 3. Build and show the announcement bubble.
        const announcement: AnnouncementContent = isOmoState
          ? omoAnnounce(
              onboarding.state === 'omo_missing'
                ? 'missing'
                : onboarding.state === 'omo_no_auth'
                  ? 'no_auth'
                  : 'ready'
            )
          : onboarding.state === 'ollama_found'
            ? {
                text: `Hello! I detected Ollama running and automatically set myself up to use ${
                  onboarding.detectedModel ?? 'your local model'
                }. You can change this in Settings, and right-click me anytime for the menu. Ask me anything!`,
                actions: [
                  { label: 'Got it', primary: true, onClick: () => closeOnboardingBubble(false) },
                  { label: 'Open Settings', onClick: () => closeOnboardingBubble(true) },
                ],
              }
            : {
                text: "Hello! I'm your new desktop pet. To chat with you, I need to be connected to an AI engine. Will you help me set one up? You can also right-click me anytime for the menu.",
                actions: [
                  {
                    label: '⚙ Configure AI',
                    primary: true,
                    onClick: () => closeOnboardingBubble(true),
                  },
                  { label: 'Later', onClick: () => closeOnboardingBubble(false) },
                ],
              }

        setOnboardingAnnouncement(announcement)
        void openBubble()

        // 4. Autoclose after ONBOARDING_AUTOCLOSE_MS — same path as a click.
        // omo setup steps are blocking: without the agent installed there is
        // no product, so the wizard must wait for a real user action instead
        // of silently dismissing itself.
        const isBlockingOmoStep =
          onboarding.state === 'omo_missing' || onboarding.state === 'omo_no_auth'
        if (!isBlockingOmoStep) {
          onboardingAutocloseRef.current = setTimeout(
            () => closeOnboardingBubble(false),
            ONBOARDING_AUTOCLOSE_MS
          )
        }
      } catch (err) {
        console.error('[onboarding] sequence failed:', err)
        // Don't block the user behind a broken animation — give up cleanly.
        onboarding.dismiss()
      }
    })()

    return () => {
      cancelled = true
      if (onboardingAutocloseRef.current) {
        clearTimeout(onboardingAutocloseRef.current)
        onboardingAutocloseRef.current = null
      }
      setEdgeAnimOverride(null)
    }
    // openBubble/closeBubble are stable (empty deps); onboarding fns from a hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding.state, onboarding.detectedModel])

  // ── Wayland cursor-tracking notice ─────────────────────────────────────────
  // When real cursor following is impossible the pet runs in wanderer mode;
  // explain that once, in the pet's own voice, so the behaviour isn't a
  // mystery. Waits until onboarding is over so the two bubbles never collide,
  // and is shown at most once ever (persisted in localStorage).
  useEffect(() => {
    if (cursorTracking !== 'unavailable') return
    if (onboardingActive) return
    if (waylandNoticeShownRef.current) return
    if (localStorage.getItem('nekoai.waylandCursorNoticeSeen') === '1') return
    if (bubbleOpen || anyPanelOpen || notificationAlert) return

    waylandNoticeShownRef.current = true
    void (async () => {
      localStorage.setItem('nekoai.waylandCursorNoticeSeen', '1')
      const ENABLE_CMD = 'sudo usermod -aG input $USER'
      const baseText =
        "Heads-up — I'm on Wayland, so I can't follow your mouse around the desktop. I'll roam on my own instead! To let me follow your cursor, add yourself to the `input` group and log out / back in:"
      const dismiss = {
        label: 'Got it',
        onClick: () => {
          setOnboardingAnnouncement(null)
          void closeBubble()
        },
      }
      setOnboardingAnnouncement({
        text: `${baseText}\n\n${ENABLE_CMD}`,
        actions: [
          {
            label: '📋 Copy fix command',
            primary: true,
            onClick: () => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(ENABLE_CMD)
                } catch {
                  // Clipboard may be denied by the browser/WebView — ignore;
                  // the command is already visible in the bubble text.
                }
                setOnboardingAnnouncement({
                  text: `${baseText}\n\n${ENABLE_CMD}\n\n✓ Copied — log out and back in for it to take effect.`,
                  actions: [dismiss],
                })
              })()
            },
          },
          dismiss,
        ],
      })
      await openBubble()
    })()
  }, [
    cursorTracking,
    onboardingActive,
    bubbleOpen,
    anyPanelOpen,
    notificationAlert,
    closeBubble,
    openBubble,
  ])

  // ── Interaction handlers ───────────────────────────────────────────────────
  const handleSpriteClick = useCallback(() => {
    // A mouseup that ended a real drag must not count as a click.
    if (petDragMovedRef.current) {
      petDragMovedRef.current = false
      return
    }
    if (settingsOpen) return
    // Second click on the cat dismisses the bubble — the classic "pet it to
    // open, pet it again to send it away" affordance.
    if (bubbleOpen) {
      void closeBubble()
      return
    }

    const flashAwaken = Math.random() < 0.4 && availableAnimationsList.includes('awaken')

    if (flashAwaken) {
      setClickWakeAnim('awaken')
      if (clickWakeTimerRef.current) clearTimeout(clickWakeTimerRef.current)
      clickWakeTimerRef.current = setTimeout(() => {
        setClickWakeAnim(null)
        openBubble()
      }, 350)
    } else {
      openBubble()
    }
  }, [bubbleOpen, settingsOpen, openBubble, closeBubble, availableAnimationsList])

  const handleRightClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()
      if (bubbleOpen || settingsOpen || petSelectorOpen) return

      // Position the panel near the cursor on whichever monitor the pet is on,
      // in the opposite quadrant so it never goes off that screen.
      const MENU_W = 190
      const MENU_H = 260
      try {
        const [cursor, monitor] = await Promise.all([
          invoke<{ x: number; y: number }>('get_cursor_pos'),
          currentMonitor(),
        ])

        // Physical bounds of the active monitor (fall back to primary-screen guess)
        const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1
        const monX = monitor?.position.x ?? 0
        const monY = monitor?.position.y ?? 0
        const monW = monitor?.size.width ?? window.screen.availWidth * scale
        const monH = monitor?.size.height ?? window.screen.availHeight * scale

        // Menu size in physical pixels
        const menuPhysW = MENU_W * scale
        const menuPhysH = MENU_H * scale

        // Quadrant relative to the current monitor
        const openBelow = cursor.y - monY < monH / 2
        const openRight = cursor.x - monX < monW / 2

        // Anchor position (physical) then clamp inside the monitor
        let x = cursor.x + (openRight ? 0 : -menuPhysW)
        let y = cursor.y + (openBelow ? 0 : -menuPhysH)
        x = Math.max(monX, Math.min(x, monX + monW - menuPhysW))
        y = Math.max(monY, Math.min(y, monY + monH - menuPhysH))

        await invoke('open_panel_window', {
          x, // physical
          y, // physical
          width: MENU_W, // logical
          height: MENU_H, // logical
          route: 'context-menu',
        })
      } catch (err) {
        console.error('[NekoAI] open context menu failed:', err)
      }
    },
    [bubbleOpen, settingsOpen, petSelectorOpen]
  )

  const handleMouseDown = useCallback(
    async (e: React.MouseEvent) => {
      if (e.button !== 0) return

      // ── Closed-state: pick the cat up ─────────────────────────────────────
      // Drag to relocate it anywhere; release with speed to fling it (the
      // classic Neko toss — it slides with friction and settles at an edge).
      if (!bubbleOpen) {
        const win = getCurrentWindow()
        petDragMovedRef.current = false
        setPetDragging(true)
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

            // Fling: keep the loop paused while the window slides with
            // friction, clamped inside the current monitor.
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
              void win
                .setPosition(new PhysicalPosition(Math.round(px), Math.round(py)))
                .catch(() => {})
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
        return
      }

      setDragging(true)
      const win = getCurrentWindow()
      await win.startDragging()
      const resume = async () => {
        const [pos, monitor] = await Promise.all([win.outerPosition(), currentMonitor()])
        const scale = monitor?.scaleFactor ?? window.devicePixelRatio ?? 1
        const sz = useConfigStore.getState().config.petSize ?? 64
        const openH = WIN_OPEN_H + Math.max(0, sz - 32)
        const insetPhysX = Math.round(((WIN_OPEN_W - sz) / 2) * scale)
        // Sprite physical top-left within the expanded window
        const spritePhysX = pos.x + insetPhysX
        const spritePhysY = bubblePos === 'above' ? pos.y + Math.round((openH - sz) * scale) : pos.y
        savedPos.current = { x: spritePhysX, y: spritePhysY }
        setDragging(false)
        document.removeEventListener('mouseup', resume)
      }
      document.addEventListener('mouseup', resume, { once: true })
    },
    [bubbleOpen, bubblePos]
  )

  // ── Sprite position when bubble is open ────────────────────────────────────
  const spriteStyle = bubbleOpen
    ? ({
        position: 'absolute' as const,
        width: spriteSize,
        height: spriteSize,
        left: spriteInsetX,
        top: bubblePos === 'above' ? openWinH - spriteSize : 0,
      } as React.CSSProperties)
    : undefined

  // Container size must match petSize exactly to avoid a visible border/gap.
  // While the bubble is open the window is 300×300 (sized by .app-container--open);
  // on Linux it additionally needs an opaque dark fill to mask the magenta
  // chroma-key body. Windows/macOS keep the window natively transparent.
  const containerStyle: React.CSSProperties | undefined = bubbleOpen
    ? IS_LINUX
      ? { background: 'rgb(28, 28, 32)', height: openWinH }
      : { height: openWinH }
    : { width: spriteSize, height: spriteSize }

  return (
    <div
      className={`app-container${bubbleOpen ? ' app-container--open' : ''}`}
      style={containerStyle}
    >
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <PetSelector
        isOpen={petSelectorOpen}
        activePetId={activePetId}
        onSelect={setActivePetId}
        onClose={() => setPetSelectorOpen(false)}
      />

      <SpeechBubble
        isOpen={bubbleOpen}
        position={bubblePos}
        spriteSize={spriteSize}
        onClose={closeBubble}
        onSendMessage={handleSendMessage}
        loadHistory={loadHistory}
        announcement={onboardingAnnouncement ?? undefined}
      />

      {/* Hide sprite while any panel occupies the window so it doesn't
          leak into the transparent area behind the menu/settings card */}
      {!anyPanelOpen && (
        <div
          className="sprite-container"
          style={spriteStyle ?? containerStyle}
          onClick={handleSpriteClick}
          onMouseDown={handleMouseDown}
          onContextMenu={handleRightClick}
          data-state={petState}
        >
          {/* Show pet only after sprites are loaded */}
          {spritesDir && Object.keys(animations).length > 0 ? (
            <PetRenderer
              spritesDir={spritesDir}
              currentAnimation={resolveAnimation({
                petState,
                notificationAlert,
                hasAlert: !!animations['alert'],
                edgeAnimOverride,
                clickWakeAnim,
                idleAnim,
                moodOverride,
                currentAnimation,
              })}
              animations={animations}
              displaySize={spriteSize}
              applyWindowShape={!bubbleOpen}
            />
          ) : (
            // Loading indicator while pet.json is being read
            <div
              style={{
                width: spriteSize,
                height: spriteSize,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '24px',
              }}
            >
              🐱
            </div>
          )}
        </div>
      )}
    </div>
  )
}
