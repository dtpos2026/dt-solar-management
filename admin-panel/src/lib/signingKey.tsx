import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { loadKey, seedToPkcs8Pem, type LoadedKey } from './crypto'

const STORAGE_KEY = 'dtsp-admin.signingKey.v1'

interface SigningKeyContextValue {
  key: LoadedKey | null
  /** True while a remembered key is being restored on startup. */
  restoring: boolean
  remembered: boolean
  load: (pemText: string, remember: boolean) => Promise<LoadedKey>
  setRemember: (remember: boolean) => void
  forget: () => void
}

const Ctx = createContext<SigningKeyContextValue | null>(null)

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(v: string | null): void {
  try {
    if (v) localStorage.setItem(STORAGE_KEY, v)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage blocked: key just stays in memory */
  }
}

/**
 * Holds the Ed25519 private key in memory for this browser session only.
 * It is never sent to Firestore or any server. Optionally remembered in localStorage.
 */
export function SigningKeyProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<LoadedKey | null>(null)
  const [remembered, setRemembered] = useState(false)
  const [restoring, setRestoring] = useState(true)

  useEffect(() => {
    const stored = readStored()
    if (!stored) {
      setRestoring(false)
      return
    }
    loadKey(stored)
      .then((k) => {
        setKey(k)
        setRemembered(true)
      })
      .catch(() => writeStored(null))
      .finally(() => setRestoring(false))
  }, [])

  const load = useCallback(async (pemText: string, remember: boolean) => {
    const k = await loadKey(pemText)
    setKey(k)
    if (remember) writeStored(seedToPkcs8Pem(k.seed))
    else writeStored(null)
    setRemembered(remember)
    return k
  }, [])

  const setRemember = useCallback(
    (remember: boolean) => {
      if (remember && key) writeStored(seedToPkcs8Pem(key.seed))
      if (!remember) writeStored(null)
      setRemembered(remember && !!key)
    },
    [key]
  )

  const forget = useCallback(() => {
    writeStored(null)
    setKey((k) => {
      if (k) k.seed.fill(0)
      return null
    })
    setRemembered(false)
  }, [])

  const value = useMemo(() => ({ key, restoring, remembered, load, setRemember, forget }), [key, restoring, remembered, load, setRemember, forget])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSigningKey(): SigningKeyContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSigningKey must be used inside <SigningKeyProvider>')
  return ctx
}
