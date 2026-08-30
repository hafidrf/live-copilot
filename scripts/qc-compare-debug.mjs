/**
 * After a live session: compare %APPDATA%/live-copilot/debug-stt.jsonl
 * against YouTube caption samples captured in qc-fixtures/yt-captions.json
 *
 * 1. Play YouTube + Listen in Live Copilot for ~30s
 * 2. Save YT captions samples to qc-fixtures/yt-captions.json (array of {t, caps})
 * 3. node scripts/qc-compare-debug.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtures = join(__dirname, '..', 'qc-fixtures')
const debugPath = join(process.env.APPDATA || '', 'live-copilot', 'debug-stt.jsonl')
const ytPath = join(fixtures, 'yt-captions.json')

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function overlapScore(a, b) {
  const A = new Set(normalize(a))
  const B = new Set(normalize(b))
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.max(A.size, B.size)
}

function loadDebugRaws() {
  if (!existsSync(debugPath)) throw new Error(`No debug log yet: ${debugPath}`)
  const lines = readFileSync(debugPath, 'utf-8').split(/\n/).filter(Boolean)
  const raws = []
  for (const line of lines) {
    if (line.startsWith('---')) continue
    try {
      const j = JSON.parse(line)
      if (j.raw && !j.junk) raws.push(j.raw)
    } catch {
      // skip
    }
  }
  return raws
}

function main() {
  const raws = loadDebugRaws()
  console.log(`STT raw chunks logged: ${raws.length}`)
  console.log('Latest 5:')
  for (const r of raws.slice(-5)) console.log('  •', r)

  if (!existsSync(ytPath)) {
    console.log(`\nNo ${ytPath} yet — paste YouTube caption samples there to score overlap.`)
    console.log('Example: [{"t":"0:42","caps":"Can you tell me how you heard about this position?"}]')
    writeFileSync(
      join(fixtures, 'stt-latest.txt'),
      raws.slice(-10).join('\n'),
      'utf-8'
    )
    return
  }

  const samples = JSON.parse(readFileSync(ytPath, 'utf-8'))
  const joinedStt = raws.slice(-12).join(' ')
  console.log('\nOverlap vs each YT caption sample:')
  let best = 0
  for (const s of samples) {
    const score = Math.max(
      overlapScore(s.caps, joinedStt),
      ...raws.slice(-6).map((r) => overlapScore(s.caps, r))
    )
    best = Math.max(best, score)
    console.log(`  [${s.t}] ${(score * 100).toFixed(0)}% — ${s.caps}`)
  }
  console.log(`\nBest overlap: ${(best * 100).toFixed(0)}%`)
  if (best < 0.35) {
    console.error('QC LIVE GATE: caption overlap too low vs YouTube')
    process.exitCode = 2
  } else {
    console.log('QC LIVE GATE: OK')
  }
}

main()
