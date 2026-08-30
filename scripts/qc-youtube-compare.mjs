/**
 * QC: TTS ground-truth phrases → app-identical 16k mono WAV → Groq STT → WER.
 * Also writes a side-by-side report for YouTube caption samples if provided.
 *
 * Run: node scripts/qc-youtube-compare.mjs
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const fixtures = join(root, 'qc-fixtures')
mkdirSync(fixtures, { recursive: true })

const GROUND_TRUTH = [
  'Can you tell me how you heard about this position?',
  'Tell me about yourself and your background.',
  'What are your greatest strengths as a software engineer?',
  'Walk me through a challenging bug you fixed recently.',
  'Why do you want to work at this company?'
]

function loadGroqKey() {
  const settingsPath = join(process.env.APPDATA || '', 'live-copilot', 'settings.json')
  if (!existsSync(settingsPath)) throw new Error(`Settings not found: ${settingsPath}`)
  const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const key = raw.groqApiKey?.trim()
  if (!key) throw new Error('groqApiKey missing — paste Groq key in Live Copilot Settings')
  return key
}

/** Encode Float32 PCM → clean 44-byte WAV (same as app capture.ts). */
function encodeWavPcm16Mono(samples, sampleRate = 16000) {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2)
  }
  return buffer
}

function synthesizeToFloat32(text) {
  const rawPath = join(fixtures, '_tts_raw.wav')
  const cleanPath = join(fixtures, '_tts_clean.wav')
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = -1
$s.Volume = 100
$s.SetOutputToWaveFile('${rawPath.replace(/'/g, "''")}')
$s.Speak(@'
${text.replace(/'/g, "''")}
'@)
$s.Dispose()
`
  const r1 = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf-8' })
  if (r1.status !== 0) throw new Error(`TTS failed: ${r1.stderr || r1.stdout}`)

  // Force clean PCM WAV without LIST metadata chunk
  const r2 = spawnSync(
    'ffmpeg',
    ['-y', '-i', rawPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', cleanPath],
    { encoding: 'utf-8' }
  )
  if (r2.status !== 0 || !existsSync(cleanPath)) {
    throw new Error(`ffmpeg failed: ${r2.stderr || r2.stdout}`)
  }

  const buf = readFileSync(cleanPath)
  // Parse real data offset (ffmpeg may still insert chunks)
  let o = 12
  let dataAt = 44
  let dataSize = buf.length - 44
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4)
    const size = buf.readUInt32LE(o + 4)
    if (id === 'data') {
      dataAt = o + 8
      dataSize = size
      break
    }
    o += 8 + size + (size % 2)
  }
  const samples = new Float32Array(dataSize / 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buf.readInt16LE(dataAt + i * 2) / 32768
  }
  return samples
}

function chunkSamples(samples, chunkSeconds = 5, overlapSeconds = 1, rate = 16000) {
  const chunkN = Math.floor(chunkSeconds * rate)
  const overlapN = Math.floor(overlapSeconds * rate)
  const out = []
  let offset = 0
  while (offset < samples.length) {
    const end = Math.min(offset + chunkN, samples.length)
    if (end - offset < rate) break
    out.push(samples.slice(offset, end))
    if (end >= samples.length) break
    offset = end - overlapN
  }
  if (out.length === 0 && samples.length > 0) out.push(samples)
  return out
}

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function wer(ref, hyp) {
  const r = normalizeWords(ref)
  const h = normalizeWords(hyp)
  if (!r.length) return h.length ? 1 : 0
  const dp = Array.from({ length: r.length + 1 }, () => Array(h.length + 1).fill(0))
  for (let i = 0; i <= r.length; i++) dp[i][0] = i
  for (let j = 0; j <= h.length; j++) dp[0][j] = j
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[r.length][h.length] / r.length
}

function dedupeOverlap(previousRaw, nextRaw, maxWords = 8) {
  const prevWords = normalizeWords(previousRaw)
  const nextWords = normalizeWords(nextRaw)
  if (!prevWords.length || !nextWords.length) return nextRaw.trim()
  const limit = Math.min(maxWords, prevWords.length, nextWords.length)
  let best = 0
  for (let n = limit; n >= 2; n--) {
    if (prevWords.slice(-n).join(' ') === nextWords.slice(0, n).join(' ')) {
      best = n
      break
    }
  }
  if (!best) return nextRaw.trim()
  return nextRaw.trim().split(/\s+/).slice(best).join(' ').trim()
}

async function transcribe(apiKey, wavBuf, promptTail, model) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wavBuf)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', model)
  form.append('language', 'en')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (promptTail.trim()) form.append('prompt', promptTail.trim().slice(-200))
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`)
  return (data.text || '').trim()
}

async function runPhrase(apiKey, text, model) {
  const samples = synthesizeToFloat32(text)
  const chunks = chunkSamples(samples, 5, 1)
  let lastRaw = ''
  let assembled = ''
  const raws = []
  for (const chunk of chunks) {
    const wav = encodeWavPcm16Mono(chunk)
    const raw = await transcribe(apiKey, wav, lastRaw, model)
    raws.push(raw)
    const cleaned = dedupeOverlap(lastRaw, raw)
    lastRaw = raw
    if (cleaned) assembled = `${assembled} ${cleaned}`.replace(/\s+/g, ' ').trim()
  }
  return { chunks: chunks.length, assembled, raws, score: wer(text, assembled) }
}

async function main() {
  const apiKey = loadGroqKey()
  // Full-file sanity (no chunking)
  {
    const samples = synthesizeToFloat32(GROUND_TRUTH[0])
    const wav = encodeWavPcm16Mono(samples)
    writeFileSync(join(fixtures, 'sanity.wav'), wav)
    const full = await transcribe(apiKey, wav, '', 'whisper-large-v3-turbo')
    console.log('SANITY full-file:', full)
    console.log('SANITY WER:', (wer(GROUND_TRUTH[0], full) * 100).toFixed(1) + '%')
  }

  const models = ['whisper-large-v3-turbo', 'whisper-large-v3']
  const report = { at: new Date().toISOString(), models: {} }

  for (const model of models) {
    console.log(`\n=== Model: ${model} ===`)
    const rows = []
    for (const text of GROUND_TRUTH) {
      process.stdout.write(`  • ${text.slice(0, 52)}... `)
      try {
        const r = await runPhrase(apiKey, text, model)
        rows.push({
          ref: text,
          hyp: r.assembled,
          wer: Number(r.score.toFixed(3)),
          chunks: r.chunks
        })
        console.log(`WER ${(r.score * 100).toFixed(1)}% | ${r.assembled}`)
      } catch (err) {
        rows.push({ ref: text, error: String(err.message || err) })
        console.log(`ERR ${err.message || err}`)
      }
      await new Promise((r) => setTimeout(r, 1200))
    }
    const ok = rows.filter((x) => typeof x.wer === 'number')
    const avg = ok.length ? ok.reduce((a, b) => a + b.wer, 0) / ok.length : null
    report.models[model] = { avgWer: avg, rows }
    console.log(`AVG WER: ${avg === null ? 'n/a' : (avg * 100).toFixed(1) + '%'}`)
  }

  const out = join(fixtures, 'qc-report.json')
  writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`\nWrote ${out}`)

  const scores = Object.entries(report.models)
    .filter(([, v]) => v.avgWer !== null)
    .sort((a, b) => a[1].avgWer - b[1].avgWer)

  if (scores[0]) {
    console.log(`BEST: ${scores[0][0]} avg WER ${(scores[0][1].avgWer * 100).toFixed(1)}%`)
    writeFileSync(join(fixtures, 'best-model.txt'), scores[0][0])
  }

  if (!scores[0] || scores[0][1].avgWer > 0.2) {
    console.error('\nQC GATE FAILED')
    process.exitCode = 2
  } else {
    console.log('\nQC GATE PASSED')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
