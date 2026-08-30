/**
 * Generate Live Copilot icon: dark card with waveform + caption bar.
 */
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const buildDir = join(root, 'build')
mkdirSync(buildDir, { recursive: true })

const size = 512
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0B1220"/>
      <stop offset="100%" stop-color="#163A5F"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="96" y="140" width="320" height="232" rx="36" fill="rgba(244,247,250,0.08)" stroke="#3D8BFD" stroke-width="8"/>
  <path d="M148 256 L176 220 L204 280 L232 200 L260 268 L288 236 L316 256 L348 230"
    fill="none" stroke="#3DD68C" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="148" y="310" width="216" height="18" rx="9" fill="#F4F7FA"/>
  <rect x="148" y="340" width="140" height="12" rx="6" fill="#9BB4C9"/>
</svg>`

const pngPath = join(buildDir, 'icon.png')
const icoPath = join(buildDir, 'icon.ico')

await sharp(Buffer.from(svg)).png().toFile(pngPath)
const ico = await pngToIco([
  await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer(),
  await sharp(Buffer.from(svg)).resize(128, 128).png().toBuffer(),
  await sharp(Buffer.from(svg)).resize(64, 64).png().toBuffer(),
  await sharp(Buffer.from(svg)).resize(48, 48).png().toBuffer(),
  await sharp(Buffer.from(svg)).resize(32, 32).png().toBuffer(),
  await sharp(Buffer.from(svg)).resize(16, 16).png().toBuffer()
])
writeFileSync(icoPath, ico)

console.log('Created:', pngPath)
console.log('Created:', icoPath)
