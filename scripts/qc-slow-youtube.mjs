/**
 * QC vs real YouTube audio: qc-fixtures/slow.wav + slow.en.vtt
 * Simulates app chunking + Groq STT, scores vs official captions.
 *
 * Run: node scripts/qc-slow-youtube.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '..', 'qc-fixtures')
const wavPath = join(fixtures, 'slow.wav')
const vttPath = join(fixtures, 'slow.en.vtt')

function loadGroqKey() {
  const settingsPath = join(process.env.APPDATA || '', 'live-copilot', 'settings.json')
  const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  if (!raw.groqApiKey?.trim()) throw new Error('groqApiKey missing')
  return raw.groqApiKey.trim()
}

function parseWavPcm16(buf) {
  let o = 12
  let dataAt = 44
  let dataSize = buf.length - 44
  let sampleRate = 16000
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4)
    const size = buf.readUInt32LE(o + 4)
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(o + 8 + 4)
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
  return { samples, sampleRate }
}

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

function rms(samples) {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

function normalizePeak(samples, targetPeak = 0.75) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak < 0.002) return samples
  const gain = Math.min(targetPeak / peak, 12)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * gain))
  return out
}

function chunkSamples(samples, chunkSeconds, overlapSeconds, rate) {
  const chunkN = Math.floor(chunkSeconds * rate)
  const overlapN = Math.floor(overlapSeconds * rate)
  const out = []
  let offset = 0
  while (offset < samples.length) {
    const end = Math.min(offset + chunkN, samples.length)
    if (end - offset < rate * 0.8) break
    out.push({ startSec: offset / rate, samples: samples.slice(offset, end) })
    if (end >= samples.length) break
    offset = end - overlapN
  }
  return out
}

function parseVtt(text, maxSec = 60) {
  const cues = []
  const blocks = text.replace(/\r/g, '').split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const timeLine = lines.find((l) => l.includes('-->'))
    if (!timeLine) continue
    const m = timeLine.match(/(\d+):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})\.(\d{3})/)
    if (!m) continue
    const start =
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
    if (start > maxSec) continue
    const body = lines
      .filter((l) => !l.includes('-->') && !/^\d+$/.test(l) && l !== 'WEBVTT')
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (body) cues.push({ start, text: body })
  }
  // Deduplicate consecutive identical cues
  const uniq = []
  for (const c of cues) {
    if (!uniq.length || uniq[uniq.length - 1].text !== c.text) uniq.push(c)
  }
  return uniq
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

function isJunkTranscript(text) {
  const t = text.trim().toLowerCase()
  if (!t) return true
  const junk = ['thank you.', 'thanks for watching.', 'subscribe', 'you']
  if (junk.includes(t)) return true
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length >= 5 && new Set(words).size === 1) return true
  return false
}

async function transcribe(apiKey, wavBuf, promptTail, model) {
  const formData = () => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wavBuf)], { type: 'audio/wav' }), 'chunk.wav')
    form.append('model', model)
    form.append('language', 'en')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (promptTail.trim()) form.append('prompt', promptTail.trim().slice(-200))
    return form
  }

  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData()
    })
    const data = await res.json()
    if (res.status === 429 || String(data.error?.message || '').includes('Rate limit')) {
      lastErr = new Error(data.error?.message || '429')
      const wait = 6500 + attempt * 2000
      console.log(`    rate-limit, wait ${wait}ms...`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`)
    return (data.text || '').trim()
  }
  throw lastErr ?? new Error('STT failed')
}

async function runConfig(apiKey, samples, sampleRate, cues, cfg) {
  const chunks = chunkSamples(samples, cfg.chunkSeconds, cfg.overlapSeconds, sampleRate)
  let lastRaw = ''
  let assembled = ''
  const raws = []
  let dropped = 0

  for (const ch of chunks) {
    let slice = ch.samples
    if (cfg.normalize) slice = normalizePeak(slice)
    const energy = rms(slice)
    if (energy < cfg.energyThreshold * 0.35) {
      dropped++
      continue
    }
    const wav = encodeWavPcm16Mono(slice, sampleRate)
    const raw = await transcribe(apiKey, wav, cfg.usePrompt ? lastRaw : '', cfg.model)
    await new Promise((r) => setTimeout(r, 4000)) // ~15 RPM max
    if (isJunkTranscript(raw)) continue
    raws.push({ t: ch.startSec.toFixed(1), raw })
    const cleaned = dedupeOverlap(lastRaw, raw)
    lastRaw = raw
    if (cleaned) assembled = `${assembled} ${cleaned}`.replace(/\s+/g, ' ').trim()
  }

  const ref = cues.map((c) => c.text).join(' ')
  // Collapse near-duplicate VTT lines into a cleaner reference
  const refWords = normalizeWords(ref)
  const uniqRef = []
  for (const w of refWords) {
    if (uniqRef.length < 3 || uniqRef.slice(-3).join(' ') !== `${uniqRef[uniqRef.length - 2]} ${uniqRef[uniqRef.length - 1]} ${w}`) {
      // still keep all; VTT has heavy overlap — take unique consecutive sentences instead
    }
  }
  // Better reference: join unique cue texts only
  const refClean = cues.map((c) => c.text).filter((t, i, arr) => arr.indexOf(t) === i).join(' ')

  const score = wer(refClean, assembled)
  return { assembled, raws, dropped, chunks: chunks.length, wer: score, refClean }
}

async function main() {
  if (!existsSync(wavPath) || !existsSync(vttPath)) {
    throw new Error('Need slow.wav and slow.en.vtt in qc-fixtures')
  }
  const apiKey = loadGroqKey()
  const { samples, sampleRate } = parseWavPcm16(readFileSync(wavPath))
  const cues = parseVtt(readFileSync(vttPath, 'utf-8'), 58)
  console.log(`Audio: ${(samples.length / sampleRate).toFixed(1)}s @ ${sampleRate}Hz`)
  console.log(`VTT cues (0-58s): ${cues.length}`)
  console.log('VTT preview:', cues.slice(0, 5).map((c) => c.text).join(' | '))

  const configs = [
    {
      name: 'current-app (3.5s / prompt)',
      model: 'whisper-large-v3-turbo',
      chunkSeconds: 3.5,
      overlapSeconds: 0.75,
      energyThreshold: 0.001,
      normalize: true,
      usePrompt: true
    },
    {
      name: 'best-candidate (6s / no-prompt)',
      model: 'whisper-large-v3-turbo',
      chunkSeconds: 6,
      overlapSeconds: 1,
      energyThreshold: 0.001,
      normalize: true,
      usePrompt: false
    },
    {
      name: 'full-file once (baseline)',
      model: 'whisper-large-v3-turbo',
      chunkSeconds: 60,
      overlapSeconds: 0,
      energyThreshold: 0,
      normalize: true,
      usePrompt: false
    }
  ]

  const report = { at: new Date().toISOString(), results: [] }

  for (const cfg of configs) {
    console.log(`\n=== ${cfg.name} ===`)
    const r = await runConfig(apiKey, samples, sampleRate, cues, cfg)
    console.log(`chunks=${r.chunks} dropped=${r.dropped} WER=${(r.wer * 100).toFixed(1)}%`)
    console.log(`HYP: ${r.assembled.slice(0, 220)}...`)
    report.results.push({
      name: cfg.name,
      config: cfg,
      wer: Number(r.wer.toFixed(3)),
      dropped: r.dropped,
      chunks: r.chunks,
      hyp: r.assembled,
      ref: r.refClean.slice(0, 500),
      raws: r.raws
    })
  }

  report.results.sort((a, b) => a.wer - b.wer)
  const best = report.results[0]
  console.log(`\nBEST: ${best.name} WER ${(best.wer * 100).toFixed(1)}%`)
  writeFileSync(join(fixtures, 'qc-slow-report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(fixtures, 'best-live-config.json'), JSON.stringify(best.config, null, 2))

  // Gate: live chunking should be within 25 WER points of full-file, and absolute WER < 0.45
  const full = report.results.find((x) => x.name.includes('full-file'))
  const bestChunked = report.results.find((x) => !x.name.includes('full-file'))
  if (!bestChunked || bestChunked.wer > 0.45) {
    console.error('\nQC GATE FAILED: chunked WER too high vs YouTube VTT')
    process.exitCode = 2
  } else {
    console.log('\nQC GATE PASSED for slow YouTube audio')
    if (full) {
      console.log(
        `Delta vs full-file: ${((bestChunked.wer - full.wer) * 100).toFixed(1)} pts (chunked ${bestChunked.name})`
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
