declare module '*?raw' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  readonly MAIN_VITE_LICENSE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
