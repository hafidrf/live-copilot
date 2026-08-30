import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
  AppOptions,
  AppSettingsView,
  LlmProvider,
  ProviderKeyStatus,
  SaveOptionsPartial
} from '../shared/types'

const SETTINGS_FILE = 'settings.json'

const DEFAULT_OPTIONS: AppOptions = {
  chunkSeconds: 6,
  energyThreshold: 0.001,
  contextFolder: null,
  contentProtection: false,
  llmModel: 'llama-3.3-70b-versatile',
  captionFontScale: 1
}

interface SettingsFile {
  provider?: LlmProvider
  apiKey?: string
  geminiApiKey?: string
  deepseekApiKey?: string
  groqApiKey?: string
  ninerouterApiKey?: string
  chunkSeconds?: number
  energyThreshold?: number
  contextFolder?: string | null
  contentProtection?: boolean
  llmModel?: string
  captionFontScale?: number
}

function settingsPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, SETTINGS_FILE)
}

function maskKey(key: string): string {
  if (key.length <= 10) return '••••••••'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}

function migrateSettings(raw: SettingsFile): SettingsFile {
  if (raw.apiKey && !raw.geminiApiKey) {
    return {
      ...raw,
      geminiApiKey: raw.apiKey,
      apiKey: undefined
    }
  }
  return raw
}

function readSettings(): SettingsFile {
  const path = settingsPath()
  if (!existsSync(path)) {
    return { provider: 'groq' }
  }
  try {
    return migrateSettings(JSON.parse(readFileSync(path, 'utf-8')) as SettingsFile)
  } catch {
    return { provider: 'groq' }
  }
}

function writeSettings(settings: SettingsFile): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

function envKey(provider: LlmProvider): string | null {
  if (provider === 'gemini') {
    return import.meta.env.MAIN_VITE_GEMINI_API_KEY?.trim() || null
  }
  if (provider === 'deepseek') {
    return import.meta.env.MAIN_VITE_DEEPSEEK_API_KEY?.trim() || null
  }
  if (provider === 'groq') {
    return import.meta.env.MAIN_VITE_GROQ_API_KEY?.trim() || null
  }
  return import.meta.env.MAIN_VITE_NINEROUTER_API_KEY?.trim() || null
}

function savedKey(settings: SettingsFile, provider: LlmProvider): string | null {
  if (provider === 'gemini') {
    return settings.geminiApiKey?.trim() || null
  }
  if (provider === 'deepseek') {
    return settings.deepseekApiKey?.trim() || null
  }
  if (provider === 'groq') {
    return settings.groqApiKey?.trim() || null
  }
  return settings.ninerouterApiKey?.trim() || null
}

function keyStatusFor(settings: SettingsFile, provider: LlmProvider): ProviderKeyStatus {
  const saved = savedKey(settings, provider)
  if (saved) {
    return { configured: true, source: 'saved', masked: maskKey(saved) }
  }

  const fromEnv = envKey(provider)
  if (fromEnv) {
    return { configured: true, source: 'env', masked: maskKey(fromEnv) }
  }

  return { configured: false, source: 'none', masked: null }
}

function clampChunkSeconds(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_OPTIONS.chunkSeconds
  return Math.max(3, Math.min(10, Math.round(value * 10) / 10))
}

function clampEnergy(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_OPTIONS.energyThreshold
  return Math.max(0.0005, Math.min(0.05, value))
}

function clampFontScale(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_OPTIONS.captionFontScale
  return Math.max(0.8, Math.min(1.6, Math.round(value * 100) / 100))
}

export function getProvider(): LlmProvider {
  return readSettings().provider ?? 'groq'
}

export function saveProvider(provider: LlmProvider): void {
  const settings = readSettings()
  writeSettings({ ...settings, provider })
}

export function getApiKey(provider?: LlmProvider): string | null {
  const active = provider ?? getProvider()
  const settings = readSettings()
  return savedKey(settings, active) ?? envKey(active)
}

export function saveApiKey(provider: LlmProvider, key: string): void {
  const settings = readSettings()
  const trimmed = key.trim()
  if (provider === 'gemini') {
    writeSettings({ ...settings, geminiApiKey: trimmed })
  } else if (provider === 'deepseek') {
    writeSettings({ ...settings, deepseekApiKey: trimmed })
  } else if (provider === 'groq') {
    writeSettings({ ...settings, groqApiKey: trimmed })
  } else {
    writeSettings({ ...settings, ninerouterApiKey: trimmed })
  }
}

export function clearApiKey(provider: LlmProvider): void {
  const settings = readSettings()
  if (provider === 'gemini') {
    writeSettings({ ...settings, geminiApiKey: undefined })
  } else if (provider === 'deepseek') {
    writeSettings({ ...settings, deepseekApiKey: undefined })
  } else if (provider === 'groq') {
    writeSettings({ ...settings, groqApiKey: undefined })
  } else {
    writeSettings({ ...settings, ninerouterApiKey: undefined })
  }
}

export function getOptions(): AppOptions {
  const s = readSettings()
  return {
    chunkSeconds: clampChunkSeconds(s.chunkSeconds),
    energyThreshold: clampEnergy(s.energyThreshold),
    contextFolder: s.contextFolder ?? null,
    contentProtection: Boolean(s.contentProtection),
    llmModel: s.llmModel?.trim() || DEFAULT_OPTIONS.llmModel,
    captionFontScale: clampFontScale(s.captionFontScale)
  }
}

export function saveOptions(partial: SaveOptionsPartial): AppOptions {
  const settings = readSettings()
  const next: SettingsFile = { ...settings }

  if (partial.chunkSeconds !== undefined) {
    next.chunkSeconds = clampChunkSeconds(partial.chunkSeconds)
  }
  if (partial.energyThreshold !== undefined) {
    next.energyThreshold = clampEnergy(partial.energyThreshold)
  }
  if (partial.contextFolder !== undefined) {
    next.contextFolder = partial.contextFolder
  }
  if (partial.contentProtection !== undefined) {
    next.contentProtection = partial.contentProtection
  }
  if (partial.llmModel !== undefined) {
    next.llmModel = partial.llmModel.trim() || DEFAULT_OPTIONS.llmModel
  }
  if (partial.captionFontScale !== undefined) {
    next.captionFontScale = clampFontScale(partial.captionFontScale)
  }

  writeSettings(next)
  return getOptions()
}

function readWindowsBuild(): number | null {
  if (process.platform !== 'win32') return null
  const release = process.getSystemVersion?.() ?? ''
  // Windows 10 2004 = build 19041
  const match = release.match(/\.(\d+)$/)
  if (match) return Number(match[1])
  return null
}

export function getAppSettings(): AppSettingsView {
  const settings = readSettings()
  const provider = settings.provider ?? 'groq'
  const windowsBuild = readWindowsBuild()
  return {
    provider,
    active: keyStatusFor(settings, provider),
    gemini: keyStatusFor(settings, 'gemini'),
    deepseek: keyStatusFor(settings, 'deepseek'),
    groq: keyStatusFor(settings, 'groq'),
    '9router': keyStatusFor(settings, '9router'),
    options: getOptions(),
    windowsBuild,
    contentProtectionSupported: windowsBuild === null || windowsBuild >= 19041
  }
}
