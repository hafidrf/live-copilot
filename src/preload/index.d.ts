import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AppSettingsView,
  AudioChunk,
  LlmProvider,
  SaveOptionsPartial,
  SessionStatus,
  TranscriptSegment
} from '../shared/types'

export interface LiveCopilotApi {
  getSettings: () => Promise<AppSettingsView>
  saveProvider: (provider: LlmProvider) => Promise<AppSettingsView>
  saveApiKey: (provider: LlmProvider, key: string) => Promise<AppSettingsView>
  clearApiKey: (provider: LlmProvider) => Promise<AppSettingsView>
  saveOptions: (partial: SaveOptionsPartial) => Promise<AppSettingsView>
  startSession: () => Promise<SessionStatus>
  stopSession: () => Promise<SessionStatus>
  getSessionStatus: () => Promise<SessionStatus>
  sendAudioChunk: (chunk: AudioChunk) => Promise<void>
  noteSilentDrop: () => Promise<SessionStatus>
  listCaptureScreens: () => Promise<Array<{ id: string; name: string }>>
  isElevated: () => Promise<{ elevated: boolean }>
  pickContextFolder: () => Promise<AppSettingsView>
  reloadContext: () => Promise<{ chars: number; folder: string | null }>
  exportTranscript: () => Promise<{ path: string }>
  setWindowHeight: (height: number) => Promise<void>
  setExpanded: (expanded: boolean) => Promise<{ expanded: boolean; width?: number; height?: number }>
  quitApp: () => Promise<void>
  onSegment: (cb: (segment: TranscriptSegment) => void) => () => void
  onStatus: (cb: (status: SessionStatus) => void) => () => void
  onHotkeyToggleListen: (cb: () => void) => () => void
  onHotkeyToggleExpand: (cb: () => void) => () => void
  onSettingsChanged: (cb: (settings: AppSettingsView) => void) => () => void
  onLiveCaption: (cb: (text: string) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: LiveCopilotApi
  }
}

export {}
