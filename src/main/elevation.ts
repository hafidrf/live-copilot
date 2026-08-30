import { execSync } from 'child_process'

/** True when the process token is elevated (Run as administrator). */
export function isProcessElevated(): boolean {
  if (process.platform !== 'win32') return false
  try {
    // whoami /groups contains Mandatory Label\High Mandatory Level when elevated
    const out = execSync('whoami /groups', { encoding: 'utf-8' })
    return /S-1-16-12288|High Mandatory Level/i.test(out)
  } catch {
    try {
      // net session succeeds only when elevated
      execSync('net session', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}
