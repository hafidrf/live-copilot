# Live Copilot

A Windows desktop overlay that listens to **system audio** (speakers, not your mic), shows **live English captions**, translates them to **Indonesian**, detects interview questions, and suggests **ready-to-speak answers** grounded in your CV or notes.

Think of it as Chrome Live Caption plus an interview copilot, useful for mock interviews, meetings, or any English audio playing on your PC.

---

## What it does

1. **Captures speaker audio** from YouTube, Zoom, Teams, or any app playing sound on your PC.
2. **Transcribes English** in near real time (Groq Whisper).
3. **Translates to Indonesian** so you can follow along quickly.
4. **Detects questions** and generates three answer styles:
   - **Instant**: 15–25 seconds, speak it now
   - **STAR**: structured Situation / Task / Action / Result
   - **Power**: longer, high-impact answer with concrete proof points
5. **Uses your context folder** (markdown files with CV, projects, screening notes) so answers match your real background.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Windows 10/11** or **macOS 13+** | Windows primary, macOS supported (see macOS notes below). |
| **Node.js 20+** | LTS recommended. |
| **Groq API key** | Required for speech-to-text. Free tier available at [console.groq.com/keys](https://console.groq.com/keys). |
| **LLM provider** | Groq (default), Gemini, DeepSeek, or local [9Router](http://127.0.0.1:20128) for translation + answers. |

---

## Quick start (clone & run)

```powershell
git clone https://github.com/hafidrf/live-copilot.git
cd live-copilot
npm install
npm run icon
npm run dev
```

When the overlay opens:

1. Click **Settings** and paste your **Groq API key** (required).
2. Optionally choose a **Context folder**: a directory with `.md` files about your experience (see below).
3. Play English audio (e.g. a YouTube mock interview) and make sure sound comes from your **speakers**.
4. Click **Listen** (or press `Ctrl+Shift+Space`).

---

## Context folder (recommended)

For strong, personalized answers, point Settings → **Context folder** at a folder of markdown files, for example:

```
my-interview-prep/
  intro-career-projects.md
  screening-prep.md
  resume-notes.md
```

The app prioritizes files whose names contain `intro`, `career`, or `screening`. Without a context folder, answers are generic and may use `[FILL]` placeholders.

---

## Build a standalone app

### Windows

```powershell
npm run setup
```

This will:

- Generate the app icon
- Build an unpacked Windows app under `dist/win-unpacked/`
- Create a Desktop shortcut to `LiveCopilot.exe`

Or build only:

```powershell
npm run build:win
# output: dist/LiveCopilot-1.0.0-setup.exe
```

### macOS

```bash
git clone https://github.com/hafidrf/live-copilot.git
cd live-copilot
npm install
npm run icon
npm run build:mac
# output: dist/live-copilot-1.0.0.dmg
```

Open the `.dmg`, drag **Live Copilot** to **Applications**, then run it. On first launch, macOS may block the app (unsigned build):

```bash
xattr -cr /Applications/Live\ Copilot.app
# or: System Settings → Privacy & Security → Open Anyway
```

**Audio on macOS:** System audio capture requires **Screen Recording** permission:

1. `System Settings → Privacy & Security → Screen Recording` → enable **Live Copilot** (restart app after).
2. Play YouTube/Zoom via speakers and click **Listen**.
3. Alternative: install [BlackHole](https://github.com/ExistentialAudio/BlackHole) (free virtual audio driver) and select it as input; the app auto-detects `BlackHole` devices.

> Note: macOS builds are currently **unsigned** (`notarize: false`). For distribution, add Apple code signing + notarization in `electron-builder.yml`.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+Space` | Start / stop listening |
| `Ctrl+Shift+H` | Hide / show overlay |
| `Ctrl+Shift+E` | Expand / compact window |
| `Ctrl+Shift+Enter` | Force answer on last sentence |
| `Ctrl+Shift+Up` / `Down` | Caption font size |

---

## Settings & API keys

Keys are stored locally in:

```
%APPDATA%\live-copilot\settings.json
```

They never leave your machine except when calling the provider APIs you configure.

| Provider | Used for | Get a key |
| --- | --- | --- |
| **Groq** | STT + LLM | [console.groq.com/keys](https://console.groq.com/keys) |
| **Gemini** | LLM only | [aistudio.google.com](https://aistudio.google.com) |
| **DeepSeek** | LLM only | [platform.deepseek.com](https://platform.deepseek.com) |
| **9Router** | LLM only | [9Router dashboard](http://127.0.0.1:20128/dashboard) |

You can also set keys via environment variables at build/dev time (see `.env.example` if present). **Never commit API keys.**

---

## Troubleshooting

### “Could not start video source” / capture fails

**Windows, most common cause:** the app (or Cursor/terminal) is running **as Administrator**. Windows blocks screen/audio capture for elevated processes on Electron 37+.

**Fix (Windows):**

1. Close Cursor / terminal completely.
2. Reopen **without** “Run as administrator”.
3. Run `npm run dev` again and click Listen.

Other checks (Windows):

- Close other capture apps (OBS, ShareX) that may lock the audio device.
- Make sure YouTube or your meeting is **audible on speakers** (not muted).
- Allow **Screen capture** if Windows prompts for permission.
- Optional fallback: enable **Stereo Mix** or a virtual cable (VB-Audio) in Windows Sound settings and select it as a loopback input.

**macOS:**

- Enable `System Settings → Privacy & Security → Screen Recording` for **Live Copilot**, then restart the app.
- If still failing, install [BlackHole](https://github.com/ExistentialAudio/BlackHole) and select it as audio input.
- Make sure audio is playing via speakers (not muted).

### No personalized answers / status shows `no context`

Set **Context folder** in Settings to a folder with your interview prep markdown files.

### Content protection (hide from screen share)

Off by default. Enable in Settings if you want the overlay hidden during screen sharing (Windows 10 2004+).

---

## How it works (high level)

```
System audio (loopback)
    → 6s WAV chunks (AudioWorklet)
    → Groq whisper-large-v3-turbo (STT)
    → Sentence assembly + dedupe
    → LLM translate (EN → ID)
    → Question detection
    → LLM answer (Instant / STAR / Power) using context folder
```

Capture uses Electron’s display-media handler with Windows WASAPI loopback. The overlay is a frameless, always-on-top window.

---

## Development scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Hot-reload development |
| `npm run build` | Typecheck + production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |

### QC (accuracy self-test)

```powershell
# Clean-speech accuracy gate (TTS → same pipeline as the app)
node scripts/qc-youtube-compare.mjs

# Compare a live Listen session against YouTube captions
node scripts/qc-compare-debug.mjs
```

STT debug log (after a session): `%APPDATA%\live-copilot\debug-stt.jsonl`

---

## Tech stack

- **Electron 39** + **React 19** + **TypeScript** (electron-vite)
- **STT:** Groq `whisper-large-v3-turbo` (6s chunks, 1s overlap)
- **LLM:** Groq / Gemini / DeepSeek / 9Router (OpenAI-compatible)

---

## Privacy & ethics

This tool is intended for **personal interview preparation** and accessibility (live captions). Use responsibly:

- Respect company policies and local laws regarding recording or assistance in live interviews or exams.
- API providers process audio/text you send them; review their terms before use.

---

## License

MIT; see [LICENSE](LICENSE) if present, or use at your own discretion for this personal project.

---

## Related

Similar desktop tooling from the same author: [paraphrase-desktop](https://github.com/hafidrf/paraphrase-desktop) (translate + paraphrase overlay).
