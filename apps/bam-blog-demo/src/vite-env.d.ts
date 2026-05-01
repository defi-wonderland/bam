/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POSTER_URL?: string;
  readonly VITE_READER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
