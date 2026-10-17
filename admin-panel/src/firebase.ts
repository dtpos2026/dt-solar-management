/**
 * Firebase web configuration for the DT Solar Pro license backend.
 * This config is PUBLIC by design (it only identifies the project); access is controlled by
 * Firebase Auth + Firestore security rules. Only Auth and Firestore are used (free Spark plan):
 * no Analytics, no Storage, no Cloud Functions.
 */
import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore } from 'firebase/firestore'

export const firebaseConfig = {
  apiKey: 'AIzaSyB44q43NniwQy0K-mh4AnDTZZAtQEy0vYI',
  authDomain: 'dt-soalr-mangement.firebaseapp.com',
  projectId: 'dt-soalr-mangement',
  storageBucket: 'dt-soalr-mangement.firebasestorage.app',
  messagingSenderId: '167104418700',
  appId: '1:167104418700:web:1cb6f4c2e9c4cc8316bca9'
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
// Streaming (WebChannel) is blocked or throttled by some Windows proxies, VPNs and antivirus products; the SDK then waits
// ~10 s per attempt before it falls back, which made every write and transaction look stuck for 30 s or more.
// Auto-detect switches to long polling at once when streaming does not work and costs nothing when it does.
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true, ignoreUndefinedProperties: true })

// Local testing only: `VITE_USE_EMULATORS=1 npm run dev` talks to the Firebase emulators instead of production.
if (import.meta.env.VITE_USE_EMULATORS === '1') {
  const fsPort = Number(import.meta.env.VITE_EMU_FIRESTORE_PORT || 8080)
  const authPort = Number(import.meta.env.VITE_EMU_AUTH_PORT || 9099)
  connectAuthEmulator(auth, `http://127.0.0.1:${authPort}`, { disableWarnings: true })
  connectFirestoreEmulator(db, '127.0.0.1', fsPort)
}

/** The owner account that may create its own admins/{uid} document the first time (bootstrap). */
export const BOOTSTRAP_OWNER_EMAIL = 'digitaltarget.digital@gmail.com'
