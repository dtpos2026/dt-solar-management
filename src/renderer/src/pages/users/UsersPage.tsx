/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyPlus,
  Crown,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  UserCheck,
  UserCog,
  UserPlus,
  UserX,
  Users
} from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  IconButton,
  Input,
  Kv,
  Loading,
  Modal,
  PageHeader,
  PeriodPicker,
  Select,
  Tabs,
  Textarea,
  Toggle,
  confirmDialog,
  cx,
  toast
} from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { useLoad } from '../../lib/hooks'
import { dateTime, label, PERIODS } from '../../lib/format'
import { OWNER_ROLE_NAME } from '@shared/permissions'

type Tab = 'users' | 'roles' | 'audit'

interface Role {
  id: number
  name: string
  description: string | null
  permissions: string[]
  is_system: number
  user_count: number
}

interface UserRow {
  id: number
  username: string
  full_name: string
  email: string | null
  phone: string | null
  role_id: number
  role_name: string
  is_owner: number
  is_active: number
  all_firms: number
  last_login_at: string | null
  created_at: string
  firm_ids: number[]
}

interface FirmOpt {
  id: number
  name: string
  is_active: number
  is_default: number
}

interface PermGroup {
  group: string
  items: Array<{ key: string; label: string }>
}

const USERNAME_RE = /^[a-z0-9._-]{3,50}$/

/** Firms the current user may assign (all firms for firm managers, otherwise the firms they can access). */
function useFirmOptions(): FirmOpt[] {
  const can = useCan()
  const all = can('firms.manage')
  const { data } = useLoad(() => api<FirmOpt[]>(all ? 'firms.all' : 'firms.list'), [all])
  return data ?? []
}

/* =============================================================================================== */

export function UsersPage(): JSX.Element {
  const can = useCan()
  const [params, setParams] = useSearchParams()
  const canUsers = can('users.manage')
  const canAudit = can('audit.view')
  const allowed: Tab[] = [...(canUsers ? (['users', 'roles'] as Tab[]) : []), ...(canAudit ? (['audit'] as Tab[]) : [])]
  const requested = params.get('tab') as Tab | null
  const tab: Tab | undefined = requested && allowed.includes(requested) ? requested : allowed[0]
  const [userForm, setUserForm] = useState<{ open: boolean; user?: UserRow }>({ open: false })
  const [tick, setTick] = useState(0)

  if (!tab) {
    return (
      <div>
        <PageHeader title="Users & Roles" icon={<Users className="h-5 w-5" />} />
        <Card>
          <Empty icon={<Lock className="h-6 w-6" />} title="You do not have access to this section">
            Ask your administrator for the “Manage users & roles” or “View audit log” permission.
          </Empty>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Users & Roles"
        subtitle="Who can sign in, what each role is allowed to do, and a complete history of every change"
        icon={<Users className="h-5 w-5" />}
        actions={
          tab === 'users' && canUsers ? (
            <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setUserForm({ open: true })}>
              New user
            </Button>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { key: 'users', label: 'Users', hidden: !canUsers },
          { key: 'roles', label: 'Roles & permissions', hidden: !canUsers },
          { key: 'audit', label: 'Audit log', hidden: !canAudit }
        ]}
      />
      {tab === 'users' && <UsersTab tick={tick} onEdit={(u) => setUserForm({ open: true, user: u })} />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'audit' && <AuditTab />}
      {canUsers && <UserForm open={userForm.open} user={userForm.user} onClose={() => setUserForm({ open: false })} onSaved={() => setTick((t) => t + 1)} />}
    </div>
  )
}

/* =============================================== Users =============================================== */

function UsersTab({ tick, onEdit }: { tick: number; onEdit: (u: UserRow) => void }): JSX.Element {
  const me = useApp((s) => s.user)
  const license = useApp((s) => s.license)
  const { data, loading, reload } = useLoad(() => api<UserRow[]>('users.list'), [tick])
  const firms = useFirmOptions()
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all')
  const users = data ?? []
  const firmName = useMemo(() => new Map(firms.map((f) => [f.id, f.name])), [firms])
  const rows = users.filter((u) => (status === 'all' ? true : status === 'active' ? !!u.is_active : !u.is_active))
  const activeCount = users.filter((u) => u.is_active).length
  const maxUsers = license?.maxUsers ?? 0

  const firmsText = (u: UserRow): string =>
    u.is_owner || u.all_firms ? 'All firms' : u.firm_ids.map((id) => firmName.get(id) ?? `Firm #${id}`).join(', ') || 'No firm'

  const canEditRow = (u: UserRow): boolean => !u.is_owner || !!me?.isOwner

  const toggleActive = async (u: UserRow): Promise<void> => {
    const enabling = !u.is_active
    const ok = await confirmDialog({
      title: enabling ? `Enable ${u.full_name}?` : `Disable ${u.full_name}?`,
      message: enabling
        ? 'This user will be able to sign in again with their existing password.'
        : 'This user will no longer be able to sign in. Their records and history are kept and the account can be enabled again later.',
      danger: !enabling,
      confirmLabel: enabling ? 'Enable user' : 'Disable user'
    })
    if (!ok) return
    try {
      await api('users.save', {
        id: u.id,
        username: u.username,
        fullName: u.full_name,
        email: u.email ?? '',
        phone: u.phone ?? '',
        roleId: u.role_id,
        isActive: enabling,
        allFirms: !!u.all_firms,
        firmIds: u.firm_ids
      })
      toast.ok(enabling ? `${u.full_name} can sign in again.` : `${u.full_name} has been disabled.`)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const cols: Array<Column<UserRow>> = [
    {
      key: 'full_name',
      header: 'Name',
      value: (u) => [u.full_name, u.email, u.phone].filter(Boolean).join(' · '),
      render: (u) => (
        <div className="flex items-center gap-3">
          <div className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold', u.is_owner ? 'bg-warn-soft text-warn' : 'bg-brand-soft text-brand')}>
            {u.full_name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase())
              .join('')}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              {u.full_name}
              {!!u.is_owner && (
                <Badge tone="warn">
                  <Crown className="h-3 w-3" /> Owner
                </Badge>
              )}
              {u.id === me?.id && <Badge tone="info">You</Badge>}
            </div>
            <div className="truncate text-[11.5px] text-muted">{[u.email, u.phone].filter(Boolean).join(' · ') || '—'}</div>
          </div>
        </div>
      )
    },
    { key: 'username', header: 'Username', render: (u) => <span className="font-mono text-[12.5px]">{u.username}</span> },
    { key: 'role_name', header: 'Role', render: (u) => <Badge tone={u.role_name === OWNER_ROLE_NAME ? 'warn' : 'brand'}>{u.role_name}</Badge> },
    {
      key: 'firms',
      header: 'Firm access',
      value: firmsText,
      render: (u) =>
        u.is_owner || u.all_firms ? (
          <Badge tone="ok">All firms</Badge>
        ) : (
          <span className="block max-w-[260px] truncate text-[12.5px]" title={firmsText(u)}>
            {firmsText(u)}
          </span>
        )
    },
    {
      key: 'is_active',
      header: 'Status',
      value: (u) => (u.is_active ? 'Active' : 'Disabled'),
      render: (u) => (u.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Disabled</Badge>)
    },
    { key: 'last_login_at', header: 'Last sign in', value: (u) => u.last_login_at ?? '', render: (u) => (u.last_login_at ? dateTime(u.last_login_at) : <span className="text-muted">Never</span>) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      csv: false,
      render: (u) => (
        <div className="flex justify-end">
          {!u.is_owner && u.id !== me?.id && (
            <IconButton title={u.is_active ? 'Disable user' : 'Enable user'} tone={u.is_active ? 'bad' : undefined} onClick={() => toggleActive(u)}>
              {u.is_active ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
            </IconButton>
          )}
          <IconButton title={canEditRow(u) ? 'Edit user' : 'Only the owner can edit the owner account'} disabled={!canEditRow(u)} onClick={() => onEdit(u)}>
            <Pencil className="h-4 w-4" />
          </IconButton>
        </div>
      )
    }
  ]

  return (
    <DataTable
      rows={rows}
      columns={cols}
      loading={loading}
      exportName="Users"
      searchPlaceholder="Search name, username, role…"
      onRowClick={(u) => canEditRow(u) && onEdit(u)}
      rowClassName={(u) => (u.is_active ? undefined : 'opacity-60')}
      toolbar={
        <>
          <Select sm className="w-36" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All users</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
          <span className="text-[12.5px] text-muted">
            {activeCount} active user{activeCount === 1 ? '' : 's'}
            {maxUsers > 0 ? ` · your license allows ${maxUsers}` : ''}
          </span>
        </>
      }
      empty={<Empty icon={<Users />} title="No users found">Create accounts for your staff and give each one a role.</Empty>}
    />
  )
}

function UserForm({ open, user, onClose, onSaved }: { open: boolean; user?: UserRow; onClose: () => void; onSaved: () => void }): JSX.Element {
  const me = useApp((s) => s.user)
  const roles = useLoad(() => (open ? api<Role[]>('roles.list') : Promise.resolve([] as Role[])), [open])
  const firms = useFirmOptions()
  const [f, setF] = useState({ fullName: '', username: '', email: '', phone: '', roleId: 0, allFirms: true, firmIds: [] as number[], isActive: true })
  const [resetPw, setResetPw] = useState(false)
  const [pw, setPw] = useState({ a: '', b: '' })
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const isNew = !user
  const isOwner = !!user?.is_owner
  const isSelf = !!user && user.id === me?.id
  const needPw = isNew || resetPw
  const roleList = roles.data ?? []

  useEffect(() => {
    if (!open) return
    setResetPw(false)
    setPw({ a: '', b: '' })
    setShowPw(false)
    setF(
      user
        ? {
            fullName: user.full_name,
            username: user.username,
            email: user.email ?? '',
            phone: user.phone ?? '',
            roleId: user.role_id,
            allFirms: !!user.all_firms || !!user.is_owner,
            firmIds: user.firm_ids,
            isActive: !!user.is_active
          }
        : { fullName: '', username: '', email: '', phone: '', roleId: 0, allFirms: true, firmIds: [], isActive: true }
    )
  }, [open, user])

  // Pick a sensible default role for new users once roles are loaded.
  useEffect(() => {
    if (!open || !isNew || f.roleId || roleList.length === 0) return
    const def = roleList.find((r) => r.name === 'Salesperson') ?? roleList.find((r) => r.name !== OWNER_ROLE_NAME) ?? roleList[0]
    setF((x) => ({ ...x, roleId: def.id }))
  }, [open, isNew, roleList, f.roleId])

  const role = roleList.find((r) => r.id === Number(f.roleId))
  const usernameErr = f.username && !USERNAME_RE.test(f.username) ? 'Use 3–50 lowercase letters, numbers, dot, dash or underscore.' : undefined
  const pwErr = needPw && pw.a && pw.a.length < 6 ? 'Password must be at least 6 characters.' : undefined
  const pw2Err = needPw && pw.b && pw.a !== pw.b ? 'Passwords do not match.' : undefined

  const save = async (): Promise<void> => {
    if (!f.fullName.trim()) return toast.error('Full name is required.')
    if (!USERNAME_RE.test(f.username)) return toast.error('Username may contain lowercase letters, numbers, dot, dash and underscore (min 3).')
    if (!f.roleId) return toast.error('Select a role for this user.')
    if (!f.allFirms && f.firmIds.length === 0) return toast.error('Select at least one firm, or give access to all firms.')
    if (needPw) {
      if (pw.a.length < 6) return toast.error('Password must be at least 6 characters.')
      if (pw.a !== pw.b) return toast.error('Passwords do not match.')
    }
    setBusy(true)
    try {
      await api('users.save', {
        id: user?.id,
        fullName: f.fullName.trim(),
        username: f.username.trim(),
        email: f.email.trim(),
        phone: f.phone.trim(),
        roleId: Number(f.roleId),
        allFirms: isOwner ? true : f.allFirms,
        firmIds: f.allFirms ? [] : f.firmIds,
        isActive: isOwner ? true : f.isActive,
        password: needPw ? pw.a : undefined
      })
      toast.ok(isNew ? `User ${f.username} created. They will be asked to change the password at first sign in.` : resetPw ? 'User saved and password reset.' : 'User saved.')
      if (isSelf) await useApp.getState().refresh()
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const toggleFirm = (id: number, on: boolean): void => setF((x) => ({ ...x, firmIds: on ? [...new Set([...x.firmIds, id])] : x.firmIds.filter((i) => i !== id) }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={isNew ? 'New user' : `Edit user — ${user?.full_name}`}
      subtitle={isNew ? 'Create a sign-in for a staff member and choose what they can do' : isOwner ? 'Owner account — always has full access to every firm' : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} onClick={save}>
            {isNew ? 'Create user' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Full name" required>
            <Input autoFocus value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} placeholder="e.g. Ali Raza" />
          </Field>
          <Field label="Username" required error={usernameErr} hint="Used to sign in. Lowercase, no spaces.">
            <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s+/g, '') })} placeholder="e.g. ali" />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field
            label="Role"
            required
            hint={isOwner ? 'The owner always keeps the Super Administrator role.' : role?.description || undefined}
            error={isSelf && !isOwner && user && Number(f.roleId) !== user.role_id ? 'You are changing your own role — you may lose access to this page.' : undefined}
          >
            <Select value={f.roleId || ''} disabled={isOwner} onChange={(e) => setF({ ...f, roleId: Number(e.target.value) })}>
              {!f.roleId && <option value="">Select a role…</option>}
              {roleList.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} {r.name === OWNER_ROLE_NAME ? '(full access)' : `(${r.permissions.length} permissions)`}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end pb-1">
            {isOwner ? (
              <div className="flex items-center gap-2 text-[13px] text-muted">
                <Crown className="h-4 w-4 text-warn" /> The owner account cannot be disabled.
              </div>
            ) : (
              <div className="w-full rounded-xl border border-line px-3 py-2">
                <Toggle
                  checked={f.isActive}
                  disabled={isSelf}
                  onChange={(v) => setF({ ...f, isActive: v })}
                  label="Active"
                  description={isSelf ? 'You cannot disable your own account.' : f.isActive ? 'Can sign in' : 'Cannot sign in'}
                />
              </div>
            )}
          </div>
        </div>

        {!isOwner && (
          <div className="rounded-xl border border-line p-4">
            <Toggle
              checked={f.allFirms}
              onChange={(v) => setF({ ...f, allFirms: v })}
              label="Access to all firms"
              description="Includes firms created in the future. Turn off to choose specific firms."
            />
            {!f.allFirms && (
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
                {firms.length === 0 && <div className="text-[13px] text-muted">No firms available.</div>}
                {firms.map((fm) => (
                  <div key={fm.id} className="flex items-center gap-2">
                    <Checkbox checked={f.firmIds.includes(fm.id)} onChange={(v) => toggleFirm(fm.id, v)} label={fm.name} />
                    {!!fm.is_default && <Badge tone="brand">Default</Badge>}
                    {!fm.is_active && <Badge tone="bad">Inactive</Badge>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="rounded-xl border border-line p-4">
          {isNew ? (
            <div className="mb-3 flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4 text-brand" /> Password
            </div>
          ) : (
            <Toggle
              checked={resetPw}
              onChange={(v) => {
                setResetPw(v)
                setPw({ a: '', b: '' })
              }}
              label="Reset password"
              description={isSelf ? 'To change your own password with your current one, use “Change password” in the top bar.' : 'Set a temporary password. The user must change it at next sign in.'}
            />
          )}
          {needPw && (
            <div className={cx('grid grid-cols-2 gap-4', !isNew && 'mt-3 border-t border-line pt-3')}>
              <Field label={isNew ? 'Password' : 'New password'} required error={pwErr} hint="At least 6 characters.">
                <div className="relative">
                  <Input type={showPw ? 'text' : 'password'} className="pr-10" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} autoComplete="new-password" />
                  <button
                    type="button"
                    className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-muted hover:text-ink"
                    title={showPw ? 'Hide password' : 'Show password'}
                    onClick={(e) => {
                      e.preventDefault()
                      setShowPw(!showPw)
                    }}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
              <Field label="Confirm password" required error={pw2Err}>
                <Input type={showPw ? 'text' : 'password'} value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} autoComplete="new-password" onKeyDown={(e) => e.key === 'Enter' && save()} />
              </Field>
              <div className="col-span-2 text-[12px] text-muted">The user will be asked to choose their own password the next time they sign in.</div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/* =============================================== Roles =============================================== */

interface RoleDraft {
  id?: number
  name: string
  description: string
  permissions: string[]
}

const snapshot = (d: RoleDraft | null): string => (d ? JSON.stringify({ n: d.name.trim(), d: d.description.trim(), p: [...d.permissions].sort() }) : '')

function RolesTab(): JSX.Element {
  const roles = useLoad(() => api<Role[]>('roles.list'), [])
  const cat = useLoad(() => api<PermGroup[]>('permissions.catalogue'), [])
  const [draft, setDraft] = useState<RoleDraft | null>(null)
  const [orig, setOrig] = useState('')
  const [busy, setBusy] = useState(false)
  const list = roles.data ?? []
  const groups = cat.data ?? []
  const allKeys = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.key)), [groups])
  const current = draft?.id ? list.find((r) => r.id === draft.id) : undefined
  const isOwnerRole = current?.name === OWNER_ROLE_NAME
  const readOnly = isOwnerRole
  const dirty = !!draft && snapshot(draft) !== orig

  const open = (r: Role | null, base?: RoleDraft): void => {
    const d: RoleDraft = base ?? (r ? { id: r.id, name: r.name, description: r.description ?? '', permissions: [...r.permissions] } : { name: '', description: '', permissions: [] })
    setDraft(d)
    setOrig(base ? '' : snapshot(d))
  }

  // Select the first role once loaded.
  useEffect(() => {
    if (!draft && list.length) open(list[0])
  }, [list]) // eslint-disable-line react-hooks/exhaustive-deps

  const guard = async (): Promise<boolean> => {
    if (!dirty) return true
    return confirmDialog({ title: 'Discard unsaved changes?', message: 'You have changed this role but not saved it.', confirmLabel: 'Discard changes', danger: true })
  }

  const select = async (r: Role): Promise<void> => {
    if (draft?.id === r.id) return
    if (await guard()) open(r)
  }

  const startNew = async (copyFrom?: Role): Promise<void> => {
    if (!(await guard())) return
    open(null, copyFrom ? { name: `${copyFrom.name} (copy)`, description: copyFrom.description ?? '', permissions: copyFrom.name === OWNER_ROLE_NAME ? [...allKeys] : [...copyFrom.permissions] } : { name: '', description: '', permissions: ['dashboard.view'] })
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim()) return toast.error('Role name is required.')
    setBusy(true)
    try {
      const id = await api<number>('roles.save', { id: draft.id, name: draft.name.trim(), description: draft.description.trim(), permissions: draft.permissions })
      toast.ok(draft.id ? 'Role saved. Users with this role get the new permissions right away.' : 'Role created.')
      const saved = { ...draft, id, name: draft.name.trim(), description: draft.description.trim() }
      setDraft(saved)
      setOrig(snapshot(saved))
      await roles.reload()
      await useApp.getState().refresh() // the current user's own permissions may have changed
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!current) return
    const ok = await confirmDialog({ title: `Delete role “${current.name}”?`, message: 'This custom role will be removed permanently. This cannot be undone.', danger: true, confirmLabel: 'Delete role' })
    if (!ok) return
    try {
      await api('roles.delete', { id: current.id })
      toast.ok('Role deleted.')
      setDraft(null)
      setOrig('')
      await roles.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const has = (k: string): boolean => readOnly || !!draft?.permissions.includes(k)
  const setPerm = (keys: string[], on: boolean): void =>
    setDraft((d) => (d ? { ...d, permissions: on ? [...new Set([...d.permissions, ...keys])] : d.permissions.filter((p) => !keys.includes(p)) } : d))

  if (roles.loading && !roles.data) return <Loading />

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      <Card
        title="Roles"
        pad={false}
        actions={
          <Button size="sm" variant="soft" icon={<Plus className="h-4 w-4" />} onClick={() => startNew()}>
            New role
          </Button>
        }
      >
        <div className="max-h-[calc(100vh-280px)] overflow-y-auto p-1.5">
          {list.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => select(r)}
              className={cx('mb-1 flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 text-left transition', draft?.id === r.id ? 'bg-brand-soft' : 'hover:bg-surface-2')}
            >
              <div className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', r.name === OWNER_ROLE_NAME ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-brand')}>
                {r.name === OWNER_ROLE_NAME ? <Crown className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className={cx('truncate font-semibold', draft?.id === r.id && 'text-brand')}>{r.name}</div>
                <div className="truncate text-[11.5px] text-muted">{r.description || 'No description'}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone="muted">
                    {r.user_count} user{r.user_count === 1 ? '' : 's'}
                  </Badge>
                  {r.is_system ? <Badge tone="info">Built-in</Badge> : <Badge tone="brand">Custom</Badge>}
                </div>
              </div>
            </button>
          ))}
          {draft && !draft.id && (
            <div className="mb-1 flex items-center gap-3 rounded-lg bg-brand-soft px-3 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-brand">
                <Plus className="h-4 w-4" />
              </div>
              <div className="font-semibold text-brand">{draft.name.trim() || 'New role'} (unsaved)</div>
            </div>
          )}
        </div>
      </Card>

      {!draft ? (
        <Card>
          <Empty icon={<UserCog />} title="Select a role">Choose a role on the left to see and edit its permissions, or create a new custom role.</Empty>
        </Card>
      ) : (
        <Card pad={false}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <div className="flex items-center gap-2 text-[16px] font-semibold">
                {draft.id ? draft.name || 'Role' : 'New custom role'}
                {current && (current.is_system ? <Badge tone="info">Built-in</Badge> : <Badge tone="brand">Custom</Badge>)}
              </div>
              <div className="text-[12.5px] text-muted">
                {readOnly ? 'Full access to everything' : `${draft.permissions.filter((p) => allKeys.includes(p)).length} of ${allKeys.length} permissions`}
                {current ? ` · assigned to ${current.user_count} user${current.user_count === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {current && (
                <Button size="sm" icon={<CopyPlus className="h-4 w-4" />} onClick={() => startNew(current)}>
                  Duplicate
                </Button>
              )}
              {current && !current.is_system && (
                <span title={current.user_count > 0 ? 'Assign these users to another role first' : undefined}>
                  <Button size="sm" variant="ghost" className="text-bad" icon={<Trash2 className="h-4 w-4" />} disabled={current.user_count > 0} onClick={remove}>
                    Delete
                  </Button>
                </span>
              )}
              {!readOnly && dirty && (
                <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => (current ? open(current) : list[0] ? open(list[0]) : setDraft(null))}>
                  {current ? 'Discard' : 'Cancel'}
                </Button>
              )}
              {!readOnly && (
                <Button size="sm" variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} disabled={!dirty} onClick={save}>
                  {draft.id ? 'Save role' : 'Create role'}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-4 p-4">
            {readOnly && (
              <div className="flex items-start gap-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px]">
                <Crown className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <div>
                  <b>Super Administrator</b> always has full access to every feature and every firm. It cannot be edited or restricted. Use <b>Duplicate</b> to create a limited copy.
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
              <Field label="Role name" required>
                <Input value={draft.name} disabled={readOnly} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Store Keeper" />
              </Field>
              <Field label="Description">
                <Textarea rows={1} value={draft.description} disabled={readOnly} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What is this role for?" />
              </Field>
            </div>

            {!readOnly && (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span className="text-muted">Quick select:</span>
                <Button size="sm" variant="ghost" onClick={() => setPerm(allKeys, true)}>
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPerm(allKeys, false)}>
                  Clear all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPerm(allKeys.filter((k) => k.endsWith('.view')), true)}>
                  Add all “view” permissions
                </Button>
              </div>
            )}

            {cat.loading && !cat.data ? (
              <Loading />
            ) : (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {groups.map((g) => {
                  const keys = g.items.map((i) => i.key)
                  const n = keys.filter(has).length
                  const all = n === keys.length
                  return (
                    <div key={g.group} className="rounded-xl border border-line">
                      <div className="flex items-center justify-between gap-3 rounded-t-xl border-b border-line bg-surface-2 px-3 py-2">
                        <label className={cx('flex items-center gap-2 font-semibold select-none', readOnly ? 'cursor-default' : 'cursor-pointer')}>
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--brand)]"
                            checked={all}
                            disabled={readOnly}
                            ref={(el) => {
                              if (el) el.indeterminate = n > 0 && !all
                            }}
                            onChange={(e) => setPerm(keys, e.target.checked)}
                          />
                          {g.group}
                        </label>
                        <span className={cx('text-[11.5px] font-semibold', all ? 'text-ok' : n ? 'text-warn' : 'text-muted')}>
                          {n}/{keys.length}
                        </span>
                      </div>
                      <div className="space-y-1.5 px-3 py-2.5">
                        {g.items.map((it) => (
                          <div key={it.key} className="flex items-start justify-between gap-3">
                            <Checkbox checked={has(it.key)} disabled={readOnly} onChange={(v) => setPerm([it.key], v)} label={<span className="text-[13px]">{it.label}</span>} />
                            <code className="shrink-0 pt-0.5 text-[10.5px] text-muted">{it.key}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

/* =============================================== Audit log =============================================== */

interface AuditRow {
  id: number
  ts: string
  user_id: number | null
  username: string | null
  firm_id: number | null
  firm_name: string | null
  action: string
  entity: string | null
  entity_id: number | null
  summary: string | null
  details: string | null
}

const AUDIT_ENTITIES: Array<[string, string]> = [
  ['user', 'Users & sign-ins'],
  ['role', 'Roles'],
  ['firm', 'Firms'],
  ['sequence', 'Document numbering'],
  ['settings', 'Settings'],
  ['tax_rate', 'Tax rates'],
  ['product', 'Products'],
  ['category', 'Product categories'],
  ['warehouse', 'Warehouses'],
  ['stock', 'Stock transfers'],
  ['stock_adjustment', 'Stock adjustments'],
  ['party', 'Customers & suppliers'],
  ['party_adjustment', 'Party adjustments'],
  ['quotation', 'Quotations'],
  ['sale_order', 'Sales orders'],
  ['delivery_challan', 'Delivery challans'],
  ['sale_invoice', 'Sales invoices'],
  ['sale_return', 'Sales returns'],
  ['purchase_order', 'Purchase orders'],
  ['purchase_invoice', 'Purchase invoices'],
  ['purchase_return', 'Purchase returns'],
  ['document', 'Documents (advances)'],
  ['payment', 'Payments & receipts'],
  ['account', 'Cash / bank accounts'],
  ['transfer', 'Account transfers'],
  ['expense', 'Expenses'],
  ['expense_category', 'Expense categories'],
  ['project', 'Solar projects'],
  ['material_issue', 'Material issues'],
  ['material_return', 'Material returns'],
  ['attachment', 'Attachments'],
  ['system', 'System (backup, restore, setup)']
]

function actionTone(a: string): string {
  if (a === 'create' || a === 'login' || a === 'setup') return 'ok'
  if (a === 'update' || a === 'status' || a === 'allocate' || a === 'attach' || a === 'transfer' || a === 'switch_firm') return 'info'
  if (a === 'delete' || a === 'cancel' || a === 'login_failed' || a === 'restore') return 'bad'
  if (a === 'deactivate' || a === 'password_reset' || a === 'password_change') return 'warn'
  if (a === 'logout' || a === 'backup') return 'muted'
  return 'brand'
}

function parseDetails(s: string | null): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

const AUDIT_EXPORT_CAP = 20000

function AuditTab(): JSX.Element {
  const can = useCan()
  const [range, setRange] = useState<[string, string]>(() => PERIODS.find((p) => p.key === 'month')!.range())
  const [userId, setUserId] = useState('')
  const [entity, setEntity] = useState('')
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [size, setSize] = useState(50)
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<AuditRow | null>(null)
  const [exporting, setExporting] = useState(false)
  const people = useLoad(() => api<Array<{ id: number; full_name: string; username: string }>>(can('users.manage') ? 'users.list' : 'users.basic'), [])

  // Debounce the free-text search. Any filter change starts again from the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      const v = text.trim()
      if (v === q) return
      setQ(v)
      setOffset(0)
    }, 350)
    return () => clearTimeout(t)
  }, [text, q])

  const filters = { from: range[0], to: range[1], userId: userId ? Number(userId) : undefined, entity: entity || undefined, q: q || undefined }
  const { data, loading } = useLoad(() => api<{ rows: AuditRow[]; total: number }>('audit.list', { ...filters, limit: size, offset }), [range[0], range[1], userId, entity, q, size, offset])
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const page = Math.floor(offset / size)
  const pages = Math.max(1, Math.ceil(total / size))

  const exportAll = async (): Promise<void> => {
    setExporting(true)
    try {
      const all: AuditRow[] = []
      for (let off = 0; off < Math.min(total, AUDIT_EXPORT_CAP); off += 500) {
        const r = await api<{ rows: AuditRow[] }>('audit.list', { ...filters, limit: 500, offset: off })
        all.push(...r.rows)
        if (r.rows.length < 500) break
      }
      const file = await api<string | null>('export.csv', {
        filename: 'Audit log',
        columns: [
          { key: 'ts', label: 'Time' },
          { key: 'username', label: 'User' },
          { key: 'firm_name', label: 'Firm' },
          { key: 'action', label: 'Action' },
          { key: 'entity', label: 'Entity' },
          { key: 'entity_id', label: 'Entity ID' },
          { key: 'summary', label: 'Summary' },
          { key: 'details', label: 'Details' }
        ],
        rows: all
      })
      if (file) toast.ok(total > AUDIT_EXPORT_CAP ? `Exported the latest ${all.length} entries to ${file}` : `Exported ${all.length} entries to ${file}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setExporting(false)
    }
  }

  const cols: Array<Column<AuditRow>> = [
    { key: 'ts', header: 'Time', sortable: false, render: (r) => <span className="whitespace-nowrap">{dateTime(r.ts)}</span> },
    { key: 'username', header: 'User', sortable: false, render: (r) => <span className="font-medium">{r.username ?? '—'}</span> },
    { key: 'firm_name', header: 'Firm', sortable: false, render: (r) => <span className="block max-w-[160px] truncate text-muted">{r.firm_name ?? '—'}</span> },
    { key: 'action', header: 'Action', sortable: false, render: (r) => <Badge tone={actionTone(r.action)}>{label(r.action)}</Badge> },
    {
      key: 'entity',
      header: 'Entity',
      sortable: false,
      render: (r) => (
        <span className="whitespace-nowrap">
          {r.entity ? label(r.entity) : '—'}
          {r.entity_id ? <span className="text-muted"> #{r.entity_id}</span> : null}
        </span>
      )
    },
    {
      key: 'summary',
      header: 'Summary',
      sortable: false,
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="block max-w-[460px] truncate" title={r.summary ?? ''}>
            {r.summary ?? '—'}
          </span>
          {r.details && <Badge tone="muted">details</Badge>}
        </div>
      )
    }
  ]

  const parsed = detail ? parseDetails(detail.details) : null
  const pretty = parsed === null ? '' : typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)

  return (
    <div className="space-y-3">
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <PeriodPicker
            from={range[0]}
            to={range[1]}
            onChange={(a, b) => {
              setRange([a, b])
              setOffset(0)
            }}
          />
          <Select
            sm
            className="w-44"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value)
              setOffset(0)
            }}
          >
            <option value="">All users</option>
            {(people.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} ({u.username})
              </option>
            ))}
          </Select>
          <Select
            sm
            className="w-52"
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value)
              setOffset(0)
            }}
          >
            <option value="">All entities</option>
            {AUDIT_ENTITIES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input sm className="pl-8" placeholder="Search summary, action, user…" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} loading={exporting} disabled={!total} onClick={exportAll}>
            Export
          </Button>
        </div>
      </Card>

      <DataTable
        rows={rows}
        columns={cols}
        loading={loading && !data}
        searchable={false}
        pageSize={1000}
        dense
        rowKey={(r) => r.id}
        onRowClick={setDetail}
        empty={<Empty icon={<ScrollText />} title="No activity found">Try a wider date range or clear the filters.</Empty>}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 text-[12.5px] text-muted">
        <span>{total ? `${offset + 1}–${Math.min(total, offset + rows.length)} of ${total.toLocaleString()} entries` : 'No entries'}</span>
        <div className="flex items-center gap-2">
          <Select
            sm
            className="w-28"
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value))
              setOffset(0)
            }}
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" disabled={page === 0 || loading} onClick={() => setOffset(Math.max(0, offset - size))} icon={<ChevronLeft className="h-4 w-4" />} />
          <span>
            Page {page + 1} / {pages}
          </span>
          <Button size="sm" variant="ghost" disabled={page >= pages - 1 || loading} onClick={() => setOffset(offset + size)} icon={<ChevronRight className="h-4 w-4" />} />
        </div>
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        size="lg"
        title={detail ? `${label(detail.action)}${detail.entity ? ` · ${label(detail.entity)}` : ''}${detail.entity_id ? ` #${detail.entity_id}` : ''}` : ''}
        subtitle={detail ? dateTime(detail.ts) : undefined}
        footer={
          <>
            {pretty && (
              <Button
                icon={<Copy className="h-4 w-4" />}
                onClick={() =>
                  navigator.clipboard
                    .writeText(pretty)
                    .then(() => toast.ok('Details copied to clipboard.'))
                    .catch(toast.error)
                }
              >
                Copy details
              </Button>
            )}
            <Button variant="primary" onClick={() => setDetail(null)}>
              Close
            </Button>
          </>
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-8 rounded-xl border border-line px-4 py-2">
              <Kv label="Time">{dateTime(detail.ts)}</Kv>
              <Kv label="User">{detail.username ?? '—'}</Kv>
              <Kv label="Firm">{detail.firm_name ?? '—'}</Kv>
              <Kv label="Action">
                <Badge tone={actionTone(detail.action)}>{label(detail.action)}</Badge>
              </Kv>
              <Kv label="Entity">{detail.entity ? label(detail.entity) : '—'}</Kv>
              <Kv label="Entity ID">{detail.entity_id ?? '—'}</Kv>
            </div>
            <div>
              <div className="mb-1 text-[12.5px] font-medium text-muted">Summary</div>
              <div className="rounded-xl bg-surface-2 px-4 py-3">{detail.summary || '—'}</div>
            </div>
            <div>
              <div className="mb-1 text-[12.5px] font-medium text-muted">Details</div>
              {pretty ? (
                <pre className="max-h-[48vh] overflow-auto rounded-xl border border-line bg-surface-2 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">{pretty}</pre>
              ) : (
                <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">No additional details were recorded for this entry.</div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
