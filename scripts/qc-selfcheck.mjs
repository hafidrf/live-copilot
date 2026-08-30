/**
 * Quick self-check for WAV encode + overlap dedupe (no Electron required).
 * Run: node --experimental-strip-types scripts/qc-selfcheck.mts
 * Or after build helpers — uses inline copies of pure functions.
 */

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function dedupeOverlap(previous, next, maxWords = 12) {
  const prevWords = normalizeWords(previous)
  const nextWords = normalizeWords(next)
  if (prevWords.length === 0 || nextWords.length === 0) return next.trim()

  const limit = Math.min(maxWords, prevWords.length, nextWords.length)
  let best = 0
  for (let n = limit; n >= 1; n--) {
    const suffix = prevWords.slice(-n).join(' ')
    const prefix = nextWords.slice(0, n).join(' ')
    if (suffix === prefix) {
      best = n
      break
    }
  }
  if (best === 0) return next.trim()
  return next.trim().split(/\s+/).slice(best).join(' ').trim()
}

function encodeWavPcm16Mono(samples, sampleRate = 16000) {
  const numSamples = samples.length
  const dataSize = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Uint8Array(buffer)
}

let failed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    failed++
  } else {
    console.log('OK:', msg)
  }
}

const deduped = dedupeOverlap(
  'I worked on Flutter delivery for years',
  'Flutter delivery for years and scaled the app'
)
assert(deduped === 'and scaled the app', `dedupe got "${deduped}"`)

const samples = new Float32Array(16000)
for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.2
const wav = encodeWavPcm16Mono(samples)
assert(wav.byteLength === 44 + 16000 * 2, `wav size ${wav.byteLength}`)
assert(String.fromCharCode(...wav.slice(0, 4)) === 'RIFF', 'RIFF header')
assert(String.fromCharCode(...wav.slice(8, 12)) === 'WAVE', 'WAVE header')
const rate = new DataView(wav.buffer).getUint32(24, true)
assert(rate === 16000, `sample rate ${rate}`)

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll QC self-checks passed')
