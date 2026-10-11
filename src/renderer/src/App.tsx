import { useCallback, useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { api, onApiError } from './api'
import { useApp, LicenseStatus } from './store'
import { DialogHost, Loading, Toaster } from './components/ui'
import { Shell } from './components/Shell'
import { SetupWizard } from './pages/auth/Setup'
import { Login } from './pages/auth/Login'
import { FatalError } from './pages/auth/FatalError'
import { PrintView } from './print/PrintView'
import { Dashboard } from './pages/Dashboard'
import { SalesPage, PurchasesPage, QuotationsPage } from './pages/docs/DocumentLists'
import { DocumentEditor } from './pages/docs/DocumentEditor'
import { DocumentView } from './pages/docs/DocumentView'
import { InventoryPage } from './pages/inventory/InventoryPage'
import { PartiesPage } from './pages/parties/PartiesPage'
import { PartyDetail } from './pages/parties/PartyDetail'
import { ProjectsPage } from './pages/projects/ProjectsPage'
import { ProjectDetail } from './pages/projects/ProjectDetail'
import { AccountsPage } from './pages/accounts/AccountsPage'
import { ExpensesPage } from './pages/expenses/ExpensesPage'
import { ReportsPage } from './pages/reports/ReportsPage'
import { UsersPage } from './pages/users/UsersPage'
import { MultiFirmPage } from './pages/firms/MultiFirmPage'
import { SettingsPage } from './pages/settings/SettingsPage'
import { BackupPage } from './pages/backup/BackupPage'
import { LicensePage } from './pages/license/LicensePage'

interface AppInfo {
  version: string
  dbError: string | null
  hasUsers: boolean
  license: LicenseStatus | null
  session: { locked: boolean } | null
}

function Boot(): JSX.Element {
  const loc = useLocation()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [authed, setAuthed] = useState<boolean | null>(null)
  const { refresh, setLicense, setLocked, clear } = useApp()

  const load = useCallback(async () => {
    const i = await api<AppInfo>('app.info')
    setInfo(i)
    useApp.setState({ version: i.version })
    if (i.license) setLicense(i.license)
    if (i.session) {
      try {
        await refresh()
        setLocked(i.session.locked)
        setAuthed(true)
      } catch {
        setAuthed(false)
      }
    } else setAuthed(false)
  }, [refresh, setLicense, setLocked])

  useEffect(() => {
    load()
    const off1 = window.dt.onLicense((s) => setLicense(s as LicenseStatus))
    const off2 = onApiError((e) => {
      if (e.code === 'LOCKED') setLocked(true)
      if (e.code === 'AUTH_REQUIRED') {
        clear()
        setAuthed(false)
      }
    })
    return () => {
      off1()
      off2()
    }
  }, [load, setLicense, setLocked, clear])

  // Print windows share the session; they never show the shell.
  if (loc.pathname.startsWith('/print/')) {
    return <Routes><Route path="/print/:kind/:id" element={<PrintView />} /></Routes>
  }
  if (!info || authed === null) return <div className="flex h-full items-center justify-center"><Loading label="Starting DT Solar Pro…" /></div>
  if (info.dbError) return <FatalError message={info.dbError} />
  if (!info.hasUsers) return <SetupWizard onDone={() => load()} />
  if (!authed) return <Login onDone={() => load()} />

  return (
    <Shell onLogout={() => { clear(); setAuthed(false) }}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/quotations" element={<QuotationsPage />} />
        <Route path="/purchases" element={<PurchasesPage />} />
        <Route path="/doc/new/:type" element={<DocumentEditor />} />
        <Route path="/doc/:id" element={<DocumentView />} />
        <Route path="/doc/:id/edit" element={<DocumentEditor />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/customers" element={<PartiesPage type="customer" />} />
        <Route path="/suppliers" element={<PartiesPage type="supplier" />} />
        <Route path="/party/:id" element={<PartyDetail />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/firms" element={<MultiFirmPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/license" element={<LicensePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  )
}

export function App(): JSX.Element {
  return (
    <HashRouter>
      <Boot />
      <Toaster />
      <DialogHost />
    </HashRouter>
  )
}
