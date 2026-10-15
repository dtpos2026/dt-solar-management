/** QR code helper (qrcode package -> PNG data URL). */
import QRCode from 'qrcode'

export function qrDataUrl(text: string, size = 220): Promise<string> {
  return QRCode.toDataURL(text, { width: size, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1a0633', light: '#ffffff' } })
}

export function verifyUrl(token: string, verifyBaseUrl?: string): string {
  const base = (verifyBaseUrl || window.location.origin).replace(/\/+$/, '')
  return `${base}/v/${token}`
}
