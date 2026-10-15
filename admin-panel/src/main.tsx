import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { VerifyInvoice } from './pages/public/VerifyInvoice'

// Public invoice verification (QR code): https://<host>/v/<token> — no login, no admin code paths.
const verify = window.location.pathname.match(/^\/v\/([A-Za-z0-9_-]{16,64})\/?$/)

createRoot(document.getElementById('root')!).render(<StrictMode>{verify ? <VerifyInvoice token={verify[1]} /> : <App />}</StrictMode>)
