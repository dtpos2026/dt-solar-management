/**
 * Admin users (admins/{uid}). On the Spark plan there is no Admin SDK, so:
 *  - new logins are created with createUserWithEmailAndPassword on a SECONDARY Firebase app instance (in-memory
 *    persistence), so the owner's own session is not replaced, and that app is signed out and deleted right after;
 *  - an Auth account cannot be disabled or deleted from the browser — `active: false` blocks it in the rules
 *    immediately, and the owner can delete the login in Firebase Console → Authentication.
 */
import { deleteApp, initializeApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  inMemoryPersistence,
  initializeAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth'
import { Timestamp, collection, doc, getDoc, serverTimestamp, writeBatch, type DocumentData, type DocumentSnapshot, type QueryDocumentSnapshot } from 'firebase/firestore'
import { auth, db, firebaseConfig } from '../firebase'
import { logActivity, writeActivity } from './audit'
import { isOwnerRole, presetPermissions, roleLabel, sanitisePermissions, type AdminRole } from './perm'

export const adminsCol = () => collection(db, 'admins')
export const adminRef = (uid: string) => doc(db, 'admins', uid)

export interface AdminRecord {
  uid: string
  email: string
  name: string
  role: string
  permissions: string[]
  active: boolean
  createdAt: Timestamp | null
  createdBy: string
  updatedAt: Timestamp | null
}

type Snap = DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>

export function adminFromSnap(s: Snap): AdminRecord {
  const d = s.data() ?? {}
  return {
    uid: s.id,
    email: typeof d.email === 'string' ? d.email : '',
    name: typeof d.name === 'string' ? d.name : '',
    role: typeof d.role === 'string' ? d.role : 'custom',
    permissions: sanitisePermissions(d.permissions),
    active: d.active !== false,
    createdAt: d.createdAt instanceof Timestamp ? d.createdAt : null,
    createdBy: typeof d.createdBy === 'string' ? d.createdBy : '',
    updatedAt: d.updatedAt instanceof Timestamp ? d.updatedAt : null
  }
}

function storedPermissions(role: AdminRole, permissions: string[]): string[] {
  return role === 'owner' ? presetPermissions('owner') : sanitisePermissions(permissions)
}

export interface NewAdminInput {
  email: string
  password: string
  name: string
  role: AdminRole
  permissions: string[]
  /** The e-mail already has a Firebase Auth login: `password` is its current password (used once to read its uid). */
  linkExisting: boolean
}

/** Friendly messages for Firebase Auth errors raised while creating a login. */
export function authCreateError(e: unknown): Error {
  const code = (e as { code?: string })?.code ?? ''
  if (code === 'auth/email-already-in-use') {
    return new Error(
      'A login with this e-mail already exists. Tick “This e-mail already has a login” and enter its current password to link it, or delete the user in Firebase Console → Authentication first.'
    )
  }
  if (code === 'auth/weak-password') return new Error('Firebase rejected the password as too weak. Use at least 8 letters and numbers.')
  if (code === 'auth/invalid-email') return new Error('Enter a valid e-mail address.')
  if (code === 'auth/operation-not-allowed') return new Error('E-mail/password sign-in is disabled for this Firebase project (Firebase Console → Authentication → Sign-in method).')
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return new Error('The existing login could not be verified: wrong e-mail or password.')
  }
  if (code === 'auth/too-many-requests') return new Error('Too many attempts. Wait a few minutes and try again.')
  return new Error((e as Error)?.message || String(e))
}

/** Creates (or verifies) the Firebase Auth login on a throw-away secondary app and returns its uid. */
async function createLogin(email: string, password: string, linkExisting: boolean): Promise<string> {
  const secondary = initializeApp(firebaseConfig, `admin-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const secAuth = initializeAuth(secondary, { persistence: inMemoryPersistence })
  if (import.meta.env.VITE_USE_EMULATORS === '1') {
    connectAuthEmulator(secAuth, `http://127.0.0.1:${Number(import.meta.env.VITE_EMU_AUTH_PORT || 9099)}`, { disableWarnings: true })
  }
  try {
    const cred = linkExisting
      ? await signInWithEmailAndPassword(secAuth, email, password)
      : await createUserWithEmailAndPassword(secAuth, email, password)
    return cred.user.uid
  } catch (e) {
    throw authCreateError(e)
  } finally {
    await signOut(secAuth).catch(() => undefined)
    await deleteApp(secondary).catch(() => undefined)
  }
}

export async function createAdmin(input: NewAdminInput): Promise<{ uid: string }> {
  const email = input.email.trim().toLowerCase()
  const uid = await createLogin(email, input.password, input.linkExisting)
  const existing = await getDoc(adminRef(uid)).catch(() => null)
  if (existing?.exists()) throw new Error(`${email} is already an admin. Edit the existing record instead.`)
  const by = auth.currentUser?.email ?? ''
  const permissions = storedPermissions(input.role, input.permissions)
  const batch = writeBatch(db)
  batch.set(adminRef(uid), {
    email,
    name: input.name.trim(),
    role: input.role,
    permissions,
    active: true,
    createdAt: serverTimestamp(),
    createdBy: by,
    updatedAt: serverTimestamp()
  })
  writeActivity(batch, {
    action: 'admin_created',
    category: 'security',
    target: email,
    targetType: 'admin',
    details: `${input.name.trim()} <${email}> added as ${roleLabel(input.role)}${input.linkExisting ? ' (existing login linked)' : ''}; ${isOwnerRole(input.role) ? 'all permissions' : `${permissions.length} permission(s)`}`,
    meta: { uid, role: input.role, permissions, linkedExisting: input.linkExisting }
  })
  try {
    await batch.commit()
  } catch (e) {
    const err = e as { code?: string; message?: string }
    throw new Error(
      `The login ${email} was ${input.linkExisting ? 'verified' : 'created'}, but the admin record could not be saved (${err.code ?? err.message}). ` +
        'Try again with “This e-mail already has a login” ticked, or delete the login in Firebase Console → Authentication.'
    )
  }
  return { uid }
}

export interface AdminAccessInput {
  name: string
  role: AdminRole
  permissions: string[]
}

export async function updateAdminAccess(target: AdminRecord, input: AdminAccessInput): Promise<void> {
  const permissions = storedPermissions(input.role, input.permissions)
  const added = permissions.filter((p) => !target.permissions.includes(p))
  const removed = target.permissions.filter((p) => !permissions.includes(p))
  const changes: string[] = []
  if (input.name.trim() !== target.name) changes.push(`name “${target.name}” → “${input.name.trim()}”`)
  if (input.role !== target.role) changes.push(`role ${roleLabel(target.role)} → ${roleLabel(input.role)}`)
  if (added.length) changes.push(`granted ${added.join(', ')}`)
  if (removed.length) changes.push(`removed ${removed.join(', ')}`)
  const batch = writeBatch(db)
  batch.update(adminRef(target.uid), { name: input.name.trim(), role: input.role, permissions, updatedAt: serverTimestamp() })
  writeActivity(batch, {
    action: 'admin_updated',
    category: 'security',
    target: target.email,
    targetType: 'admin',
    details: changes.length ? changes.join('; ') : 'No changes',
    meta: { uid: target.uid, role: input.role, added, removed }
  })
  await batch.commit()
}

export async function setAdminActive(target: AdminRecord, active: boolean, reason: string): Promise<void> {
  const batch = writeBatch(db)
  batch.update(adminRef(target.uid), { active, updatedAt: serverTimestamp() })
  writeActivity(batch, {
    action: active ? 'admin_enabled' : 'admin_disabled',
    category: 'security',
    target: target.email,
    targetType: 'admin',
    details: `${target.name || target.email} ${active ? 'enabled' : 'disabled'}${reason.trim() ? `. Reason: ${reason.trim()}` : ''}`,
    meta: { uid: target.uid }
  })
  await batch.commit()
}

export async function deleteAdminRecord(target: AdminRecord): Promise<void> {
  const batch = writeBatch(db)
  batch.delete(adminRef(target.uid))
  writeActivity(batch, {
    action: 'admin_deleted',
    category: 'security',
    target: target.email,
    targetType: 'admin',
    details: `Admin record of ${target.name || target.email} (${roleLabel(target.role)}) deleted. The Firebase Auth login remains until it is deleted in Firebase Console.`,
    meta: { uid: target.uid, role: target.role, permissions: target.permissions }
  })
  await batch.commit()
}

export async function sendAdminPasswordReset(target: { email: string; uid?: string }): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, target.email)
  } catch (e) {
    await logActivity({ action: 'admin_password_reset_sent', category: 'security', target: target.email, targetType: 'admin', status: 'failure', details: (e as Error).message }).catch(() => undefined)
    throw authCreateError(e)
  }
  await logActivity({ action: 'admin_password_reset_sent', category: 'security', target: target.email, targetType: 'admin', details: `Password reset e-mail sent to ${target.email}`, meta: target.uid ? { uid: target.uid } : {} })
}
