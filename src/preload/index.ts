import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AppSettingsView,
  AudioChunk,
  LlmProvider,
  SaveOptionsPartial,
  SessionStatus,
  TranscriptSegment
} from '../shared/types'

const api = {
  getSettings: (): Promise<AppSettingsView> => ipcRenderer.invoke('settings:get'),
  saveProvider: (provider: LlmProvider): Promise<AppSettingsView> =>
    ipcRenderer.invoke('settings:save-provider', provider),
  saveApiKey: (provider: LlmProvider, key: string): Promise<AppSettingsView> =>
    ipcRenderer.invoke('settings:save-api-key', provider, key),
  clearApiKey: (provider: LlmProvider): Promise<AppSettingsView> =>
    ipcRenderer.invoke('settings:clear-api-key', provider),
  saveOptions: (partial: SaveOptionsPartial): Promise<AppSettingsView> =>
    ipcRenderer.invoke('settings:save-options', partial),

  startSession: (): Promise<SessionStatus> => ipcRenderer.invoke('session:start'),
  stopSession: (): Promise<SessionStatus> => ipcRenderer.invoke('session:stop'),
  getSessionStatus: (): Promise<SessionStatus> => ipcRenderer.invoke('session:status'),

  sendAudioChunk: (chunk: AudioChunk): Promise<void> => {
    const copy = new Uint8Array(chunk.wav.byteLength)
    copy.set(chunk.wav)
    return ipcRenderer.invoke('audio:chunk', {
      seq: chunk.seq,
      startedAt: chunk.startedAt,
      wav: copy.buffer
    })
  },
  noteSilentDrop: (): Promise<SessionStatus> => ipcRenderer.invoke('audio:silent-drop'),
  listCaptureScreens: (): Promise<Array<{ id: string; name: string }>> =>
    ipcRenderer.invoke('capture:list-screens'),
  isElevated: (): Promise<{ elevated: boolean }> => ipcRenderer.invoke('capture:is-elevated'),

  pickContextFolder: (): Promise<AppSettingsView> => ipcRenderer.invoke('context:pick-folder'),
  reloadContext: (): Promise<{ chars: number; folder: string | null }> =>
    ipcRenderer.invoke('context:reload'),

  exportTranscript: (): Promise<{ path: string }> => ipcRenderer.invoke('transcript:export'),
  setWindowHeight: (height: number): Promise<void> =>
    ipcRenderer.invoke('window:set-height', height),
  setExpanded: (expanded: boolean): Promise<{ expanded: boolean; width?: number; height?: number }> =>
    ipcRenderer.invoke('window:set-expanded', expanded),
  quitApp: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  onSegment: (cb: (segment: TranscriptSegment) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, segment: TranscriptSegment): void => cb(segment)
    ipcRenderer.on('stt:segment', listener)
    return () => ipcRenderer.removeListener('stt:segment', listener)
  },
  onStatus: (cb: (status: SessionStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: SessionStatus): void => cb(status)
    ipcRenderer.on('session:status', listener)
    return () => ipcRenderer.removeListener('session:status', listener)
  },
  onHotkeyToggleListen: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('hotkey:toggle-listen', listener)
    return () => ipcRenderer.removeListener('hotkey:toggle-listen', listener)
  },
  onHotkeyToggleExpand: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('hotkey:toggle-expand', listener)
    return () => ipcRenderer.removeListener('hotkey:toggle-expand', listener)
  },
  onSettingsChanged: (cb: (settings: AppSettingsView) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, settings: AppSettingsView): void => cb(settings)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  onLiveCaption: (cb: (text: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { text: string }): void => cb(payload.text)
    ipcRenderer.on('live:caption', listener)
    return () => ipcRenderer.removeListener('live:caption', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error fallback when isolation is off
  window.electron = electronAPI
  // @ts-expect-error fallback when isolation is off
  window.api = api
}
