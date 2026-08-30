import { getApiKey, getOptions, getProvider } from './settings'
import type { LlmProvider } from '../shared/types'

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
    finish_reason?: string
  }>
  error?: {
    message?: string
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
  }>
  error?: {
    message?: string
  }
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const GEMINI_MODEL = 'gemini-2.5-flash'
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
const NINEROUTER_DEFAULT_BASE = 'http://127.0.0.1:20128/v1'
const NINEROUTER_DEFAULT_MODEL = 'ds/deepseek-v4-flash'
const DEEPSEEK_MODEL = 'deepseek-v4-flash'
const GROQ_FALLBACK_MODEL = 'llama-3.3-70b-versatile'

function nineRouterBase(): string {
  const fromEnv = import.meta.env.MAIN_VITE_NINEROUTER_BASE_URL?.trim()
  if (!fromEnv) return NINEROUTER_DEFAULT_BASE
  return fromEnv.replace(/\/+$/, '')
}

function nineRouterModel(): string {
  const fromSettings = getOptions().llmModel?.trim()
  if (fromSettings) return fromSettings
  return import.meta.env.MAIN_VITE_NINEROUTER_MODEL?.trim() || NINEROUTER_DEFAULT_MODEL
}

function fallbackOrder(primary: LlmProvider): LlmProvider[] {
  const order: LlmProvider[] = [primary]
  if (primary !== 'groq' && getApiKey('groq')) order.push('groq')
  if (primary !== 'gemini' && getApiKey('gemini')) order.push('gemini')
  if (primary !== 'deepseek' && getApiKey('deepseek')) order.push('deepseek')
  return order
}

async function callOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
  opts: ChatOptions,
  providerLabel: string
): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 1024,
        stream: false
      })
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Tidak bisa konek ke ${providerLabel}. ${detail}`)
  }

  const data = (await response.json()) as ChatCompletionResponse
  if (!response.ok) {
    throw new Error(data.error?.message ?? `${providerLabel} API error (${response.status})`)
  }

  const output = data.choices?.[0]?.message?.content?.trim()
  if (!output) {
    const reason = data.choices?.[0]?.finish_reason ?? 'unknown'
    throw new Error(`${providerLabel} tidak mengembalikan teks (${reason}).`)
  }
  return output
}

async function callGemini(system: string, user: string, opts: ChatOptions): Promise<string> {
  const apiKey = getApiKey('gemini')
  if (!apiKey) {
    throw new Error('Gemini API key belum diset. Buka Settings → Gemini → paste key.')
  }

  const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 1024
      }
    })
  })

  const data = (await response.json()) as GeminiResponse
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Gemini API error (${response.status})`)
  }

  const output = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  if (!output) {
    throw new Error('Gemini tidak mengembalikan teks. Coba lagi atau periksa quota.')
  }
  return output
}

async function callProviderOnce(
  provider: LlmProvider,
  system: string,
  user: string,
  opts: ChatOptions
): Promise<string> {
  if (provider === 'gemini') {
    return callGemini(system, user, opts)
  }

  if (provider === 'groq') {
    const apiKey = getApiKey('groq')
    if (!apiKey) {
      throw new Error('Groq API key belum diset. Buka Settings → Groq → paste key.')
    }
    const model = getOptions().llmModel || GROQ_FALLBACK_MODEL
    return callOpenAiCompatible(GROQ_URL, apiKey, model, system, user, opts, 'Groq')
  }

  if (provider === 'deepseek') {
    const apiKey = getApiKey('deepseek')
    if (!apiKey) {
      throw new Error('DeepSeek API key belum diset. Buka Settings → DeepSeek → paste key.')
    }
    return callOpenAiCompatible(DEEPSEEK_URL, apiKey, DEEPSEEK_MODEL, system, user, opts, 'DeepSeek')
  }

  const apiKey = getApiKey('9router')
  if (!apiKey) {
    throw new Error(
      '9Router API key belum diset. Buka Settings → 9Router → paste key dari http://localhost:20128/dashboard'
    )
  }
  return callOpenAiCompatible(
    `${nineRouterBase()}/chat/completions`,
    apiKey,
    nineRouterModel(),
    system,
    user,
    opts,
    '9Router'
  )
}

/** Single door for all LLM chat providers with automatic Groq/Gemini fallback. */
export async function chat(
  system: string,
  user: string,
  opts: ChatOptions = {}
): Promise<string> {
  const providers = fallbackOrder(getProvider())
  let lastErr: Error | null = null

  for (const provider of providers) {
    try {
      return await callProviderOnce(provider, system, user, opts)
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastErr ?? new Error('Semua LLM provider gagal.')
}
