import { Command, type Child } from '@tauri-apps/plugin-shell'
import { homeDir, join } from '@tauri-apps/api/path'
import type { AIProvider, Message } from '../types'

/**
 * OmoProvider — routes chat through a locally running `omo app-server`
 * (oh-my-openagent) instead of calling an LLM API directly.
 *
 * The app-server speaks line-delimited JSON-RPC over stdio. One child
 * process and one thread are kept alive for the app session, so omo's
 * own memory/tools (browser skill, skills, agent loop) work across turns.
 *
 * The full agentic turn is awaited here: `sendMessage` resolves when the
 * turn completes, carrying the concatenated agent messages. Tool calls
 * and intermediate progress happen inside omo; the UI sees "thinking"
 * for the duration.
 */

type Json = Record<string, unknown>

interface PendingRequest {
  resolve: (v: Json) => void
  reject: (e: Error) => void
}

class OmoBackend {
  private command: Command<string> | null = null
  private child: Child | null = null
  private reqId = 0
  private pending = new Map<number, PendingRequest>()
  private buffer = ''
  private threadId: string | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private turnBusy = false
  private queue: { text: string; resolve: (t: string) => void; reject: (e: Error) => void }[] = []
  private deltas = new Map<string, string>()

  /** True once initialize + thread/start succeeded. */
  get isReady(): boolean {
    return this.ready
  }

  async ensureStarted(): Promise<void> {
    if (this.ready) return
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<void> {
    const bin = await OmoBackend.resolveOmo()
    if (!bin) {
      throw new Error(
        'omo가 설치되어 있지 않아요. `omo`를 설치한 뒤 다시 시도해 주세요. (설치 마법사에서 한 번에 됩니다)'
      )
    }

    this.command = Command.create(bin, ['app-server'])
    this.command.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.command.stderr.on('data', (line: string) => {
      console.warn('[omo stderr]', line)
    })
    this.command.on('close', () => {
      this.failAll(new Error('omo app-server 프로세스가 종료됐어요'))
      this.command = null
      this.child = null
      this.ready = false
      this.threadId = null
    })
    this.command.on('error', (err: string) => {
      this.failAll(new Error(`omo 실행 실패: ${err}`))
    })

    this.child = await this.command.spawn()

    await this.request('initialize', {
      clientInfo: { name: 'sidecat-neko', version: '0.1.0' },
    })
    await this.notify('notifications/initialized')

    // ~/.sidecat is the agent's home: AGENTS.md persona + skills live there.
    const home = await join(await homeDir(), '.sidecat')
    const res = await this.request('thread/start', { cwd: home })
    this.threadId = (res.thread as Json).id as string
    this.ready = true
  }

  private static async resolveOmo(): Promise<string | null> {
    const home = await homeDir()
    const candidates = [
      await join(home, '.bun', 'bin', 'omo'),
      await join(home, '.local', 'bin', 'omo'),
      '/opt/homebrew/bin/omo',
      '/usr/local/bin/omo',
      'C:\\Program Files\\omo\\omo.exe',
      await join(home, '.local', 'bin', 'omo.exe'),
    ]
    // Probe candidates by asking the shell layer to spawn `--version`.
    for (const path of candidates) {
      try {
        const probe = Command.create(path, ['--version'])
        const out = await probe.execute()
        if (out.code === 0) return path
      } catch {
        /* not here */
      }
    }
    // Last resort: hope PATH covers it (dev shells usually do).
    try {
      const probe = Command.create('omo', ['--version'])
      const out = await probe.execute()
      if (out.code === 0) return 'omo'
    } catch {
      /* not on PATH either */
    }
    return null
  }

  /** Queue a user turn; resolves with the full agent reply text. */
  send(text: string, contextBlock?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const payload = contextBlock ? `[context] ${contextBlock}\n\n${text}` : text
      this.queue.push({ text: payload, resolve, reject })
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.turnBusy || !this.threadId) return
    const item = this.queue.shift()
    if (!item) return
    this.turnBusy = true
    this.deltas.clear()
    try {
      await this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: item.text }],
      })
      // Resolution happens in onMessage when the turn completes.
      this.activeTurn = item
    } catch (e) {
      this.turnBusy = false
      item.reject(e instanceof Error ? e : new Error(String(e)))
    }
  }

  private activeTurn: {
    text: string
    resolve: (t: string) => void
    reject: (e: Error) => void
  } | null = null

  private finishTurn(): void {
    if (!this.turnBusy) return
    const item = this.activeTurn
    this.activeTurn = null
    this.turnBusy = false
    if (item) {
      const parts = [...this.deltas.values()].filter((t) => t.trim().length > 0)
      item.resolve(parts.join('\n\n'))
    }
    void this.pump()
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) p.reject(e)
    this.pending.clear()
    if (this.activeTurn) {
      this.activeTurn.reject(e)
      this.activeTurn = null
    }
    this.turnBusy = false
    for (const q of this.queue) q.reject(e)
    this.queue = []
  }

  // ---------- JSON-RPC over stdio ----------

  private request(method: string, params: Json): Promise<Json> {
    const id = ++this.reqId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: Json): Promise<void> {
    this.write(
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    )
    return Promise.resolve()
  }

  private write(msg: Json): void {
    void this.child?.write(JSON.stringify(msg) + '\n')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: Json
      try {
        msg = JSON.parse(line) as Json
      } catch {
        continue // non-JSON banner/warning lines
      }
      this.onMessage(msg)
    }
  }

  private onMessage(msg: Json): void {
    const id = msg.id as number | undefined
    if (id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        if (msg.error) {
          const err = msg.error as Json
          p.reject(new Error((err.message as string) ?? 'RPC error'))
        } else {
          p.resolve(msg.result as Json)
        }
      }
      return
    }

    const method = (msg.method as string) ?? ''
    const params = (msg.params as Json) ?? {}

    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = (params.itemId as string) ?? ''
        const prev = this.deltas.get(itemId) ?? ''
        this.deltas.set(itemId, prev + ((params.delta as string) ?? ''))
        break
      }
      case 'item/completed': {
        const itemId = (params.itemId as string) ?? ''
        const item = params.item as Json | undefined
        const finalText = (item?.text as string) ?? (params.text as string)
        if (typeof finalText === 'string' && finalText.length) {
          this.deltas.set(itemId, finalText)
        }
        break
      }
      case 'turn/completed':
        this.finishTurn()
        break
      case 'thread/status/changed': {
        const status = params.status as Json | undefined
        if (status?.type === 'idle') this.finishTurn()
        break
      }
      case 'error':
        if (this.activeTurn) {
          this.activeTurn.reject(new Error((params.message as string) ?? 'omo error'))
          this.activeTurn = null
        }
        this.finishTurn()
        break
      default:
        break
    }
  }
}

const backend = new OmoBackend()
let contextSent = false

export class OmoProvider implements AIProvider {
  async sendMessage(messages: Message[], systemPrompt: string): Promise<string> {
    await backend.ensureStarted()
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const text = lastUser?.content ?? ''
    // The omo thread keeps conversation history server-side; the NekoAI
    // context block (pet name, facts, mood) only needs seeding once.
    const ctx = contextSent ? undefined : systemPrompt
    contextSent = true
    return backend.send(text, ctx)
  }
}
