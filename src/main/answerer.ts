import { chat } from './llm'
import { getCachedContext } from './context'
import type { AnswerOption } from '../shared/types'

export type QuestionKind = 'hr_behavioral' | 'hr_general' | 'tech' | 'general'

export function classifyQuestion(q: string): QuestionKind {
  const lower = q.toLowerCase()
  const hrBehavioral = ['tell me about a time','conflict','disagreement','difficult situation','challenge','failure','mistake','pressure','deadline','teamwork','leadership','handled','resolved','difficult teammate','feedback']
  const hrGeneral = ['tell me about yourself','walk me through your resume','why should we hire','why do you want','why did you leave','where do you see yourself','5 years','strength','weakness','salary','motivation','why join']
  const tech = ['flutter','react','api','architecture','offline','bloc','riverpod','native','performance','testing']
  if (hrBehavioral.some(k => lower.includes(k))) return 'hr_behavioral'
  if (hrGeneral.some(k => lower.includes(k))) return 'hr_general'
  if (tech.some(k => lower.includes(k))) return 'tech'
  return 'general'
}

function buildSystem(context: string, hasContext: boolean, referenceTopic: string, question: string, kind: QuestionKind): string {
  const topicLine = referenceTopic.trim()
    ? `FOCUS: ${referenceTopic.trim()}\n- If kind=tech: use specific tech/patterns\n- If kind=hr_*: interpret topic as Role/Company/Domain context, NOT tech stack`
    : ''

  let contextBlock: string
  if (hasContext) {
    if (kind === 'hr_behavioral') {
      contextBlock = `CONTEXT is loaded. For this HR behavioral question, pick ONLY 1 most relevant project/role from CONTEXT as STAR anchor. Do NOT dump all projects.`
    } else if (kind === 'hr_general') {
      contextBlock = `CONTEXT is loaded. For this HR general question, DO NOT force project names. Answer from best-practice HR structure. Use CONTEXT only for seniority/years if relevant.`
    } else {
      contextBlock = `CONTEXT is loaded. You MUST ground every answer in CONTEXT facts (companies, projects, years, tech).
NEVER invent employers, metrics, or project names that are not in CONTEXT.
NEVER use [FILL] placeholders when CONTEXT has usable facts.
Prefer DeliveryDart, Orderific, The Gym Pod, EdgeProp, AutomatedPros, Flutter, React Native, offline-first, logistics when relevant.`
    }
  } else {
    contextBlock = `No CONTEXT folder loaded. Write strong generic senior-mobile answers using plausible structure, but mark any personal specifics as [FILL name] sparingly (max 2).`
  }

  let kindInstruction: string
  if (kind === 'hr_behavioral') {
    kindInstruction = `KIND: hr_behavioral — Strict STAR S->T->A->R. Focus on soft skills, collaboration, ownership. Use 1 project anchor only. Show humble ownership and learning. Keep it concise and human.`
  } else if (kind === 'hr_general') {
    kindInstruction = `KIND: hr_general — Use best-practice HR structure:
- For "tell me about yourself" / "walk me through your resume": Present-Past-Future.
- For "weakness": Weakness->Context->Action->Growth (show self-awareness + improvement).
- For "why should we hire you": 2-3 strengths + proof from experience + why fit for this role.
Keep tone confident, humble, human.`
  } else if (kind === 'tech') {
    kindInstruction = `KIND: tech — Use STAR with real CONTEXT projects: Situation->Task->Action->Result. Include specific tech, architecture, patterns, and measurable impact.`
  } else {
    kindInstruction = `KIND: general — Give a clear, concise, human answer. If CONTEXT is relevant, ground it; otherwise use best-practice structure.`
  }

  const contextSlice = (kind === 'hr_behavioral' || kind === 'hr_general') ? context.slice(0, 6000) : context

  return `You are an elite interview copilot.
${contextBlock}
${topicLine}
${kindInstruction}
Question kind: ${kind}
Current question: ${question}

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
${contextSlice || '(empty)'}`
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
  const { getOptions } = await import('./settings')
  const referenceTopic = getOptions().referenceTopic ?? ''
  const kind = classifyQuestion(question)
  const recent = recentLines
    .slice(-6)
    .map((line, i, arr) => {
      const mark = i === arr.length - 1 ? 'CURRENT QUESTION' : 'CONTEXT'
      return `[${mark}] ${line}`
    })
    .join('\n')

  const user = `Interview question to answer NOW:
${question}

Recent transcript:
${recent || '(none)'}

Produce the JSON with instant, star, and power answers.`

  const tempMap: Record<QuestionKind, number> = {
    hr_behavioral: 0.25,
    hr_general: 0.3,
    tech: 0.35,
    general: 0.3
  }

  const raw = await chat(buildSystem(context, hasContext, referenceTopic, question, kind), user, {
    temperature: tempMap[kind],
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
