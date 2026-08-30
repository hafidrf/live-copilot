#!/usr/bin/env node
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(os.homedir(), 'Desktop')

if (process.platform === 'win32') {
  const ps1 = path.join(root, 'scripts', 'create-desktop-shortcut.ps1')
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { stdio: 'inherit' }
  )
  process.exit(r.status ?? 1)
}

if (process.platform === 'darwin') {
  fs.mkdirSync(desktop, { recursive: true })
  const commandPath = path.join(desktop, 'Live Copilot.command')
  const body = `#!/bin/bash
cd "${root}"
npm start
`
  fs.writeFileSync(commandPath, body, { mode: 0o755 })
  console.log(`Shortcut created: ${commandPath}`)
  process.exit(0)
}

console.error(`desktop shortcut is not supported on ${process.platform}`)
process.exit(1)
