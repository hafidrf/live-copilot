const TARGET_RATE = 16_000
const OVERLAP_SECONDS = 1

/** Boost quiet loopback (YouTube) so Whisper gets usable levels. */
function normalizePeak(samples: Float32Array, targetPeak = 0.75): Float32Array {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]))
  }
  if (peak < 0.002) return samples
  const gain = Math.min(targetPeak / peak, 12)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain))
  }
  return out
}

export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input
  if (inputRate <= 0) return new Float32Array(0)

  const ratio = inputRate / TARGET_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)

  if (Number.isInteger(ratio)) {
    const step = ratio
    for (let i = 0; i < outLen; i++) {
      const start = i * step
      let sum = 0
      for (let j = 0; j < step; j++) sum += input[start + j] ?? 0
      out[i] = sum / step
    }
    return out
  }

  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = src - i0
    out[i] = (input[i0] ?? 0) * (1 - t) + (input[i1] ?? 0) * t
  }
  return out
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}

export function encodeWavPcm16Mono(samples: Float32Array, sampleRate = TARGET_RATE): Uint8Array {
  const numSamples = samples.length
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = numSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const int16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    view.setInt16(offset, int16, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

export type ChunkHandler = (wav: Uint8Array, startedAt: number) => void
export type SilentHandler = () => void

export interface AudioCaptureHandle {
  stop: () => void
  getLevel: () => number
}

const WORKLET_CODE = `
class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) {
      this.port.postMessage(ch.slice(0))
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTapProcessor)
`

export async function startSystemAudioCapture(opts: {
  chunkSeconds: number
  energyThreshold: number
  onChunk: ChunkHandler
  onSilent: SilentHandler
}): Promise<AudioCaptureHandle> {
  const stream = await acquireLoopbackStream()

  // Keep video track alive but disabled — stopping it immediately can kill
  // the whole MediaStream (incl. audio) on some Chromium/Electron builds.
  stream.getVideoTracks().forEach((t) => {
    t.enabled = false
  })

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'Audio sistem tidak terdeteksi. Pastikan speaker/YouTube berbunyi, lalu coba Listen lagi.'
    )
  }

  const audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(stream)
  // Do NOT connect to destination — that would echo system audio.

  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)

  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  await audioContext.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)

  const node = new AudioWorkletNode(audioContext, 'pcm-tap')
  source.connect(node)

  const chunkSamples = Math.max(3, opts.chunkSeconds) * TARGET_RATE
  const overlapSamples = Math.floor(OVERLAP_SECONDS * TARGET_RATE)
  const tailSilentSamples = Math.floor(0.8 * TARGET_RATE)

  let pending = new Float32Array(0)
  let seqStartedAt = Date.now()
  let level = 0
  let stopped = false

  const timeData = new Uint8Array(analyser.fftSize)

  const levelTimer = window.setInterval(() => {
    analyser.getByteTimeDomainData(timeData)
    let sum = 0
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128
      sum += v * v
    }
    level = Math.min(1, Math.sqrt(sum / timeData.length) * 4)
  }, 50)

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (stopped) return
    const down = downsampleTo16k(ev.data, audioContext.sampleRate)
    if (down.length === 0) return

    const merged = new Float32Array(pending.length + down.length)
    merged.set(pending, 0)
    merged.set(down, pending.length)
    pending = merged

    while (pending.length >= chunkSamples) {
      const rawChunk = pending.slice(0, chunkSamples)
      const chunk = normalizePeak(rawChunk)
      const startedAt = seqStartedAt
      const energy = rms(chunk)
      const tail = chunk.slice(Math.max(0, chunk.length - tailSilentSamples))
      const tailEnergy = rms(tail)
      const threshold = opts.energyThreshold

      // Only skip truly silent chunks — avoid dropping quiet speech.
      if (energy < threshold * 0.35 && tailEnergy < threshold * 0.35) {
        opts.onSilent()
      } else {
        opts.onChunk(encodeWavPcm16Mono(chunk), startedAt)
      }

      // Keep overlap for next chunk.
      pending = pending.slice(chunkSamples - overlapSamples)
      seqStartedAt = Date.now() - OVERLAP_SECONDS * 1000
    }
  }

  return {
    getLevel: () => level,
    stop: () => {
      stopped = true
      window.clearInterval(levelTimer)
      try {
        node.port.onmessage = null
        node.disconnect()
        source.disconnect()
        void audioContext.close()
      } catch {
        // ignore
      }
      stream.getTracks().forEach((t) => t.stop())
    }
  }
}

async function acquireLoopbackStream(): Promise<MediaStream> {
  const elev = await window.api.isElevated().catch(() => ({ elevated: false }))
  if (elev.elevated) {
    throw new Error(
      'Cursor/Live Copilot sedang jalan sebagai Administrator. Tutup Cursor sepenuhnya, buka lagi TANPA "Run as administrator", lalu npm run dev / buka Live Copilot. (Electron 37+ memblokir screen capture saat elevated.)'
    )
  }

  // Path A: getDisplayMedia + main-process loopback handler
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: 1,
        height: 1,
        frameRate: 1
      } as MediaTrackConstraints,
      audio: true
    })
    if (stream.getAudioTracks().length > 0) return stream
    stream.getTracks().forEach((t) => t.stop())
  } catch (err) {
    console.warn('getDisplayMedia failed, trying getUserMedia desktop fallback', err)
  }

  // Path B: classic Electron chromeMediaSource — prefer browser window
  try {
    const screens = await window.api.listCaptureScreens()
    const browserWin = screens.find(
      (s) => s.id.startsWith('window:') && /chrome|msedge|brave|firefox|youtube/i.test(s.name)
    )
    const screen = browserWin ?? screens.find((s) => s.id.startsWith('screen:')) ?? screens[0]
    if (!screen) {
      throw new Error('Tidak ada layar/window yang bisa di-capture.')
    }

    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screen.id
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: screen.id,
          maxWidth: 1,
          maxHeight: 1,
          maxFrameRate: 1
        }
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia(
      constraints as unknown as MediaStreamConstraints
    )
    if (stream.getAudioTracks().length > 0) return stream
    stream.getTracks().forEach((t) => t.stop())
  } catch (err) {
    console.warn('desktop getUserMedia failed, trying Stereo Mix / cable input', err)
  }

  // Path C: Stereo Mix / VB-Cable / virtual loopback as normal mic device
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch(() => null)
    const devices = await navigator.mediaDevices.enumerateDevices()
    const loopbackish = devices.find(
      (d) =>
        d.kind === 'audioinput' &&
        /stereo mix|cable|vb-?audio|what.?u.?hear|loopback|wave out|speakers \(.*loop/i.test(
          d.label
        )
    )
    if (loopbackish) {
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: loopbackish.deviceId } },
        video: false
      })
    }
  } catch (err) {
    console.warn('stereo-mix path failed', err)
  }

  throw new Error(
    'Gagal capture audio sistem (Could not start video source). Penyebab tersering: app dijalankan sebagai Administrator — tutup Cursor, buka tanpa admin. Atau aktifkan Stereo Mix di Sound settings. Pastikan YouTube berbunyi di speaker.'
  )
}
