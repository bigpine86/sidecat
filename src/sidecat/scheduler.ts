import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { homeDir, join } from '@tauri-apps/api/path'

/**
 * Sidecat automation scheduler.
 *
 * Schedules live in ~/.sidecat/schedules.json — a file both this app and the
 * omo agent (whose thread cwd is ~/.sidecat) can read and write. That is the
 * whole integration trick: "매일 8시에 해줘" in chat becomes the agent
 * appending an entry here, and this loop firing it back into an omo turn.
 *
 * MVP shape: one daily `at` "HH:MM" per schedule. Missed runs (app was off)
 * fire once on the next tick after launch — lastRun is the source of truth,
 * not a timer registration.
 */

export type TriggerKind = 'manual' | 'daily' | 'weekly' | 'interval' | 'once'

export interface Schedule {
  id: string
  /** Short label shown in Settings and announcements. */
  name: string
  /** The instruction handed to the omo agent, verbatim. Used when steps is empty. */
  instruction: string
  /** Ordered recipe steps ("한 줄 = 한 단계"). When present, they are compiled
   *  into the instruction at run time — omo executes them as one turn. */
  steps?: string[]
  /** "HH:MM" local time — used by 'daily' and 'weekly' triggers. */
  at?: string
  /** How the schedule fires. Absent → 'daily' if `at` exists, else 'manual'. */
  trigger?: TriggerKind
  /** 0=Sun … 6=Sat — 'weekly' trigger only. */
  weeklyDay?: number
  /** 'interval' trigger: fire every N minutes. */
  everyMin?: number
  /** 'once' trigger: ISO datetime string. */
  onceAt?: string
  enabled: boolean
  /** ISO timestamp of the last fired run (success or failure). */
  lastRun?: string
  /** Last failure message, if the most recent run threw. */
  lastError?: string
  /** Truncated agent reply from the most recent successful run. */
  lastResult?: string
  /** Total completed runs. */
  runCount?: number
}

/** Effective trigger — entries written by the agent only set `at` → daily. */
export function triggerKind(s: Schedule): TriggerKind {
  return s.trigger ?? (s.at ? 'daily' : 'manual')
}

/** What the agent actually receives for a run. */
export function buildInstruction(s: Schedule): string {
  const steps = s.steps?.map((t) => t.trim()).filter(Boolean)
  if (steps && steps.length > 0) {
    return (
      '다음 단계를 순서대로 수행해. 한 단계가 끝나면 다음으로 넘어가:\n' +
      steps.map((t, i) => `${i + 1}. ${t}`).join('\n')
    )
  }
  return s.instruction
}

/** One-line trigger summary for list UIs. */
export function describeTrigger(s: Schedule): string {
  const at = s.at ?? '09:00'
  switch (triggerKind(s)) {
    case 'manual':
      return '수동 실행'
    case 'daily':
      return `매일 ${at}`
    case 'weekly':
      return `매주 ${['일', '월', '화', '수', '목', '금', '토'][s.weeklyDay ?? 1]} ${at}`
    case 'interval':
      return `${s.everyMin ?? 60}분마다`
    case 'once': {
      const d = s.onceAt ? new Date(s.onceAt) : null
      return d && !isNaN(d.getTime())
        ? `한 번 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : '한 번 (시각 미지정)'
    }
  }
}

export interface SchedulesFile {
  schedules: Schedule[]
}

const POLL_MS = 30_000

export async function schedulesPath(): Promise<string> {
  return join(await homeDir(), '.sidecat', 'schedules.json')
}

export async function sidecatHome(): Promise<string> {
  return join(await homeDir(), '.sidecat')
}

export async function ensureSidecatHome(): Promise<void> {
  const dir = await sidecatHome()
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  const runs = await join(dir, 'runs')
  if (!(await exists(runs))) await mkdir(runs, { recursive: true })
}

export async function loadSchedules(): Promise<SchedulesFile> {
  try {
    const path = await schedulesPath()
    if (!(await exists(path))) return { schedules: [] }
    const parsed = JSON.parse(await readTextFile(path)) as SchedulesFile
    if (!Array.isArray(parsed.schedules)) return { schedules: [] }
    return parsed
  } catch {
    return { schedules: [] }
  }
}

export async function saveSchedules(file: SchedulesFile): Promise<void> {
  await ensureSidecatHome()
  await writeTextFile(await schedulesPath(), JSON.stringify(file, null, 2) + '\n')
}

/** Today's local Date for the schedule's `at` time (HH:MM). */
function atToday(at: string, now: Date): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim())
  if (!m) return null
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return d
}

export function isDue(s: Schedule, now: Date): boolean {
  if (!s.enabled) return false
  switch (triggerKind(s)) {
    case 'manual':
      return false
    case 'once': {
      if (s.lastRun || !s.onceAt) return false
      const target = new Date(s.onceAt)
      return !isNaN(target.getTime()) && now >= target
    }
    case 'interval': {
      const every = (s.everyMin ?? 0) * 60_000
      if (every <= 0) return false
      if (!s.lastRun) return true
      return now.getTime() - new Date(s.lastRun).getTime() >= every
    }
    case 'weekly': {
      if (s.weeklyDay !== undefined && now.getDay() !== s.weeklyDay) return false
      const target = atToday(s.at ?? '', now)
      if (!target || now < target) return false
      if (!s.lastRun) return true
      return new Date(s.lastRun) < target
    }
    case 'daily':
    default: {
      const target = atToday(s.at ?? '', now)
      if (!target || now < target) return false
      if (!s.lastRun) return true
      return new Date(s.lastRun) < target
    }
  }
}

export type RunTask = (schedule: Schedule) => Promise<string>

/**
 * Record a completed run back into schedules.json — shared by the poller and
 * the "지금 실행" path so both update lastRun/lastResult/lastError/runCount.
 */
export async function recordRunResult(id: string, ok: boolean, text: string): Promise<void> {
  const file = await loadSchedules()
  const s = file.schedules.find((x) => x.id === id)
  if (!s) return
  s.lastRun = new Date().toISOString()
  if (ok) {
    s.lastResult = text.length > 400 ? text.slice(0, 397) + '…' : text
    s.lastError = undefined
    s.runCount = (s.runCount ?? 0) + 1
  } else {
    s.lastError = text
  }
  await saveSchedules(file)
}

/**
 * Poll schedules.json and fire due entries sequentially. The file is re-read
 * every tick so edits made by the omo agent (or by hand) are picked up
 * without a watcher. Returns a stop function.
 */
export function startScheduler(runTask: RunTask): () => void {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const file = await loadSchedules()
      const now = new Date()
      const due = file.schedules.filter((s) => isDue(s, now))
      if (due.length === 0) return

      for (const s of due) {
        s.lastRun = new Date().toISOString()
        s.lastError = undefined
        // Mark before running: a crash mid-task must not re-fire on restart.
        await saveSchedules(file)
        try {
          const reply = await runTask(s)
          s.lastResult = reply.length > 400 ? reply.slice(0, 397) + '…' : reply
          s.runCount = (s.runCount ?? 0) + 1
          await saveSchedules(file)
        } catch (e) {
          s.lastError = e instanceof Error ? e.message : String(e)
          await saveSchedules(file)
        }
      }
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), POLL_MS)
  void tick()
  return () => clearInterval(timer)
}
