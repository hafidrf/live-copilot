const FILLERS = /^(?:so|okay|ok|well|alright|now|then|um|uh|hmm|right|actually|basically)\b[\s,]+/i

const STARTERS = [
  'what','why','how','when','where','which','who','whose','whom',
  'can you','could you','would you','will you','shall we',
  'do you','did you','have you','has you','had you','have you ever','has there been',
  'are you','is there','is it','was there','were you',
  'tell me about','tell us about','tell me a little about','walk me through','walk us through',
  'describe','describe a time','explain','elaborate',
  'give me an example','give an example','share an experience','share a time','share with me',
  'how do you handle','how did you handle','how would you handle','how have you handled',
  'what would you do if','what did you do when','why should we hire','why do you want',
  'where do you see yourself','what are your'
]

const QUESTION_WORDS = new Set(['what','why','how','when','where','which','who','whose','whom'])

function normalize(text: string): string {
  return text.toLowerCase().replace(/['\u2019]/g, "'").replace(/[^\w\s?']/g, ' ').replace(/\s+/g, ' ').trim()
}
function stripFillers(n: string): string {
  let prev: string; do { prev = n; n = n.replace(FILLERS, '').trim() } while (n !== prev); return n
}
function startsWithStarter(n: string): boolean {
  const expanded = n.replace(/\b(what|how|who|where|when|why)'s\b/g, '$1 is')
  return STARTERS.some(s => expanded === s || expanded.startsWith(s + ' ') || expanded.startsWith(s + "'"))
}
function containsQuestionPattern(n: string): boolean {
  const words = n.split(' ').slice(0, 8).join(' ')
  return STARTERS.some(s => words.includes(s))
}
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim(); if (!trimmed) return false
  if (trimmed.includes('?')) return true
  let n = normalize(trimmed); n = stripFillers(n); if (!n) return false
  if (startsWithStarter(n)) return true
  if (containsQuestionPattern(n)) return true
  const first = n.split(' ')[0]
  if (QUESTION_WORDS.has(first) && n.split(' ').length <= 14) return true
  if (/\b(right|correct|isn't it|don't you|wouldn't you)\s*[.?]?$/.test(n)) return true
  return false
}
export function questionScore(text: string): number {
  let s = 0; if (text.includes('?')) s += 3
  const n = stripFillers(normalize(text))
  if (startsWithStarter(n)) s += 3; else if (containsQuestionPattern(n)) s += 2
  if (QUESTION_WORDS.has(n.split(' ')[0])) s += 1
  if (text.trim().split(/\s+/).length > 30) s -= 1
  return s
}
