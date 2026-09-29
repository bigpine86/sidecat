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

// One "speak first" agent turn: persona + a randomly picked concept, delivered
// as a 1–2 sentence reply the caller surfaces in a bubble.
export async function proactiveBark(): Promise<string | null> {
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
}
