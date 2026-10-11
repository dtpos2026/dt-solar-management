/**
 * Firebase web configuration for the DT Solar Pro license backend.
 * This config is PUBLIC by design (it only identifies the project); access is controlled by
 * Firebase Auth + Firestore security rules. Only Auth and Firestore are used (free Spark plan):
 * no Analytics, no Storage, no Cloud Functions.
 */
import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

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
export const db = getFirestore(app)

/** The owner account that may create its own admins/{uid} document the first time (bootstrap). */
export const BOOTSTRAP_OWNER_EMAIL = 'digitaltarget.digital@gmail.com'
