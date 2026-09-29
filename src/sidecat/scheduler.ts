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

export interface Schedule {
  id: string
  /** Short label shown in Settings and announcements. */
  name: string
  /** The instruction handed to the omo agent, verbatim. */
  instruction: string
  /** "HH:MM" local time, daily. */
  at: string
  enabled: boolean
  /** ISO timestamp of the last fired run (success or failure). */
  lastRun?: string
  /** Last failure message, if the most recent run threw. */
  lastError?: string
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
  const target = atToday(s.at, now)
  if (!target || now < target) return false
  if (!s.lastRun) return true
  return new Date(s.lastRun) < target
}

export type RunTask = (schedule: Schedule) => Promise<void>

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
          await runTask(s)
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
