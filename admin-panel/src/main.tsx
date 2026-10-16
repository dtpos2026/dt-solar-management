import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { VerifyInvoice } from './pages/public/VerifyInvoice'

// Public invoice verification (QR code): https://<host>/v/<token> — no login, no admin code paths.
// Any /v/<something> path is handled by the public page (malformed tokens show "Invalid invoice").
const verify = window.location.pathname.match(/^\/v\/([^/]*)\/?$/)

createRoot(document.getElementById('root')!).render(<StrictMode>{verify ? <VerifyInvoice token={verify[1]} /> : <App />}</StrictMode>)
