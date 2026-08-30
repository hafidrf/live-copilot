import { chat } from './llm'

const SYSTEM = `You are a precise translator for live meeting captions.
Translate the user's English sentence into natural professional Indonesian.
Rules:
- Output ONLY the Indonesian translation. No quotes, labels, or explanations.
- Keep technical terms in English when that is natural in Indonesian tech workplaces (e.g. React, Flutter, API, latency, pull request).
- Preserve meaning; do not invent content.
- Keep names, product names, and acronyms unchanged.`

const cache = new Map<string, string>()
let queue: Promise<void> = Promise.resolve()

function normalizeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

async function translateOne(text: string): Promise<string> {
  const key = normalizeKey(text)
  if (!key) return ''
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const output = await chat(SYSTEM, text, { temperature: 0.3, maxTokens: 300 })
  const cleaned = output.replace(/^["'\s]+|["'\s]+$/g, '').trim()
  cache.set(key, cleaned)
  if (cache.size > 400) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  return cleaned
}

/** Serialize translations so order stays stable. */
export function enqueueTranslation(text: string): Promise<string> {
  const run = queue.then(() => translateOne(text))
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
