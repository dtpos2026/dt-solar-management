declare module '*?raw' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  readonly MAIN_VITE_FIREBASE_PROJECT_ID?: string
  readonly MAIN_VITE_FIREBASE_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
