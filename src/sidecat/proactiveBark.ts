import { invoke } from '@tauri-apps/api/core'
import { useConfigStore, isConfigured } from '../store/configStore'
import { useAppStore } from '../store'
import { createAIProvider, buildContextBlock } from '../ai'
import { loadFacts } from '../ai/memory'

// ── Sidecat zone: proactive barks ─────────────────────────────────────────────
// Everything in src/sidecat/ is ours — upstream merges can never touch it.
// App.tsx keeps only the seam (timer + announcement wiring).

// Weighted, time-of-day aware concept picker: at lunch the cat is hungry, late
// at night it nags the user to sleep, and occasionally it snarks or talks
// weather — a real cat has moods, not a script.
export function pickBarkHint(): string {
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

// Recent bark texts — fed back into the prompt so the cat doesn't repeat
// itself across fires (the "context" channel only reaches the model on the
// very first turn of the omo thread, so anything we want every bark to see
// must ride inside the message text).
const recentBarks: string[] = []

// Collapse exact duplicate sentences — LLMs sometimes emit the same line
// twice when asked for "1~2 sentences".
function dedupeSentences(text: string): string {
  const sentences = text
    .split(/(?<=[.!?…~])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const kept = sentences.filter((s) => {
    if (seen.has(s)) return false
    seen.add(s)
    return true
  })
  return kept.join(' ') || text
}

// One "speak first" agent turn: persona + a concept, delivered as a 1–2
// sentence reply the caller surfaces in a bubble. `hint` overrides the random
// concept picker for situational barks (e.g. stepping out of the house).
export async function proactiveBark(hint?: string): Promise<string | null> {
  const { config: cfg } = useConfigStore.getState()
  if (!isConfigured(cfg)) return null
  const [facts] = await Promise.all([loadFacts()])
  const mood = useAppStore.getState().mood
  const systemPrompt =
    buildContextBlock('Sidecat', facts, mood) +
    `\n\n[자발 발화] 사용자가 먼저 말을 걸지 않았다. 네가 먼저 말풍선에 띄울 한마디를 한다.`
  // Persona + concept ride inside the turn text — see recentBarks comment.
  const avoid =
    recentBarks.length > 0
      ? ` 이전에 이미 한 말들(같은 말 또 하지 마): ${recentBarks.map((t) => `"${t}"`).join(' / ')}.`
      : ''
  const turnText =
    `[먼저 말 걸기] 너는 츤츤거리는 데스크톱 고양이 Sidecat이다. 한국어 반말, 짧고 시크하지만 ` +
    `속으로는 사용자를 챙기는 타입. "냥"은 가끔만. 이번 컨셉: ${hint ?? pickBarkHint()}.${avoid} ` +
    `규칙: 순수 텍스트 1~2문장만. 컨셉을 말로 언급하지 말고 자연스러운 행동으로. 같은 문장 반복 금지.`
  await invoke('save_message', { role: 'user', content: '[먼저 말 걸기]' }).catch(() => {})
  const provider = createAIProvider(cfg)
  const reply = await provider.sendMessage([{ role: 'user', content: turnText }], systemPrompt)
  const cleaned = dedupeSentences(reply.trim())
  await invoke('save_message', { role: 'assistant', content: cleaned }).catch(() => {})
  if (cleaned) {
    recentBarks.push(cleaned)
    if (recentBarks.length > 6) recentBarks.shift()
  }
  return cleaned
}
