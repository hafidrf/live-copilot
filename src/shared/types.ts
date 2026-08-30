export type LlmProvider = 'gemini' | 'deepseek' | 'groq' | '9router'

export interface AudioChunk {
  seq: number
  wav: Uint8Array
  startedAt: number
}

export interface AnswerOption {
  id: string
  label: string
  body: string
}

export interface TranscriptSegment {
  id: string
  seq: number
  text: string
  translation?: string
  isQuestion: boolean
  answer?: string
  answers?: AnswerOption[]
  createdAt: number
}

export interface SessionStatus {
  listening: boolean
  error: string | null
  llmError: string | null
  droppedSilentChunks: number
  inFlightRequests: number
  sttRequests: number
  estimatedCostUsd: number
}

export interface ProviderKeyStatus {
  configured: boolean
  source: 'saved' | 'env' | 'none'
  masked: string | null
}

export interface AppOptions {
  chunkSeconds: number
  energyThreshold: number
  contextFolder: string | null
  contentProtection: boolean
  llmModel: string
  captionFontScale: number
}

export interface AppSettingsView {
  provider: LlmProvider
  active: ProviderKeyStatus
  gemini: ProviderKeyStatus
  deepseek: ProviderKeyStatus
  groq: ProviderKeyStatus
  '9router': ProviderKeyStatus
  options: AppOptions
  windowsBuild: number | null
  contentProtectionSupported: boolean
}

export type SaveOptionsPartial = Partial<AppOptions>
