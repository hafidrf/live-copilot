# Slow YouTube QC — OjH6cCLo-Uw (first 60s)

## Method
- Audio: yt-dlp download → 16 kHz mono WAV
- Reference: cleaned YouTube auto-VTT (rolling captions deduped)
- STT: same encode/chunk/Groq path as Live Copilot

## Results (clean WER)
| Config | Clean WER |
|---|---|
| full-file baseline | 4.1% |
| 6s chunk, no prompt | 5.1% |
| 3.5s chunk + prompt (old) | 11.2% |

Playwright live caption word coverage in STT hyp: **100%**

## Applied fix
- Default chunkSeconds: **6**
- Whisper prior-chunk prompt: **disabled** (caused drift on real YouTube)
- Overlap: **1.0s**
- LLM provider: **groq**
