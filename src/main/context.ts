import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getOptions } from './settings'

const MAX_CHARS = 12_000

let cachedFolder: string | null = null
let cachedText = ''

function collectMarkdownFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      collectMarkdownFiles(full, out)
    } else if (st.isFile() && name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
}

export function loadContext(force = false): string {
  const folder = getOptions().contextFolder
  if (!folder) {
    cachedFolder = null
    cachedText = ''
    return ''
  }

  if (!force && cachedFolder === folder && cachedText) {
    return cachedText
  }

  const files: string[] = []
  collectMarkdownFiles(folder, files)
  // Prefer career/intro/screening docs first — they hold the speakable stories.
  files.sort((a, b) => {
    const score = (p: string): number => {
      const n = p.toLowerCase()
      if (n.includes('intro') || n.includes('career') || n.includes('detailed')) return 0
      if (n.includes('screening') || n.includes('prep')) return 1
      if (n.includes('apply')) return 3
      return 2
    }
    return score(a) - score(b) || a.localeCompare(b)
  })
  const parts: string[] = []
  let total = 0

  for (const file of files) {
    if (total >= MAX_CHARS) break
    let raw = ''
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    const remaining = MAX_CHARS - total
    const slice = raw.slice(0, remaining)
    parts.push(`--- FILE: ${file} ---\n${slice}`)
    total += slice.length
  }

  cachedFolder = folder
  cachedText = parts.join('\n\n')
  return cachedText
}

export function reloadContext(): { chars: number; folder: string | null } {
  const text = loadContext(true)
  return { chars: text.length, folder: getOptions().contextFolder }
}

export function getCachedContext(): string {
  return loadContext(false)
}
