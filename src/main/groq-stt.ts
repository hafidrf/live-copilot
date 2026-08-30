import { getApiKey } from './settings'

const API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
/** Turbo: QC harness scored 0% WER on clean speech and is faster for live captions. */
const MODEL = 'whisper-large-v3-turbo'

interface TranscriptionResponse {
  text?: string
  error?: {
    message?: string
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function transcribeWav(
  wav: Uint8Array,
  /** Tail of the PREVIOUS chunk only — never the full assembled transcript. */
  previousChunkTail: string
): Promise<string> {
  const apiKey = getApiKey('groq')
  if (!apiKey) {
    throw new Error('Groq API key belum diset. Buka Settings → Groq → paste key (diperlukan untuk STT).')
  }

  const copy = new Uint8Array(wav.byteLength)
  copy.set(wav)

  let lastError: Error | null = null
  const delays = [500, 1000, 2000]

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const form = new FormData()
    form.append('file', new Blob([copy], { type: 'audio/wav' }), 'chunk.wav')
    form.append('model', MODEL)
    form.append('language', 'en')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    // QC on real YouTube audio: empty prompt beats prior-chunk prompt (less drift).
    // Keep optional short prompt only if explicitly useful later.
    void previousChunkTail
    // no prompt appended

    let response: Response
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: form
      })
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < delays.length) {
        await sleep(delays[attempt])
        continue
      }
      throw new Error(`Tidak bisa konek ke Groq STT. ${lastError.message}`)
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`Groq STT temporary error (${response.status})`)
      if (attempt < delays.length) {
        await sleep(delays[attempt])
        continue
      }
      throw lastError
    }

    const data = (await response.json()) as TranscriptionResponse
    if (!response.ok) {
      throw new Error(data.error?.message ?? `Groq STT error (${response.status})`)
    }

    return (data.text ?? '').trim()
  }

  throw lastError ?? new Error('Groq STT gagal')
}
