import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  describeTrigger,
  loadSchedules,
  saveSchedules,
  triggerKind,
  type Schedule,
  type TriggerKind,
} from './scheduler'

const POLL_MS = 4_000

const TRIGGER_LABELS: { kind: TriggerKind; label: string }[] = [
  { kind: 'manual', label: '수동' },
  { kind: 'daily', label: '매일' },
  { kind: 'weekly', label: '매주' },
  { kind: 'interval', label: '간격' },
  { kind: 'once', label: '한 번' },
]

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']

function relTime(iso?: string): string {
  if (!iso) return '실행한 적 없음'
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return '방금 전'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface Draft {
  id: string | null
  name: string
  stepsText: string
  trigger: TriggerKind
  at: string
  weeklyDay: number
  everyMin: number
  onceAt: string // datetime-local value
}

const emptyDraft = (): Draft => ({
  id: null,
  name: '',
  stepsText: '',
  trigger: 'daily',
  at: '08:00',
  weeklyDay: 1,
  everyMin: 60,
  onceAt: '',
})

function draftFrom(s: Schedule): Draft {
  const onceDate = s.onceAt ? new Date(s.onceAt) : null
  return {
    id: s.id,
    name: s.name,
    stepsText: (s.steps?.length ? s.steps : [s.instruction]).join('\n'),
    trigger: triggerKind(s),
    at: s.at ?? '08:00',
    weeklyDay: s.weeklyDay ?? 1,
    everyMin: s.everyMin ?? 60,
    onceAt:
      onceDate && !isNaN(onceDate.getTime())
        ? `${onceDate.getFullYear()}-${String(onceDate.getMonth() + 1).padStart(2, '0')}-${String(
            onceDate.getDate()
          ).padStart(2, '0')}T${String(onceDate.getHours()).padStart(2, '0')}:${String(
            onceDate.getMinutes()
          ).padStart(2, '0')}`
        : '',
  }
}

export function AutomationPanel() {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  // id → timestamp when "지금 실행" was requested, to show a running spinner
  // until the main window writes back a newer lastRun.
  const [runningSince, setRunningSince] = useState<Record<string, number>>({})

  const reload = useCallback(async () => {
    const f = await loadSchedules()
    setSchedules(f.schedules)
    // Clear "running" markers once the main window writes back a lastRun
    // newer than the request timestamp.
    setRunningSince((prev) => {
      const next = { ...prev }
      let changed = false
      for (const [id, since] of Object.entries(prev)) {
        const s = f.schedules.find((x) => x.id === id)
        if (s?.lastRun && new Date(s.lastRun).getTime() >= since) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  useEffect(() => {
    const t = setInterval(() => void reload(), POLL_MS)
    queueMicrotask(() => void reload())
    return () => clearInterval(t)
  }, [reload])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (draft) setDraft(null)
      else invoke('close_panel_window').catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft])

  const persist = useCallback(async (list: Schedule[]) => {
    setSchedules(list)
    await saveSchedules({ schedules: list }).catch((e) =>
      console.error('[automation] save failed:', e)
    )
  }, [])

  const runNow = useCallback((id: string) => {
    setRunningSince((p) => ({ ...p, [id]: Date.now() }))
    invoke('panel_action', { action: `run-now:${id}` }).catch((e) =>
      console.error('[automation] run-now failed:', e)
    )
  }, [])

  const saveDraft = useCallback(() => {
    if (!draft) return
    const name = draft.name.trim()
    const steps = draft.stepsText
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
    if (!name || steps.length === 0) return
    const entry: Schedule = {
      id: draft.id ?? `s-${Date.now().toString(36)}`,
      name,
      instruction: steps.join(' → '),
      steps,
      trigger: draft.trigger,
      at: /^\d{1,2}:\d{2}$/.test(draft.at) ? draft.at.padStart(5, '0') : '08:00',
      weeklyDay: draft.weeklyDay,
      everyMin: draft.everyMin,
      onceAt: draft.onceAt ? new Date(draft.onceAt).toISOString() : undefined,
      enabled: draft.id ? (schedules.find((x) => x.id === draft.id)?.enabled ?? true) : true,
      lastRun: draft.id ? schedules.find((x) => x.id === draft.id)?.lastRun : undefined,
      lastError: draft.id ? schedules.find((x) => x.id === draft.id)?.lastError : undefined,
      lastResult: draft.id ? schedules.find((x) => x.id === draft.id)?.lastResult : undefined,
      runCount: draft.id ? schedules.find((x) => x.id === draft.id)?.runCount : undefined,
    }
    void persist(
      draft.id ? schedules.map((x) => (x.id === draft.id ? entry : x)) : [...schedules, entry]
    )
    setDraft(null)
  }, [draft, schedules, persist])

  // ── Editor view ────────────────────────────────────────────────────────────
  if (draft) {
    return (
      <div style={st.root}>
        <div style={st.header}>
          <span style={st.title}>{draft.id ? '매크로 수정' : '새 매크로'}</span>
          <button style={st.closeBtn} onClick={() => setDraft(null)} title="목록으로">
            ←
          </button>
        </div>
        <div style={st.body}>
          <label style={st.label}>이름</label>
          <input
            style={st.input}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="아침 뉴스 정리"
            autoFocus
          />

          <label style={st.label}>할 일 — 한 줄에 한 단계</label>
          <textarea
            style={st.textarea}
            value={draft.stepsText}
            onChange={(e) => setDraft({ ...draft, stepsText: e.target.value })}
            placeholder={
              '예)\n네이버 뉴스 헤드라인 10개 수집\n요약해서 ~/.sidecat/runs/news.md 에 저장'
            }
            spellCheck={false}
          />
          <p style={st.hint}>omo가 위에서부터 순서대로 실행해요</p>

          <label style={st.label}>언제 실행할까</label>
          <div style={st.chipRow}>
            {TRIGGER_LABELS.map(({ kind, label }) => (
              <button
                key={kind}
                style={{
                  ...st.chip,
                  ...(draft.trigger === kind ? st.chipActive : {}),
                }}
                onClick={() => setDraft({ ...draft, trigger: kind })}
              >
                {label}
              </button>
            ))}
          </div>

          {(draft.trigger === 'daily' || draft.trigger === 'weekly') && (
            <div style={st.condRow}>
              {draft.trigger === 'weekly' && (
                <select
                  style={st.select}
                  value={draft.weeklyDay}
                  onChange={(e) => setDraft({ ...draft, weeklyDay: Number(e.target.value) })}
                >
                  {WEEKDAY_LABELS.map((w, i) => (
                    <option key={w} value={i}>
                      {w}요일
                    </option>
                  ))}
                </select>
              )}
              <input
                style={{ ...st.input, width: 90 }}
                type="time"
                value={draft.at}
                onChange={(e) => setDraft({ ...draft, at: e.target.value })}
              />
              <span style={st.hintInline}>에 실행</span>
            </div>
          )}

          {draft.trigger === 'interval' && (
            <div style={st.condRow}>
              <input
                style={{ ...st.input, width: 70 }}
                type="number"
                min={5}
                step={5}
                value={draft.everyMin}
                onChange={(e) =>
                  setDraft({ ...draft, everyMin: Math.max(5, Number(e.target.value) || 5) })
                }
              />
              <span style={st.hintInline}>분마다 실행</span>
            </div>
          )}

          {draft.trigger === 'once' && (
            <div style={st.condRow}>
              <input
                style={st.input}
                type="datetime-local"
                value={draft.onceAt}
                onChange={(e) => setDraft({ ...draft, onceAt: e.target.value })}
              />
              <span style={st.hintInline}>에 한 번</span>
            </div>
          )}
        </div>
        <div style={st.footer}>
          <button
            style={{
              ...st.primaryBtn,
              ...(draft.name.trim() && draft.stepsText.trim() ? {} : st.btnDisabled),
            }}
            onClick={saveDraft}
            disabled={!draft.name.trim() || !draft.stepsText.trim()}
          >
            저장
          </button>
          <button style={st.ghostBtn} onClick={() => setDraft(null)}>
            취소
          </button>
        </div>
      </div>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <div style={st.root}>
      <div style={st.header}>
        <span style={st.title}>🤖 자동화 매크로</span>
        <button
          style={st.closeBtn}
          onClick={() => invoke('close_panel_window').catch(() => {})}
          title="닫기"
        >
          ✕
        </button>
      </div>
      <div style={st.body}>
        {schedules.length === 0 && (
          <div style={st.empty}>
            아직 매크로가 없어요.
            <br />
            고양이에게 "매일 8시에 뉴스 정리해줘"라고 말해도
            <br />
            여기에 자동으로 생겨요.
          </div>
        )}
        {schedules.map((s) => {
          const running = runningSince[s.id] !== undefined
          return (
            <div key={s.id} style={{ ...st.card, opacity: s.enabled || running ? 1 : 0.55 }}>
              <div style={st.cardTop}>
                <span style={st.cardName}>{s.name}</span>
                <span style={st.cardTrigger}>{describeTrigger(s)}</span>
              </div>
              <div style={st.cardMeta}>
                {running ? (
                  <span style={st.metaRunning}>⏳ 실행 중…</span>
                ) : s.lastError ? (
                  <span style={st.metaError} title={s.lastError}>
                    ⚠ {relTime(s.lastRun)} 실패
                  </span>
                ) : (
                  <span style={st.metaOk}>
                    {s.lastRun ? `✓ ${relTime(s.lastRun)}` : '실행한 적 없음'}
                    {s.runCount ? ` · ${s.runCount}회` : ''}
                  </span>
                )}
              </div>
              {s.lastResult && !running && (
                <div style={st.cardResult} title={s.lastResult}>
                  {s.lastResult}
                </div>
              )}
              <div style={st.cardActions}>
                <button
                  style={st.miniBtn}
                  onClick={() => runNow(s.id)}
                  disabled={running}
                  title="지금 바로 실행"
                >
                  {running ? '⏳' : '▶'} 실행
                </button>
                <button style={st.miniBtn} onClick={() => setDraft(draftFrom(s))}>
                  ✏️ 편집
                </button>
                <button
                  style={st.miniBtn}
                  onClick={() =>
                    void persist(
                      schedules.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x))
                    )
                  }
                  title={s.enabled ? '자동 실행 끄기' : '자동 실행 켜기'}
                >
                  {s.enabled ? '⏸ 끄기' : '▶ 켜기'}
                </button>
                <button
                  style={{ ...st.miniBtn, ...st.miniBtnDanger }}
                  onClick={() => void persist(schedules.filter((x) => x.id !== s.id))}
                  title="삭제"
                >
                  🗑
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div style={st.footer}>
        <button style={st.primaryBtn} onClick={() => setDraft(emptyDraft())}>
          + 새 매크로
        </button>
      </div>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(18, 18, 28, 0.98)',
    border: '1px solid #3a3a5c',
    borderRadius: 12,
    color: '#e0e0e0',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.04)',
    borderBottom: '1px solid #2a2a3c',
    flexShrink: 0,
  },
  title: { fontWeight: 700, fontSize: 14, color: '#fff' },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: 15,
    lineHeight: 1,
  },
  body: { flex: 1, overflowY: 'auto', padding: '12px 14px' },
  footer: {
    padding: '10px 14px',
    borderTop: '1px solid #2a2a3c',
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
  label: {
    display: 'block',
    fontSize: 11,
    color: '#999',
    marginTop: 10,
    marginBottom: 4,
    fontWeight: 600,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    background: '#1a1a2e',
    border: '1px solid #3a3a5c',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '7px 9px',
    fontSize: 13,
    fontFamily: 'inherit',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 110,
    resize: 'vertical',
    background: '#1a1a2e',
    border: '1px solid #3a3a5c',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '8px 9px',
    fontSize: 12.5,
    fontFamily: 'inherit',
    lineHeight: 1.55,
  },
  hint: { fontSize: 11, color: '#777', margin: '4px 0 0' },
  hintInline: { fontSize: 12, color: '#999' },
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: {
    background: '#1a1a2e',
    border: '1px solid #3a3a5c',
    borderRadius: 14,
    color: '#aaa',
    cursor: 'pointer',
    fontSize: 12,
    padding: '5px 12px',
  },
  chipActive: { background: '#3a3a6c', borderColor: '#7878cc', color: '#cceeff' },
  condRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
  select: {
    background: '#1a1a2e',
    border: '1px solid #3a3a5c',
    borderRadius: 6,
    color: '#e0e0e0',
    padding: '6px 8px',
    fontSize: 13,
  },
  primaryBtn: {
    flex: 1,
    background: '#4a5adf',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    padding: '9px 0',
  },
  ghostBtn: {
    background: 'none',
    border: '1px solid #3a3a5c',
    borderRadius: 8,
    color: '#999',
    cursor: 'pointer',
    fontSize: 13,
    padding: '9px 14px',
  },
  btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  empty: {
    textAlign: 'center',
    color: '#777',
    fontSize: 12.5,
    lineHeight: 1.8,
    padding: '40px 10px',
  },
  card: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid #2a2a3c',
    borderRadius: 10,
    padding: '10px 12px',
    marginBottom: 10,
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  cardName: { fontWeight: 700, fontSize: 13.5, color: '#fff', flex: 1 },
  cardTrigger: {
    fontSize: 11,
    color: '#9db4ff',
    background: 'rgba(90,110,220,0.15)',
    border: '1px solid #3a3a6c',
    borderRadius: 10,
    padding: '2px 8px',
    flexShrink: 0,
  },
  cardMeta: { marginTop: 5, fontSize: 11.5 },
  metaOk: { color: '#8fd18f' },
  metaError: { color: '#e08855' },
  metaRunning: { color: '#ffd27f' },
  cardResult: {
    marginTop: 6,
    fontSize: 11.5,
    color: '#9a9ab0',
    background: 'rgba(0,0,0,0.25)',
    borderRadius: 6,
    padding: '6px 8px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 60,
    overflowY: 'auto',
  },
  cardActions: { display: 'flex', gap: 6, marginTop: 8 },
  miniBtn: {
    background: '#1a1a2e',
    border: '1px solid #3a3a5c',
    borderRadius: 6,
    color: '#bbb',
    cursor: 'pointer',
    fontSize: 11.5,
    padding: '4px 9px',
  },
  miniBtnDanger: { color: '#e05555' },
}
