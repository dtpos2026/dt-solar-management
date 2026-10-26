import { useCallback, useEffect, useState, type ReactNode } from 'react'
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
import { CrmPage } from './pages/crm/CrmPage'
import { HelpPage } from './pages/help/HelpPage'
import { WhatsAppPage } from './pages/whatsapp/WhatsAppPage'
import { ClosingPage } from './pages/closing/ClosingPage'
import { useOption } from './lib/options'
import { moduleOn } from '@shared/modules'
import { PosPage } from './pages/pos/PosPage'
import { LicenseBlockedScreen } from './pages/license/LicenseBlockedScreen'
import { isFullyBlocked } from '@shared/licenseBlock'

interface AppInfo {
  version: string
  dbError: string | null
  hasUsers: boolean
  license: LicenseStatus | null
  session: { locked: boolean } | null
}

/** A module switched off in Customizable mode: its screen is not reachable (its data is kept). */
function Gate({ opt, children }: { opt: string; children: ReactNode }): JSX.Element {
  return useOption(opt) ? <>{children}</> : <Navigate to="/" replace />
}

/** A POS / ERP module that is switched off (Settings, Simple / Customize): no screen, the data is kept. */
function ModGate({ mod, children }: { mod: string; children: ReactNode }): JSX.Element {
  const on = useApp((s) => moduleOn(s.settings, mod))
  return on ? <>{children}</> : <Navigate to="/" replace />
}

function Boot(): JSX.Element {
  const loc = useLocation()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [authed, setAuthed] = useState<boolean | null>(null)
  const { refresh, setLicense, setLocked, clear, license } = useApp()

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
  // Suspended / revoked / deactivated / expired / unverifiable: no modules, only the status screen (backend refuses the data routes too).
  if (isFullyBlocked(license)) {
    return <LicenseBlockedScreen license={license!} onLogout={() => { api('auth.logout').catch(() => undefined); clear(); setAuthed(false) }} />
  }

  return (
    <Shell onLogout={() => { clear(); setAuthed(false) }}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/quotations" element={<Gate opt="mod.quotations"><QuotationsPage /></Gate>} />
        <Route path="/purchases" element={<Gate opt="mod.purchases"><PurchasesPage /></Gate>} />
        <Route path="/doc/new/:type" element={<DocumentEditor />} />
        <Route path="/doc/:id" element={<DocumentView />} />
        <Route path="/doc/:id/edit" element={<DocumentEditor />} />
        <Route path="/inventory" element={<Gate opt="item.enabled"><InventoryPage /></Gate>} />
        <Route path="/customers" element={<PartiesPage type="customer" />} />
        <Route path="/suppliers" element={<PartiesPage type="supplier" />} />
        <Route path="/party/:id" element={<PartyDetail />} />
        <Route path="/projects" element={<Gate opt="mod.projects"><ProjectsPage /></Gate>} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/accounts" element={<Gate opt="mod.accounts"><AccountsPage /></Gate>} />
        <Route path="/expenses" element={<Gate opt="mod.expenses"><ExpensesPage /></Gate>} />
        <Route path="/reports" element={<Gate opt="mod.reports"><ReportsPage /></Gate>} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/firms" element={<MultiFirmPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/license" element={<Navigate to="/settings?tab=license" replace />} />
        <Route path="/closing" element={<Gate opt="mod.closing"><ClosingPage /></Gate>} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/whatsapp" element={<Gate opt="mod.whatsapp"><WhatsAppPage /></Gate>} />
        <Route path="/crm" element={<Gate opt="mod.crm"><CrmPage /></Gate>} />
        <Route path="/pos" element={<ModGate mod="pos"><PosPage /></ModGate>} />
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
