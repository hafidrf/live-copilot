import { chat } from './llm'
import { getCachedContext } from './context'
import type { AnswerOption } from '../shared/types'

function buildSystem(context: string, hasContext: boolean): string {
  return `You are an elite interview copilot for a senior mobile / Flutter engineer in a LIVE interview.
Your job: give the candidate answers they can speak aloud immediately — concrete, confident, specific.

${
  hasContext
    ? `CONTEXT is loaded. You MUST ground every answer in CONTEXT facts (companies, projects, years, tech).
NEVER invent employers, metrics, or project names that are not in CONTEXT.
NEVER use [FILL] placeholders when CONTEXT has usable facts.
Prefer DeliveryDart, Orderific, The Gym Pod, EdgeProp, AutomatedPros, Flutter, React Native, offline-first, logistics when relevant.`
    : `No CONTEXT folder loaded. Write strong generic senior-mobile answers using plausible structure, but mark any personal specifics as [FILL name] sparingly (max 2).`
}

Return ONLY valid JSON (no markdown fences) with this shape:
{
  "instant": "15-25 second spoken answer. 2-4 short sentences. Ready to say out loud now.",
  "star": "40-60 second STAR answer: Situation → Task → Action → Result. Use real CONTEXT projects when available.",
  "power": "60-90 second high-impact answer: hook + 2 concrete proofs from CONTEXT + close why you fit. Spoken English, natural, not bullet-spam."
}

Rules:
- All three fields are plain text the candidate can read/speak (use short line breaks ok).
- English only.
- Sound human, not like a resume dump.
- For "walk through resume / tell me about yourself": lead with seniority + years, then 2-3 roles most relevant, then close.

CONTEXT:
${context || '(empty)'}`
}

function stripFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function fallbackOptions(text: string): AnswerOption[] {
  const body = text.trim() || 'I can walk you through my recent roles and the projects most relevant to this position.'
  return [
    { id: 'instant', label: 'Instant', body },
    { id: 'star', label: 'STAR', body },
    { id: 'power', label: 'Power', body }
  ]
}

function parseOptions(raw: string): AnswerOption[] {
  try {
    const data = JSON.parse(stripFence(raw)) as {
      instant?: string
      star?: string
      power?: string
    }
    const options: AnswerOption[] = []
    if (data.instant?.trim()) options.push({ id: 'instant', label: 'Instant', body: data.instant.trim() })
    if (data.star?.trim()) options.push({ id: 'star', label: 'STAR', body: data.star.trim() })
    if (data.power?.trim()) options.push({ id: 'power', label: 'Power', body: data.power.trim() })
    if (options.length) return options
  } catch {
    // fall through
  }
  return fallbackOptions(raw)
}

export async function generateAnswerOptions(
  question: string,
  recentLines: string[]
): Promise<AnswerOption[]> {
  const context = getCachedContext()
  const hasContext = context.trim().length > 80
  const recent = recentLines
    .slice(-3)
    .map((line, i, arr) => {
      const mark = i === arr.length - 1 ? 'QUESTION' : 'CONTEXT'
      return `[${mark}] ${line}`
    })
    .join('\n')

  const user = `Interview question to answer NOW:
${question}

Recent transcript:
${recent || '(none)'}

Produce the JSON with instant, star, and power answers.`

  const raw = await chat(buildSystem(context, hasContext), user, {
    temperature: 0.45,
    maxTokens: 1400
  })
  return parseOptions(raw)
}

/** @deprecated use generateAnswerOptions */
export async function generateAnswer(
  question: string,
  recentLines: string[]
): Promise<string> {
  const options = await generateAnswerOptions(question, recentLines)
  return options[0]?.body ?? ''
}
