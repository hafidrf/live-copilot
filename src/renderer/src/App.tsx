import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { startSystemAudioCapture, type AudioCaptureHandle } from './audio/capture'
import type {
  AnswerOption,
  AppSettingsView,
  LlmProvider,
  SessionStatus,
  TranscriptSegment
} from '@shared/types'

const PROVIDERS: LlmProvider[] = ['groq', 'gemini', 'deepseek', '9router']

const PROVIDER_META: Record<LlmProvider, { name: string; hint: string; placeholder: string }> = {
  groq: {
    name: 'Groq',
    hint: 'STT + LLM. Key dari console.groq.com/keys',
    placeholder: 'gsk_...'
  },
  gemini: {
    name: 'Gemini',
    hint: 'LLM only. Key dari aistudio.google.com',
    placeholder: 'AIza...'
  },
  deepseek: {
    name: 'DeepSeek',
    hint: 'LLM only. Key dari platform.deepseek.com',
    placeholder: 'sk-...'
  },
  '9router': {
    name: '9Router',
    hint: 'LLM via localhost:20128/dashboard',
    placeholder: '9Router dashboard key'
  }
}

const EMPTY_STATUS: SessionStatus = {
  listening: false,
  error: null,
  llmError: null,
  droppedSilentChunks: 0,
  inFlightRequests: 0,
  sttRequests: 0,
  estimatedCostUsd: 0
}

export default function App(): ReactElement {
  const [settings, setSettings] = useState<AppSettingsView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [status, setStatus] = useState<SessionStatus>(EMPTY_STATUS)
  const [level, setLevel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [exportPath, setExportPath] = useState<string | null>(null)
  const [liveCaption, setLiveCaption] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [answerTab, setAnswerTab] = useState<string>('instant')
  const [copied, setCopied] = useState(false)
  const [elevated, setElevated] = useState(false)

  const captureRef = useRef<AudioCaptureHandle | null>(null)
  const seqRef = useRef(0)
  const optionsRef = useRef(settings?.options)
  const expandedRef = useRef(false)

  useEffect(() => {
    optionsRef.current = settings?.options
  }, [settings?.options])

  useEffect(() => {
    void window.api.isElevated().then((r) => setElevated(r.elevated)).catch(() => undefined)
    void window.api.getSettings().then(setSettings)
    const offSeg = window.api.onSegment((segment) => {
      setSegments((prev) => {
        const idx = prev.findIndex((s) => s.id === segment.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = { ...next[idx], ...segment }
          return next
        }
        return [...prev, segment]
      })
      if (segment.answers?.length && !expandedRef.current) {
        expandedRef.current = true
        setExpanded(true)
        void window.api.setExpanded(true)
        setAnswerTab(segment.answers[0]?.id ?? 'instant')
      }
    })
    const offStatus = window.api.onStatus(setStatus)
    const offSettings = window.api.onSettingsChanged(setSettings)
    const offLive = window.api.onLiveCaption(setLiveCaption)
    return () => {
      offSeg()
      offStatus()
      offSettings()
      offLive()
    }
  }, [])

  const stopCapture = useCallback(async () => {
    captureRef.current?.stop()
    captureRef.current = null
    setLive(false)
    await window.api.stopSession()
    setLevel(0)
  }, [])

  const startCapture = useCallback(async () => {
    setLocalError(null)
    setExportPath(null)
    setBusy(true)
    try {
      const opts = optionsRef.current ?? {
        chunkSeconds: 6,
        energyThreshold: 0.001,
        contextFolder: null,
        contentProtection: false,
        llmModel: 'llama-3.3-70b-versatile',
        captionFontScale: 1
      }

      setSegments([])
      seqRef.current = 0
      setLiveCaption('')
      setAnswerTab('instant')
      await window.api.startSession()

      const handle = await startSystemAudioCapture({
        chunkSeconds: opts.chunkSeconds,
        energyThreshold: opts.energyThreshold,
        onChunk: (wav, startedAt) => {
          const seq = seqRef.current++
          void window.api.sendAudioChunk({ seq, wav, startedAt })
        },
        onSilent: () => {
          void window.api.noteSilentDrop()
        }
      })

      captureRef.current = handle
      setLive(true)

      const tick = (): void => {
        if (!captureRef.current) return
        setLevel(captureRef.current.getLevel())
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } catch (err) {
      setLive(false)
      await window.api.stopSession()
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const toggleListen = useCallback(async () => {
    if (live || status.listening) {
      setBusy(true)
      try {
        await stopCapture()
      } finally {
        setBusy(false)
      }
      return
    }
    await startCapture()
  }, [live, startCapture, status.listening, stopCapture])

  const toggleExpand = useCallback(async () => {
    const next = !expandedRef.current
    expandedRef.current = next
    setExpanded(next)
    await window.api.setExpanded(next)
  }, [])

  useEffect(() => {
    return window.api.onHotkeyToggleListen(() => {
      void toggleListen()
    })
  }, [toggleListen])

  useEffect(() => {
    return window.api.onHotkeyToggleExpand(() => {
      void toggleExpand()
    })
  }, [toggleExpand])

  useEffect(() => {
    return () => {
      captureRef.current?.stop()
    }
  }, [])

  const fontScale = settings?.options.captionFontScale ?? 1
  const isLive = live || status.listening

  const latest = useMemo(() => {
    const withAnswers = [...segments].reverse().find((s) => s.answers?.length || s.answer)
    const question = [...segments].reverse().find((s) => s.isQuestion && !s.answer && !s.answers?.length)
    const last = segments[segments.length - 1]
    return {
      en: last?.text ?? '',
      id: last?.translation ?? '',
      answers: withAnswers?.answers ?? [],
      answer: withAnswers?.answer,
      questionText: withAnswers?.text ?? question?.text,
      drafting: Boolean(question)
    }
  }, [segments])

  const activeAnswer: AnswerOption | null = useMemo(() => {
    if (latest.answers.length) {
      return latest.answers.find((a) => a.id === answerTab) ?? latest.answers[0]
    }
    if (latest.answer) {
      return { id: 'instant', label: 'Instant', body: latest.answer }
    }
    return null
  }, [answerTab, latest.answer, latest.answers])

  const captionEn = isLive && liveCaption ? liveCaption : latest.en
  const sttError = localError || status.error
  const llmError = status.llmError

  async function onSaveProvider(provider: LlmProvider): Promise<void> {
    setSettings(await window.api.saveProvider(provider))
  }

  async function onSaveKey(): Promise<void> {
    if (!settings || !apiKeyDraft.trim()) return
    setSettings(await window.api.saveApiKey(settings.provider, apiKeyDraft.trim()))
    setApiKeyDraft('')
  }

  async function onClearKey(): Promise<void> {
    if (!settings) return
    setSettings(await window.api.clearApiKey(settings.provider))
  }

  async function onPickFolder(): Promise<void> {
    setSettings(await window.api.pickContextFolder())
  }

  async function onExport(): Promise<void> {
    const result = await window.api.exportTranscript()
    setExportPath(result.path)
  }

  async function onCloseApp(): Promise<void> {
    if (live || status.listening) {
      captureRef.current?.stop()
      captureRef.current = null
      setLive(false)
      await window.api.stopSession()
    }
    await window.api.quitApp()
  }

  async function onCopyAnswer(): Promise<void> {
    if (!activeAnswer?.body) return
    try {
      await navigator.clipboard.writeText(activeAnswer.body)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }

  return (
    <div
      className={`app${expanded ? ' expanded' : ''}`}
      style={{ ['--font-scale' as string]: String(fontScale) }}
    >
      <div className="shell">
        <div className="drag">
          <div className="brand">
            <span className={`brand-dot${isLive ? ' live' : ''}`} />
            Live Copilot
          </div>
          <div className="toolbar no-drag">
            <button
              className={`btn ${isLive ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={() => void toggleListen()}
            >
              {busy ? '…' : isLive ? 'Stop' : 'Listen'}
            </button>
            <button
              className={`btn${expanded ? ' primary' : ''}`}
              title="Expand / compact (Ctrl+Shift+E)"
              onClick={() => void toggleExpand()}
            >
              {expanded ? 'Compact' : 'Expand'}
            </button>
            <button className="btn" onClick={() => setSettingsOpen((v) => !v)}>
              Settings
            </button>
            <button className="btn" onClick={() => void onExport()} disabled={segments.length === 0}>
              Export
            </button>
            <button
              className="btn btn-close"
              title="Close app"
              aria-label="Close app"
              onClick={() => void onCloseApp()}
            >
              ×
            </button>
          </div>
        </div>

        <div className="body">
          <div className="meter-row">
            <div className="meter" aria-label="System audio level">
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <div className="meta">
              STT {status.sttRequests} · drop {status.droppedSilentChunks} · ~$
              {status.estimatedCostUsd.toFixed(3)}
              {status.inFlightRequests > 0 ? ` · inflight ${status.inFlightRequests}` : ''}
              {!settings?.options.contextFolder ? ' · no context' : ''}
            </div>
          </div>

          {elevated ? (
            <div className="error">
              Cursor/app jalan sebagai Administrator — capture audio sistem diblokir Windows.
              Tutup Cursor sepenuhnya, buka lagi tanpa &quot;Run as administrator&quot;, lalu jalankan Live
              Copilot lagi.
            </div>
          ) : null}
          {sttError ? <div className="error">STT: {sttError}</div> : null}
          {llmError ? <div className="error error-llm">LLM: {llmError}</div> : null}
          {exportPath ? <div className="hint">Exported: {exportPath}</div> : null}

          <div className="caption-en">
            {captionEn || (
              <span className="empty">
                {isLive
                  ? 'Listening to system audio… speak or play English audio.'
                  : 'Press Listen (Ctrl+Shift+Space). Captures speaker audio, not mic.'}
              </span>
            )}
          </div>
          <div className="caption-id">{latest.id || (captionEn ? '…' : '')}</div>

          {activeAnswer || latest.drafting ? (
            <div className="answer-panel">
              <div className="answer-header">
                <div className="answer-label">
                  {latest.drafting && !activeAnswer
                    ? 'Question detected — drafting 3 options…'
                    : latest.questionText
                      ? `Q: ${latest.questionText}`
                      : 'Suggested answers'}
                </div>
                {activeAnswer ? (
                  <button className="btn btn-mini" onClick={() => void onCopyAnswer()}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                ) : null}
              </div>

              {latest.answers.length > 0 ? (
                <div className="answer-tabs">
                  {latest.answers.map((opt) => (
                    <button
                      key={opt.id}
                      className={`answer-tab${(activeAnswer?.id ?? '') === opt.id ? ' active' : ''}`}
                      onClick={() => setAnswerTab(opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {activeAnswer ? <div className="answer-body">{activeAnswer.body}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      {settingsOpen && settings ? (
        <div className="settings-panel no-drag">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Settings</h2>
            <button className="btn" onClick={() => setSettingsOpen(false)}>
              Close
            </button>
          </div>

          <div className="field">
            <label>LLM provider</label>
            <div className="row">
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  className={`provider-chip${settings.provider === p ? ' active' : ''}`}
                  onClick={() => void onSaveProvider(p)}
                >
                  {PROVIDER_META[p].name}
                  {settings[p].configured ? ' ✓' : ''}
                </button>
              ))}
            </div>
            <div className="hint">{PROVIDER_META[settings.provider].hint}</div>
          </div>

          <div className="field">
            <label>API key — {PROVIDER_META[settings.provider].name}</label>
            {settings[settings.provider].configured ? (
              <div className="masked">
                Saved ({settings[settings.provider].source}): {settings[settings.provider].masked}
              </div>
            ) : (
              <div className="hint">Belum ada key tersimpan.</div>
            )}
            <div className="row">
              <input
                style={{ flex: 1 }}
                type="password"
                value={apiKeyDraft}
                placeholder={PROVIDER_META[settings.provider].placeholder}
                onChange={(e) => setApiKeyDraft(e.target.value)}
              />
              <button className="btn primary" onClick={() => void onSaveKey()}>
                Save
              </button>
              <button className="btn" onClick={() => void onClearKey()}>
                Clear
              </button>
            </div>
          </div>

          <div className="settings-grid">
            <div className="field">
              <label>Chunk seconds (≥3)</label>
              <input
                type="number"
                min={3}
                max={10}
                step={0.5}
                value={settings.options.chunkSeconds}
                onChange={(e) =>
                  void window.api
                    .saveOptions({ chunkSeconds: Number(e.target.value) })
                    .then(setSettings)
                }
              />
            </div>
            <div className="field">
              <label>Energy threshold</label>
              <input
                type="number"
                min={0.0005}
                max={0.05}
                step={0.0005}
                value={settings.options.energyThreshold}
                onChange={(e) =>
                  void window.api
                    .saveOptions({ energyThreshold: Number(e.target.value) })
                    .then(setSettings)
                }
              />
            </div>
          </div>

          <div className="field">
            <label>Context folder (CV / JD / project notes) — wajib untuk jawaban kuat</label>
            <div className="row">
              <button className="btn" onClick={() => void onPickFolder()}>
                Choose folder…
              </button>
              <button
                className="btn"
                onClick={() => void window.api.reloadContext()}
                disabled={!settings.options.contextFolder}
              >
                Reload
              </button>
            </div>
            <div className="hint">
              {settings.options.contextFolder ??
                'Belum dipilih — pilih folder job-applications/... supaya jawaban pakai project nyata (bukan [FILL]).'}
            </div>
          </div>

          <div className="field">
            <label>Hide from screen share (content protection)</label>
            <div className="row">
              <button
                className={`btn${settings.options.contentProtection ? ' primary' : ''}`}
                onClick={() =>
                  void window.api
                    .saveOptions({ contentProtection: !settings.options.contentProtection })
                    .then(setSettings)
                }
              >
                {settings.options.contentProtection ? 'On' : 'Off'}
              </button>
            </div>
          </div>

          <div className="hint">
            Hotkeys: Ctrl+Shift+Space listen · E expand · H hide · Enter force answer · Up/Down font
          </div>
        </div>
      ) : null}
    </div>
  )
}
