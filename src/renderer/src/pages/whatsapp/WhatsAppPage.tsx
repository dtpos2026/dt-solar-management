/** WhatsApp module: WhatsApp Web (linked device, QR scan) inside the app (owner: assist area). */
import { MessageCircle } from 'lucide-react'
import { Card, PageHeader } from '../../components/ui'

export function WhatsAppPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <PageHeader title="WhatsApp" subtitle="Link your WhatsApp by scanning the QR code, then send invoices and quotations" icon={<MessageCircle className="h-5 w-5" />} />
      <Card>WhatsApp is being prepared.</Card>
    </div>
  )
}
