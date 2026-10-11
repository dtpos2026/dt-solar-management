export interface DtApi {
  call<T = unknown>(method: string, args?: unknown): Promise<T>
  onLicense(cb: (status: unknown) => void): () => void
  onSession(cb: (event: string) => void): () => void
}

declare global {
  interface Window {
    dt: DtApi
  }
}
