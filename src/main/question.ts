const STARTERS = [
  'what',
  'why',
  'how',
  'when',
  'where',
  'which',
  'who',
  'can you',
  'could you',
  'would you',
  'do you',
  'did you',
  'have you',
  'are you',
  'is there',
  'tell me about',
  'walk me through',
  'describe',
  'explain'
]

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s?'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cheap first-pass question detector. */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.endsWith('?')) return true

  const n = normalize(trimmed)
  return STARTERS.some((s) => n === s || n.startsWith(`${s} `))
}
