import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/** Append one STT debug line for offline QC vs YouTube captions. */
export function logSttDebug(entry: Record<string, unknown>): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
    appendFileSync(join(dir, 'debug-stt.jsonl'), line, 'utf-8')
  } catch {
    // never break the session for logging
  }
}

export function clearSttDebug(): void {
  try {
    const path = join(app.getPath('userData'), 'debug-stt.jsonl')
    appendFileSync(path, `\n--- session ${new Date().toISOString()} ---\n`, 'utf-8')
  } catch {
    // ignore
  }
}
