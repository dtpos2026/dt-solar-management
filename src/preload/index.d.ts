export interface DtApi {
  call<T = unknown>(method: string, args?: unknown): Promise<T>
  onLicense(cb: (status: unknown) => void): () => void
  onSession(cb: (event: string) => void): () => void
  /** Native drag of a prepared outbox file (token from a whatsapp.* route). */
  startDrag(fileToken: string): void
}

declare global {
  interface Window {
    dt: DtApi
  }
}
