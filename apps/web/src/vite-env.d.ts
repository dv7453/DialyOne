/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VOICE_TOKEN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
