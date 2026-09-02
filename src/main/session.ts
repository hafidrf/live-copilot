import { randomUUID } from 'crypto'
import type { BrowserWindow } from 'electron'
import { generateAnswerOptions } from './answerer'
import { loadContext } from './context'
import { clearSttDebug, logSttDebug } from './debug-log'
import { transcribeWav } from './groq-stt'
import { looksLikeQuestion } from './question'
import { enqueueTranslation } from './translator'
import type { AudioChunk, SessionStatus, TranscriptSegment } from '../shared/types'

const MAX_IN_FLIGHT = 2
const FLUSH_IDLE_MS = 1200
const COST_PER_HOUR = 0.04 // whisper-large-v3-turbo

/** Drop obvious Whisper hallucinations / junk. */
export function isJunkTranscript(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  // HR question whitelist — never filter questions
  if (t.endsWith('?')) return false
  if (looksLikeQuestion(t)) return false
  const lower = t.toLowerCase()
  // Very common Whisper garbage on silence / music
  const junkExact = [
    'thank you.',
    'thanks for watching.',
    'subscribe',
    'please subscribe',
    'mbc news',
    'www.youtube.com',
    'you'
  ]
  if (junkExact.includes(lower)) return true
  if (/^(.)\1{6,}$/i.test(t.replace(/\s/g, ''))) return true
  // Repeated same word 5+ times
  const words = lower.split(/\s+/).filter(Boolean)
  if (words.length >= 5 && new Set(words).size === 1) return true
  return false
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Remove overlap between consecutive raw chunk transcripts only. */
export function dedupeOverlap(previousRaw: string, nextRaw: string, maxWords = 4): string {
  const prevWords = normalizeWords(previousRaw)
  const nextWords = normalizeWords(nextRaw)
  if (prevWords.length === 0 || nextWords.length === 0) return nextRaw.trim()

  const limit = Math.min(maxWords, prevWords.length, nextWords.length)
  let best = 0
  for (let n = limit; n >= 2; n--) {
    const suffix = prevWords.slice(-n).join(' ')
    const prefix = nextWords.slice(0, n).join(' ')
    if (suffix === prefix) {
      best = n
      break
    }
  }

  if (best === 0) return nextRaw.trim()
  // Guard: don't dedupe short next chunks where overlap would delete >50% (likely question)
  if (nextWords.length <= 6 && best / nextWords.length > 0.5) return nextRaw.trim()
  return nextRaw.trim().split(/\s+/).slice(best).join(' ').trim()
}

function splitSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = []
  let lastIndex = 0
  const re = /([.?!]+)(?:\s+|$)/g
  let match: RegExpExecArray | null

  while ((match = re.exec(buffer)) !== null) {
    const end = match.index + match[1].length
    const sentence = buffer.slice(lastIndex, end).trim()
    if (sentence) complete.push(sentence)
    lastIndex = re.lastIndex
  }

  let rest = buffer.slice(lastIndex).trimStart()
  // Fallback for Whisper missing punctuation: if no complete sentence but buffer is long, split on clause boundary
  if (complete.length === 0 && rest.split(/\s+/).filter(Boolean).length > 32) {
    const clauseRe = /\s+(and|but|so|then|which|that|because|when|where)\s+/gi
    let bestIdx = -1
    let bestDist = Infinity
    const mid = rest.length / 2
    let m: RegExpExecArray | null
    while ((m = clauseRe.exec(rest)) !== null) {
      const dist = Math.abs(m.index - mid)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = m.index
      }
    }
    if (bestIdx > 0) {
      const firstPart = rest.slice(0, bestIdx).trim()
      const secondPart = rest.slice(bestIdx).trimStart()
      if (firstPart.split(/\s+/).filter(Boolean).length >= 8) {
        complete.push(firstPart)
        rest = secondPart
      }
    }
  }

  return { complete, rest }
}

function shouldMerge(a: string, b: string): boolean {
  const aTrim = a.trim()
  const bTrim = b.trim()
  if (!aTrim || !bTrim) return false
  const combined = `${aTrim} ${bTrim}`.trim()
  const aWords = aTrim.split(/\s+/).filter(Boolean).length
  const bWords = bTrim.split(/\s+/).filter(Boolean).length
  // Don't merge if a is already a complete question
  if (/[?]$/.test(aTrim) && looksLikeQuestion(aTrim)) return false
  // If combined looks like question and a is short fragment without terminal punctuation
  if (looksLikeQuestion(combined) && aWords < 12) return true
  if (looksLikeQuestion(bTrim) && aWords < 10 && !/[.?!]$/.test(aTrim)) return true
  if (aWords + bWords < 18 && looksLikeQuestion(combined)) return true
  // Short fragments without punctuation likely belong together
  if (aWords <= 12 && !/[.?!]$/.test(aTrim) && looksLikeQuestion(combined)) return true
  return false
}

export class SessionPipeline {
  private win: BrowserWindow | null = null
  private listening = false
  private droppedSilentChunks = 0
  private inFlight = 0
  private sttRequests = 0
  private pending = new Map<number, string>()
  private nextEmitSeq = 0
  private assembled = ''
  private lastRawChunk = ''
  private sentenceBuffer = ''
  private segments: TranscriptSegment[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastError: string | null = null
  private llmError: string | null = null
  private answering = false
  /** Rolling raw chunk texts for live caption (YouTube-like freshness). */
  private recentRaws: string[] = []
  private lastChunkTime: number | null = null

  attach(win: BrowserWindow): void {
    this.win = win
  }

  getSegments(): TranscriptSegment[] {
    return this.segments
  }

  getStatus(): SessionStatus {
    return {
      listening: this.listening,
      error: this.lastError,
      llmError: this.llmError,
      droppedSilentChunks: this.droppedSilentChunks,
      inFlightRequests: this.inFlight,
      sttRequests: this.sttRequests,
      estimatedCostUsd: (this.sttRequests * 10) / 3600 * COST_PER_HOUR
    }
  }

  private broadcastStatus(): void {
    this.send('session:status', this.getStatus())
  }

  private send(channel: string, payload: unknown): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }

  private broadcastLiveCaption(): void {
    // Live line = latest raw chunk(s) only — matches YouTube caption freshness.
    // Do NOT prepend old assembled history (that made captions look "stuck" on past lines).
    const live = this.recentRaws.slice(-2).join(' ').replace(/\s+/g, ' ').trim()
    const partial = this.sentenceBuffer.trim()
    const display = (live || partial).slice(-280)
    this.send('live:caption', { text: display })
  }

  private upsertSegment(segment: TranscriptSegment): void {
    const idx = this.segments.findIndex((s) => s.id === segment.id)
    if (idx >= 0) {
      this.segments[idx] = { ...this.segments[idx], ...segment }
      this.send('stt:segment', this.segments[idx])
    } else {
      this.segments.push(segment)
      this.send('stt:segment', segment)
    }
  }

  start(): SessionStatus {
    this.listening = true
    this.droppedSilentChunks = 0
    this.inFlight = 0
    this.sttRequests = 0
    this.pending.clear()
    this.nextEmitSeq = 0
    this.assembled = ''
    this.lastRawChunk = ''
    this.recentRaws = []
    this.lastChunkTime = null
    this.sentenceBuffer = ''
    this.segments = []
    this.lastError = null
    this.llmError = null
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    clearSttDebug()
    loadContext(true)
    this.broadcastLiveCaption()
    this.broadcastStatus()
    return this.getStatus()
  }

  stop(): SessionStatus {
    this.listening = false
    this.flushIdle(true)
    this.broadcastStatus()
    return this.getStatus()
  }

  noteSilentDrop(): void {
    this.droppedSilentChunks += 1
    this.broadcastStatus()
  }

  async ingestChunk(chunk: AudioChunk): Promise<void> {
    if (!this.listening) return

    while (this.inFlight >= MAX_IN_FLIGHT) {
      await new Promise((r) => setTimeout(r, 40))
      if (!this.listening) return
    }

    this.inFlight += 1
    this.broadcastStatus()

    try {
      const text = await transcribeWav(chunk.wav, this.lastRawChunk)
      this.sttRequests += 1
      this.lastError = null
      logSttDebug({ seq: chunk.seq, raw: text, bytes: chunk.wav.byteLength })
      this.pending.set(chunk.seq, text)
      this.drainPending()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      logSttDebug({ seq: chunk.seq, error: this.lastError })
      this.pending.set(chunk.seq, '')
      this.drainPending()
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.broadcastStatus()
    }
  }

  private drainPending(): void {
    while (this.pending.has(this.nextEmitSeq)) {
      const raw = this.pending.get(this.nextEmitSeq) ?? ''
      this.pending.delete(this.nextEmitSeq)
      this.nextEmitSeq += 1

      if (raw.trim()) {
        if (isJunkTranscript(raw)) {
          logSttDebug({ seq: this.nextEmitSeq - 1, junk: true, raw })
        } else {
          const now = Date.now()
          const timeGap = this.lastChunkTime !== null ? now - this.lastChunkTime : 0
          this.lastChunkTime = now

          let cleaned: string
          if (timeGap > 4000) {
            // Long pause (HR 1.2s+) — likely new utterance, skip dedupe to avoid deleting question
            cleaned = raw.trim()
          } else {
            cleaned = dedupeOverlap(this.lastRawChunk, raw)
          }
          this.lastRawChunk = raw.trim()
          this.recentRaws.push(raw.trim())
          if (this.recentRaws.length > 4) this.recentRaws.shift()

          if (cleaned) {
            this.assembled = `${this.assembled} ${cleaned}`.replace(/\s+/g, ' ').trim()
            this.sentenceBuffer = `${this.sentenceBuffer} ${cleaned}`.replace(/\s+/g, ' ').trim()

            const { complete, rest } = splitSentences(this.sentenceBuffer)
            // Question-aware merging: re-join fragments that belong to same question
            let merged: string[] = []
            for (const s of complete) {
              if (merged.length > 0 && shouldMerge(merged[merged.length - 1], s)) {
                merged[merged.length - 1] = `${merged[merged.length - 1]} ${s}`.replace(/\s+/g, ' ').trim()
              } else {
                merged.push(s)
              }
            }
            // Also check if rest should be merged back to last complete (avoid splitting question)
            if (merged.length > 0 && rest && shouldMerge(merged[merged.length - 1], rest)) {
              this.sentenceBuffer = `${merged.pop()} ${rest}`.replace(/\s+/g, ' ').trim()
            } else {
              this.sentenceBuffer = rest
            }
            for (const sentence of merged) {
              void this.emitSentence(sentence)
            }
            this.scheduleFlush()
          }
        }
      }

      this.broadcastLiveCaption()
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flushIdle(false), FLUSH_IDLE_MS)
  }

  private flushIdle(force: boolean): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const leftover = this.sentenceBuffer.trim()
    if (!leftover) return
    if (!force && leftover.split(/\s+/).filter(Boolean).length < 5) return
    if (!force && /^(can you|tell me|what|how|why|describe|explain)/i.test(leftover.trim()) && !/[.?!]$/.test(leftover.trim())) {
      this.scheduleFlush()
      return
    }
    this.sentenceBuffer = ''
    void this.emitSentence(leftover)
    this.broadcastLiveCaption()
  }

  private async emitSentence(text: string): Promise<void> {
    const segment: TranscriptSegment = {
      id: randomUUID(),
      seq: this.segments.length,
      text,
      isQuestion: looksLikeQuestion(text),
      createdAt: Date.now()
    }
    this.upsertSegment(segment)

    void enqueueTranslation(text)
      .then((translation) => {
        this.llmError = null
        this.upsertSegment({ ...segment, translation })
        this.broadcastStatus()
      })
      .catch((err) => {
        this.llmError = err instanceof Error ? err.message : String(err)
        this.broadcastStatus()
      })

    if (segment.isQuestion) {
      void this.answerSegment(segment.id)
    }
  }

  async answerLast(): Promise<void> {
    const last = [...this.segments].reverse().find((s) => s.text.trim())
    if (!last) return
    const updated = { ...last, isQuestion: true }
    this.upsertSegment(updated)
    await this.answerSegment(updated.id)
  }

  private async answerSegment(id: string): Promise<void> {
    if (this.answering) return
    const target = this.segments.find((s) => s.id === id)
    if (!target) return

    this.answering = true
    try {
      const recent = this.segments.slice(-6).map((s) => s.text)
      const answers = await generateAnswerOptions(target.text, recent)
      this.llmError = null
      const current = this.segments.find((s) => s.id === id)
      if (current) {
        this.upsertSegment({
          ...current,
          answers,
          answer: answers[0]?.body,
          isQuestion: true
        })
      }
    } catch (err) {
      this.llmError = err instanceof Error ? err.message : String(err)
    } finally {
      this.answering = false
      this.broadcastStatus()
    }
  }
}

export const sessionPipeline = new SessionPipeline()
