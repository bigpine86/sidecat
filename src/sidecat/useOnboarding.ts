import { useEffect, useRef, useState } from 'react'
import { useConfigStore, isConfigured } from '../store/configStore'
import { OllamaProvider } from '../ai/providers/ollama'
import { probeOmoInstall, omoAuthProviderCount } from './omoProvider'

// First-launch onboarding orchestrator.
//
//   - 'idle'         → not started yet (config still loading)
//   - 'detecting'    → pinging localhost:11434 in the background (non-omo)
//   - 'checking'     → probing omo binary + auth (provider === 'omo')
//   - 'ollama_found' → Ollama responded; provider auto-configured, show celebratory bubble
//   - 'needs_setup'  → no Ollama and no API key; show CTA bubble
//   - 'omo_missing'  → provider omo but no binary found; install guide
//   - 'omo_no_auth'  → binary exists but no logged-in provider; login guide
//   - 'omo_ready'    → omo installed + authenticated; celebratory bubble
//   - 'done'         → onboarding finished or skipped; behave normally
//
// The state machine runs at most once per session — gated by configStore.isLoaded
// and the persisted `onboardingCompleted` flag.
export type OnboardingState =
  | 'idle'
  | 'detecting'
  | 'checking'
  | 'ollama_found'
  | 'needs_setup'
  | 'omo_missing'
  | 'omo_no_auth'
  | 'omo_ready'
  | 'done'

export type OmoStatus = 'missing' | 'no_auth' | 'ready'

async function probeOmoStatus(): Promise<OmoStatus> {
  if ((await probeOmoInstall()) === null) return 'missing'
  if ((await omoAuthProviderCount()) === 0) return 'no_auth'
  return 'ready'
}

function stateFor(st: OmoStatus): OnboardingState {
  return st === 'ready' ? 'omo_ready' : st === 'missing' ? 'omo_missing' : 'omo_no_auth'
}

interface UseOnboardingResult {
  state: OnboardingState
  detectedModel: string | null
  omoStatus: OmoStatus | null
  dismiss: () => void
  recheck: () => Promise<OmoStatus>
}

export function useOnboarding(): UseOnboardingResult {
  const { isLoaded, setOnboardingCompleted, applyOllamaAutoConfig } = useConfigStore()
  const [state, setState] = useState<OnboardingState>('idle')
  const [detectedModel, setDetectedModel] = useState<string | null>(null)
  const [omoStatus, setOmoStatus] = useState<OmoStatus | null>(null)
  const ranRef = useRef(false)

  useEffect(() => {
    if (!isLoaded || ranRef.current) return
    ranRef.current = true

    // Wrap the entire flow in an async IIFE so all setState calls happen
    // inside an async callback — synchronous setState in effect bodies trips
    // react-hooks/set-state-in-effect, but callback usage is fine.
    void (async () => {
      const current = useConfigStore.getState().config

      // Already onboarded, OR has working credentials — never show the flow.
      if (current.onboardingCompleted) {
        setState('done')
        return
      }

      // Sidecat: for the omo provider "configured" means the binary exists
      // and has a logged-in provider in ~/.omo — probe that instead of the
      // apiKey check (omo carries its own auth).
      if (current.provider === 'omo') {
        setState('checking')
        const st = await probeOmoStatus()
        setOmoStatus(st)
        setState(stateFor(st))
        return
      }

      if (isConfigured(current)) {
        // Self-heal: an existing user with credentials but no flag (upgrade
        // path from a pre-onboarding TOML) gets the flag stamped now.
        await setOnboardingCompleted(true)
        setState('done')
        return
      }

      setState('detecting')
      const result = await OllamaProvider.detect()
      if (result.ok && result.models.length > 0) {
        const model = result.models[0]
        await applyOllamaAutoConfig(model)
        setDetectedModel(model)
        setState('ollama_found')
      } else {
        setState('needs_setup')
      }
    })()
  }, [isLoaded, setOnboardingCompleted, applyOllamaAutoConfig])

  const dismiss = () => {
    void setOnboardingCompleted(true)
    setState('done')
  }

  // Re-probe omo binary + auth after the user installed/logged in following
  // the guide. Returns the new status so the caller can refresh the bubble.
  const recheck = async (): Promise<OmoStatus> => {
    const st = await probeOmoStatus()
    setOmoStatus(st)
    setState(stateFor(st))
    return st
  }

  return { state, detectedModel, omoStatus, dismiss, recheck }
}
