import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, session, shell } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { reloadContext } from './context'
import { isProcessElevated } from './elevation'
import {
  clearApiKey,
  getAppSettings,
  getOptions,
  saveApiKey,
  saveOptions,
  saveProvider
} from './settings'
import { sessionPipeline } from './session'
import type { LlmProvider, SaveOptionsPartial } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let isQuitInProgress = false
const elevated = isProcessElevated()

// Electron 37+ on Windows: WGC screen capture fails when elevated (0x80070005).
// Prefer older DXGI path when possible.
app.commandLine.appendSwitch(
  'disable-features',
  'WebRtcAllowWgcDesktopCapturer,AllowWgcScreenCapturer,AllowWgcWindowCapturer'
)

function resolveAppIcon(): string | undefined {
  const buildPng = join(__dirname, '../../build/icon.png')
  const buildIco = join(__dirname, '../../build/icon.ico')
  const resourcePng = join(process.resourcesPath, 'icon.png')
  const resourceIco = join(process.resourcesPath, 'icon.ico')
  const candidates =
    process.platform === 'darwin'
      ? [buildPng, resourcePng, buildIco, resourceIco]
      : [buildIco, buildPng, resourceIco, resourcePng]
  return candidates.find((p) => existsSync(p))
}

function applyContentProtection(win: BrowserWindow, enabled: boolean): void {
  // Order matters: set opacity before content protection (Electron Windows bug workaround).
  // Never combine with setIgnoreMouseEvents(true).
  win.setOpacity(1.0)
  win.setContentProtection(enabled)
}

function placeBottomCenter(win: BrowserWindow): void {
  const display = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = display.workAreaSize
  const [ww, wh] = win.getSize()
  const x = Math.round((sw - ww) / 2)
  const y = Math.round(sh - wh - 24)
  win.setPosition(x + display.workArea.x, y + display.workArea.y)
}

const COMPACT = { width: 980, height: 360 }
const EXPANDED = { width: 1120, height: 640 }

function createWindow(): BrowserWindow {
  const icon = resolveAppIcon()
  const win = new BrowserWindow({
    width: COMPACT.width,
    height: COMPACT.height,
    minWidth: 640,
    minHeight: 220,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: 'Live Copilot',
    backgroundColor: '#00000000',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver', 1)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const options = getOptions()
  applyContentProtection(win, options.contentProtection)

  win.on('ready-to-show', () => {
    placeBottomCenter(win)
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  sessionPipeline.attach(win)
  return win
}

function broadcastToRenderer(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll()

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    broadcastToRenderer('hotkey:toggle-listen')
  })

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
    }
  })

  globalShortcut.register('CommandOrControl+Shift+Enter', () => {
    void sessionPipeline.answerLast()
  })

  globalShortcut.register('CommandOrControl+Shift+E', () => {
    broadcastToRenderer('hotkey:toggle-expand')
  })

  globalShortcut.register('CommandOrControl+Shift+Up', () => {
    const opts = getOptions()
    const next = Math.min(1.6, Math.round((opts.captionFontScale + 0.1) * 100) / 100)
    saveOptions({ captionFontScale: next })
    broadcastToRenderer('settings:changed', getAppSettings())
  })

  globalShortcut.register('CommandOrControl+Shift+Down', () => {
    const opts = getOptions()
    const next = Math.max(0.8, Math.round((opts.captionFontScale - 0.1) * 100) / 100)
    saveOptions({ captionFontScale: next })
    broadcastToRenderer('settings:changed', getAppSettings())
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => getAppSettings())

  ipcMain.handle('settings:save-provider', (_e, provider: LlmProvider) => {
    saveProvider(provider)
    return getAppSettings()
  })

  ipcMain.handle('settings:save-api-key', (_e, provider: LlmProvider, key: string) => {
    saveApiKey(provider, key)
    return getAppSettings()
  })

  ipcMain.handle('settings:clear-api-key', (_e, provider: LlmProvider) => {
    clearApiKey(provider)
    return getAppSettings()
  })

  ipcMain.handle('settings:save-options', (_e, partial: SaveOptionsPartial) => {
    const options = saveOptions(partial)
    if (partial.contentProtection !== undefined && mainWindow && !mainWindow.isDestroyed()) {
      applyContentProtection(mainWindow, options.contentProtection)
    }
    return getAppSettings()
  })

  ipcMain.handle('session:start', () => sessionPipeline.start())
  ipcMain.handle('session:stop', () => sessionPipeline.stop())
  ipcMain.handle('session:status', () => sessionPipeline.getStatus())

  ipcMain.handle(
    'audio:chunk',
    async (
      _e,
      chunk: { seq: number; startedAt: number; wav: ArrayBuffer | Uint8Array | Buffer | number[] }
    ) => {
      let wav: Uint8Array
      if (Buffer.isBuffer(chunk.wav)) {
        wav = new Uint8Array(chunk.wav)
      } else if (chunk.wav instanceof ArrayBuffer) {
        wav = new Uint8Array(chunk.wav)
      } else if (chunk.wav instanceof Uint8Array) {
        wav = chunk.wav
      } else {
        wav = Uint8Array.from(chunk.wav)
      }
      await sessionPipeline.ingestChunk({
        seq: chunk.seq,
        startedAt: chunk.startedAt,
        wav
      })
    }
  )

  ipcMain.handle('audio:silent-drop', () => {
    sessionPipeline.noteSilentDrop()
    return sessionPipeline.getStatus()
  })

  ipcMain.handle('context:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return getAppSettings()
    }
    saveOptions({ contextFolder: result.filePaths[0] })
    reloadContext()
    return getAppSettings()
  })

  ipcMain.handle('context:reload', () => {
    return reloadContext()
  })

  ipcMain.handle('transcript:export', () => {
    const segments = sessionPipeline.getSegments()
    const docs = app.getPath('documents')
    const dir = join(docs, 'LiveCopilot')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = join(dir, `transcript-${stamp}.md`)

    const lines: string[] = [
      '# Live Copilot Transcript',
      '',
      `Exported: ${new Date().toLocaleString()}`,
      ''
    ]

    for (const s of segments) {
      lines.push(`## ${new Date(s.createdAt).toLocaleTimeString()}`)
      lines.push('')
      lines.push(`**EN:** ${s.text}`)
      if (s.translation) lines.push(`**ID:** ${s.translation}`)
      if (s.isQuestion) lines.push(`**Question:** yes`)
      if (s.answer) {
        lines.push('')
        lines.push('**Answer (default):**')
        lines.push('')
        lines.push(s.answer)
      }
      if (s.answers?.length) {
        for (const opt of s.answers) {
          lines.push('')
          lines.push(`**${opt.label}:**`)
          lines.push('')
          lines.push(opt.body)
        }
      }
      lines.push('')
    }

    writeFileSync(filePath, lines.join('\n'), 'utf-8')
    return { path: filePath }
  })

  ipcMain.handle('window:set-height', (_e, height: number) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [w] = mainWindow.getSize()
    mainWindow.setSize(w, Math.max(180, Math.round(height)))
    placeBottomCenter(mainWindow)
  })

  ipcMain.handle('window:set-expanded', (_e, expanded: boolean) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { expanded }
    const size = expanded ? EXPANDED : COMPACT
    mainWindow.setSize(size.width, size.height)
    placeBottomCenter(mainWindow)
    return { expanded, ...size }
  })

  ipcMain.handle('app:quit', () => {
    sessionPipeline.stop()
    quitApp()
  })
}

function quitApp(): void {
  if (isQuitInProgress) return
  isQuitInProgress = true
  globalShortcut.unregisterAll()
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.destroy()
  })
  app.exit(0)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.livecopilot.desktop')

  // Prefer Chrome/Edge window (more reliable than full-screen on Win11), then screen.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      })
      .then((sources) => {
        const browserWin = sources.find(
          (s) =>
            s.id.startsWith('window:') &&
            /chrome|msedge|brave|firefox|youtube/i.test(s.name)
        )
        const screenSrc =
          sources.find((s) => s.id.startsWith('screen:')) ??
          sources.find((s) => s.id.startsWith('window:'))
        const pick = browserWin ?? screenSrc
        if (!pick) {
          callback({})
          return
        }
        callback({ video: pick, audio: 'loopback' })
      })
      .catch((err) => {
        console.error('desktopCapturer.getSources failed', err)
        callback({})
      })
  })

  if (elevated) {
    console.warn(
      '[Live Copilot] Elevated (Administrator). Screen/audio capture fails on Electron 37+. Relaunch without Run as administrator.'
    )
  }

  ipcMain.handle('capture:list-screens', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    })
    return sources.map((s) => ({ id: s.id, name: s.name }))
  })

  ipcMain.handle('capture:is-elevated', () => ({ elevated }))

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()
  registerHotkeys()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      registerHotkeys()
    } else if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitApp()
  }
})
