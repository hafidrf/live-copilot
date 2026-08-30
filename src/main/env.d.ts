/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_GEMINI_API_KEY?: string
  readonly MAIN_VITE_DEEPSEEK_API_KEY?: string
  readonly MAIN_VITE_GROQ_API_KEY?: string
  readonly MAIN_VITE_NINEROUTER_API_KEY?: string
  /** Default: http://127.0.0.1:20128/v1 */
  readonly MAIN_VITE_NINEROUTER_BASE_URL?: string
  /** Default: ds/deepseek-v4-flash */
  readonly MAIN_VITE_NINEROUTER_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
