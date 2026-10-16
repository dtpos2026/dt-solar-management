/** Admins — Super Admin users, roles and permissions (Module 6). */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { onSnapshot } from 'firebase/firestore'
import { Copy, Eye, EyeOff, KeyRound, Loader2, Mail, Pencil, Power, ShieldCheck, ShieldOff, Trash2, UserPlus, Users, Wand2 } from 'lucide-react'
import { Badge, Field, Modal, PageTitle, copy, cx } from '../components/ui'
import { ConfirmDialog, EmptyState, FieldError, IconButton, Loading, NoAccess, Notice, Pager, SearchBox, usePaged } from '../components/kit'
import { adminFromSnap, adminsCol, createAdmin, deleteAdminRecord, sendAdminPasswordReset, setAdminActive, updateAdminAccess, type AdminRecord } from '../lib/admins'
import { useAdmin, useAuth } from '../lib/auth'
import {
  ADMIN_PERMISSION_GROUPS,
  ADMIN_ROLES,
  ROLE_PRESETS,
  adminActions,
  assignableRoles,
  canGrantPermission,
  generateTempPassword,
  isOwnerRole,
  matchPreset,
  permissionCountLabel,
  presetPermissions,
  roleLabel,
  sanitisePermissions,
  validateAdminDraft,
  type AdminDraft,
  type AdminRole
} from '../lib/perm'
import { errorMessage, fmtDate } from '../lib/format'

const PAGE_SIZE = 12

type Pending = { kind: 'toggle' | 'delete' | 'reset'; admin: AdminRecord } | null

export function Admins() {
  const me = useAdmin()
  const { sessionTimeoutMin } = useAuth()
  const [rows, setRows] = useState<AdminRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('')
  const [form, setForm] = useState<{ open: boolean; admin: AdminRecord | null }>({ open: false, admin: null })
  const [pending, setPending] = useState<Pending>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const canManage = !!me && (me.isOwner || (me.permissions ?? []).includes('admins.manage'))

  useEffect(() => {
    if (!canManage) return
    return onSnapshot(
      adminsCol(),
      (s) => {
        setRows(s.docs.map(adminFromSnap).sort((a, b) => Number(isOwnerRole(b.role)) - Number(isOwnerRole(a.role)) || (a.name || a.email).localeCompare(b.name || b.email)))
        setLoading(false)
        setLoadError(null)
      },
      (e) => {
        setLoadError(errorMessage(e))
        setLoading(false)
      }
    )
  }, [canManage])

  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return rows.filter(
      (a) =>
        (!t || `${a.name} ${a.email} ${roleLabel(a.role)}`.toLowerCase().includes(t)) &&
        (!role || (role === 'owner' ? isOwnerRole(a.role) : a.role === role)) &&
        (!status || (status === 'active' ? a.active : !a.active))
    )
  }, [rows, q, role, status])
  const paged = usePaged(list, PAGE_SIZE, `${q}|${role}|${status}`)

  if (!me) return null
  if (!canManage) return <NoAccess what="Admins" need="Manage admin users" />

  const actor = { uid: me.uid, role: me.role, permissions: me.permissions }
  const activeCount = rows.filter((a) => a.active).length

  const runPending = async () => {
    if (!pending) return
    setBusy(true)
    setActionError(null)
    const a = pending.admin
    try {
      if (pending.kind === 'toggle') {
        await setAdminActive(a, !a.active, reason)
        setFlash({ tone: 'success', text: `${a.name || a.email} ${a.active ? 'disabled — the account is blocked by the security rules from now on' : 'enabled'}.` })
      } else if (pending.kind === 'delete') {
        await deleteAdminRecord(a)
        setFlash({ tone: 'success', text: `Admin record of ${a.email} deleted. Delete the login itself in Firebase Console → Authentication.` })
      } else {
        await sendAdminPasswordReset(a)
        setFlash({ tone: 'success', text: `Password reset e-mail sent to ${a.email}.` })
      }
      setPending(null)
      setReason('')
    } catch (e) {
      setActionError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageTitle
        icon={<Users />}
        title="Admins"
        sub={loading ? 'Loading…' : `${rows.length} admin user(s) · ${activeCount} active`}
        actions={
          <button className="btn btn-primary" onClick={() => setForm({ open: true, admin: null })}>
            <UserPlus className="h-4 w-4" />New admin
          </button>
        }
      />

      {flash && <Notice tone={flash.tone} className="mb-4" onClose={() => setFlash(null)}>{flash.text}</Notice>}

      <div className="mb-4 grid gap-3 xl:grid-cols-3">
        <div className="card flex gap-3 p-4 text-[12.5px] text-[#5b4b78]">
          <ShieldCheck className="h-5 w-5 shrink-0 text-[#7c3aed]" />
          <div>
            <div className="mb-0.5 font-bold text-[#1d1530]">Roles are enforced by Firestore rules</div>
            Only owners create owners or grant “Manage admin users”. Nobody can change their own role, permissions or status.
          </div>
        </div>
        <div className="card flex gap-3 p-4 text-[12.5px] text-[#5b4b78]">
          <ShieldOff className="h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <div className="mb-0.5 font-bold text-[#1d1530]">Disable blocks immediately</div>
            A disabled admin is refused by the rules at once and signed out of open sessions. “Sign out everywhere” and deleting the login itself are not possible from the
            browser on the Spark plan — delete the user in Firebase Console → Authentication.
          </div>
        </div>
        <div className="card flex gap-3 p-4 text-[12.5px] text-[#5b4b78]">
          <KeyRound className="h-5 w-5 shrink-0 text-[#7c3aed]" />
          <div>
            <div className="mb-0.5 font-bold text-[#1d1530]">Sign-in protection</div>
            Sessions end after {sessionTimeoutMin} minutes without activity (<Link className="font-semibold underline" to="/settings?tab=portal">Settings → Portal</Link>). Two-factor
            authentication needs the paid Firebase Identity Platform upgrade and is not enabled.
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox className="w-80" value={q} onChange={setQ} placeholder="Search name, e-mail or role…" />
        <select className="input w-52" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role filter">
          <option value="">All roles</option>
          {ADMIN_ROLES.map((r) => <option key={r} value={r}>{ROLE_PRESETS[r].label}</option>)}
        </select>
        <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <Loading label="Loading admins…" />
        ) : loadError ? (
          <div className="p-4"><Notice tone="error">{loadError}</Notice></div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Users />} title={rows.length ? 'No admin matches the filters' : 'No admins yet'} hint={rows.length ? 'Clear the search or filters.' : 'Add your team with “New admin”.'} />
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr><th>Name</th><th>E-mail</th><th>Role</th><th>Permissions</th><th>Status</th><th>Created</th><th className="text-right">Actions</th></tr>
              </thead>
              <tbody>
                {paged.slice.map((a) => {
                  const can = adminActions(actor, a)
                  const self = a.uid === me.uid
                  return (
                    <tr key={a.uid} className={cx(!a.active && 'opacity-60')}>
                      <td>
                        <div className="flex items-center gap-2 font-semibold">{a.name || '—'}{self && <Badge tone="you">You</Badge>}</div>
                      </td>
                      <td className="text-[13px]">{a.email}</td>
                      <td><Badge tone={isOwnerRole(a.role) ? 'owner' : 'role'}>{roleLabel(a.role)}</Badge></td>
                      <td className="text-[13px]" title={isOwnerRole(a.role) ? 'Owners have every permission' : a.permissions.join(', ')}>{permissionCountLabel(a)}</td>
                      <td><Badge tone={a.active ? 'active' : 'deactivated'}>{a.active ? 'Active' : 'Disabled'}</Badge></td>
                      <td className="text-[12.5px]">
                        <div>{fmtDate(a.createdAt)}</div>
                        {a.createdBy && <div className="text-[11.5px] text-[#7a6d92]">by {a.createdBy}</div>}
                      </td>
                      <td>
                        <div className="flex justify-end gap-0.5" title={can.reason ?? undefined}>
                          {can.edit && <IconButton title="Edit role & permissions" onClick={() => setForm({ open: true, admin: a })}><Pencil /></IconButton>}
                          {can.resetPassword && <IconButton title="Send password reset e-mail" onClick={() => { setActionError(null); setPending({ kind: 'reset', admin: a }) }}><Mail /></IconButton>}
                          {can.toggleActive && (
                            <IconButton title={a.active ? 'Disable' : 'Enable'} danger={a.active} onClick={() => { setActionError(null); setReason(''); setPending({ kind: 'toggle', admin: a }) }}><Power /></IconButton>
                          )}
                          {can.remove && <IconButton title="Delete admin record" danger onClick={() => { setActionError(null); setPending({ kind: 'delete', admin: a }) }}><Trash2 /></IconButton>}
                          {!can.edit && !self && <span className="px-2 text-[11.5px] text-[#9a8db3]">Owner only</span>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <Pager {...paged} noun="admins" />
          </>
        )}
      </div>

      <AdminForm
        open={form.open}
        admin={form.admin}
        actorIsOwner={me.isOwner}
        onClose={() => setForm({ open: false, admin: null })}
        onDone={(text) => setFlash({ tone: 'success', text })}
      />

      <ConfirmDialog
        open={pending?.kind === 'toggle'}
        title={pending?.admin.active ? 'Disable admin' : 'Enable admin'}
        confirmLabel={pending?.admin.active ? 'Disable' : 'Enable'}
        danger={pending?.admin.active}
        busy={busy}
        error={actionError}
        onConfirm={runPending}
        onClose={() => setPending(null)}
      >
        {pending?.admin.active ? (
          <>
            <p><b>{pending.admin.name || pending.admin.email}</b> will be blocked by the security rules immediately and signed out of any open portal session.</p>
            <p className="text-[12.5px] text-[#6b5d85]">Their Firebase login stays in Firebase Authentication (it cannot be disabled from the browser on the Spark plan). Delete it in Firebase Console → Authentication if they must never sign in again.</p>
            <Field label="Reason (saved in the activity log)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Left the company" /></Field>
          </>
        ) : (
          <p><b>{pending?.admin.name || pending?.admin.email}</b> will be able to sign in again with their current permissions.</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title="Delete admin record"
        confirmLabel="Delete record"
        danger
        busy={busy}
        error={actionError}
        onConfirm={runPending}
        onClose={() => setPending(null)}
      >
        <p>Delete the admin record of <b>{pending?.admin.email}</b>? They lose all access to this portal immediately.</p>
        <p className="text-[12.5px] text-[#6b5d85]">The Firebase Authentication login is not deleted (that needs Firebase Console). Their past activity log entries are kept.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === 'reset'}
        title="Send password reset e-mail"
        confirmLabel="Send e-mail"
        busy={busy}
        error={actionError}
        onConfirm={runPending}
        onClose={() => setPending(null)}
      >
        <p>Firebase will e-mail a password reset link to <b>{pending?.admin.email}</b>. Their current password keeps working until they choose a new one.</p>
      </ConfirmDialog>
    </div>
  )
}

/* ------------------------------------------------ form ------------------------------------------------ */

function blankDraft(): AdminDraft {
  return { name: '', email: '', password: generateTempPassword(), role: 'sales', permissions: presetPermissions('sales') }
}

function AdminForm({ open, admin, actorIsOwner, onClose, onDone }: { open: boolean; admin: AdminRecord | null; actorIsOwner: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const isNew = !admin
  const [d, setD] = useState<AdminDraft>(blankDraft)
  const [linkExisting, setLinkExisting] = useState(false)
  const [showPw, setShowPw] = useState(true)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    setTouched(false)
    setBusy(false)
    setCreated(null)
    setLinkExisting(false)
    setShowPw(true)
    if (admin) {
      const r = (ADMIN_ROLES as string[]).includes(admin.role) ? (admin.role as AdminRole) : isOwnerRole(admin.role) ? 'owner' : 'custom'
      setD({ name: admin.name, email: admin.email, password: '', role: r, permissions: admin.permissions })
    } else setD(blankDraft())
  }, [open, admin])

  const errors = validateAdminDraft(d, actorIsOwner, isNew, linkExisting)
  const shown = touched ? errors : {}
  const set = (p: Partial<AdminDraft>) => setD((x) => ({ ...x, ...p }))
  const pickRole = (r: AdminRole) => set({ role: r, permissions: r === 'custom' ? d.permissions : presetPermissions(r) })
  const toggle = (perm: string, on: boolean) => {
    const next = sanitisePermissions(on ? [...d.permissions, perm] : d.permissions.filter((p) => p !== perm))
    set({ permissions: next, role: matchPreset(next) })
  }
  const isOwnerDraft = d.role === 'owner'

  const save = async () => {
    setTouched(true)
    if (Object.keys(errors).length) return
    setBusy(true)
    setErr(null)
    try {
      if (isNew) {
        await createAdmin({ email: d.email, password: d.password, name: d.name, role: d.role, permissions: d.permissions, linkExisting })
        onDone(`${d.name.trim()} (${d.email.trim().toLowerCase()}) added as ${roleLabel(d.role)}.`)
        if (linkExisting) onClose()
        else setCreated({ email: d.email.trim().toLowerCase(), password: d.password })
      } else {
        await updateAdminAccess(admin, { name: d.name, role: d.role, permissions: d.permissions })
        onDone(`Access of ${admin.email} updated.`)
        onClose()
      }
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <Modal open={open} onClose={onClose} title="Admin created" footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <Notice tone="success">The login and admin record were created. Share these sign-in details privately (not by e-mail together with the password).</Notice>
        <div className="mt-3 space-y-2 rounded-xl border border-[#e7e1f0] bg-[#faf8fd] p-3 font-mono text-[13px]">
          <div>E-mail: {created.email}</div>
          <div>Temporary password: {created.password}</div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-secondary btn-sm" onClick={() => copy(`DT Solar Pro Super Admin\n${window.location.origin}\nE-mail: ${created.email}\nTemporary password: ${created.password}`)}><Copy className="h-4 w-4" />Copy details</button>
        </div>
        <p className="mt-3 text-[12.5px] text-[#6b5d85]">Ask them to choose their own password with “Forgot password?” on the sign-in page after the first sign-in (Firebase on the Spark plan cannot force a password change).</p>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={isNew ? 'New admin' : `Edit ${admin?.email}`}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {isNew ? 'Create admin' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus maxLength={120} />
          <FieldError msg={shown.name} />
        </Field>
        <Field label="E-mail (sign-in)">
          <input className="input" type="email" value={d.email} disabled={!isNew} onChange={(e) => set({ email: e.target.value })} autoComplete="off" />
          <FieldError msg={shown.email} />
        </Field>
        {isNew && (
          <>
            <Field label={linkExisting ? 'Current password of that login' : 'Temporary password'} hint={linkExisting ? 'Used once to look up the existing login; it is not stored.' : 'At least 8 characters with letters and numbers.'}>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input className="input pr-9 font-mono" type={showPw ? 'text' : 'password'} value={d.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
                  <button type="button" className="absolute top-2.5 right-2.5 text-[#7a6d92]" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}>
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {!linkExisting && <button type="button" className="btn btn-secondary h-[38px]" title="Generate a password" onClick={() => set({ password: generateTempPassword() })}><Wand2 className="h-4 w-4" /></button>}
              </div>
              <FieldError msg={shown.password} />
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex items-start gap-2 text-[12.5px] text-[#5b4b78]">
                <input type="checkbox" className="mt-0.5" checked={linkExisting} onChange={(e) => { setLinkExisting(e.target.checked); set({ password: e.target.checked ? '' : generateTempPassword() }) }} />
                <span>This e-mail already has a login (e.g. created in Firebase Console or a previously deleted admin) — link it instead of creating a new one.</span>
              </label>
            </div>
          </>
        )}
        <Field label="Role" className="col-span-2">
          <div className="flex flex-wrap gap-1.5">
            {assignableRoles(actorIsOwner).map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => pickRole(r)}
                className={cx(
                  'rounded-lg border px-3 py-1.5 text-[13px] font-semibold',
                  d.role === r ? 'border-[#7c3aed] bg-[#f3ebfe] text-[#3d096d]' : 'border-[#ddd5ea] bg-white text-[#5b4b78] hover:bg-[#faf7fe]'
                )}
              >
                {ROLE_PRESETS[r].label}
              </button>
            ))}
          </div>
          <FieldError msg={shown.role} />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="label mb-0">Permissions</span>
          <span className="text-[12px] text-[#7a6d92]">{isOwnerDraft ? 'Owners have every permission' : `${sanitisePermissions(d.permissions).length} selected · changing a box switches the role to the matching preset or Custom`}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {ADMIN_PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.group} className="rounded-xl border border-[#ece6f4] p-3">
              <legend className="px-1 text-[12px] font-bold text-[#3d096d]">{g.group}</legend>
              {g.items.map((p) => {
                const grantable = canGrantPermission(actorIsOwner, p.key)
                const checked = isOwnerDraft || d.permissions.includes(p.key)
                return (
                  <label key={p.key} className={cx('flex items-start gap-2 py-1 text-[12.5px]', (!grantable || isOwnerDraft) && 'opacity-60')} title={!grantable ? 'Only an owner can grant this permission' : p.key}>
                    <input type="checkbox" className="mt-0.5" checked={checked} disabled={isOwnerDraft || !grantable} onChange={(e) => toggle(p.key, e.target.checked)} />
                    <span>{p.label}{!grantable && <span className="block text-[11px] text-[#9a8db3]">Owner only</span>}</span>
                  </label>
                )
              })}
            </fieldset>
          ))}
        </div>
        <FieldError msg={shown.permissions} />
      </div>
      {isOwnerDraft && <Notice tone="warn" className="mt-3">Owners can do everything, including managing other owners and deleting records. Give this role only to Digital Target directors.</Notice>}
      {err && <Notice tone="error" className="mt-3">{err}</Notice>}
    </Modal>
  )
}
