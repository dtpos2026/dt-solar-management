/** Public invoice verification page opened from the invoice QR code (owner: portal-billing agent). No login. */
export function VerifyInvoice({ token }: { token: string }) {
  return <div className="p-8 text-center">Verifying invoice {token.slice(0, 4)}…</div>
}
