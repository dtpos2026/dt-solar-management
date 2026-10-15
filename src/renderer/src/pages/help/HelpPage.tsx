/** Help & Support: offline Urdu / English help assistant (owner: assist area). */
import { LifeBuoy } from 'lucide-react'
import { Card, PageHeader } from '../../components/ui'

export function HelpPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <PageHeader title="Help & Support" subtitle="Step-by-step answers in Urdu and English" icon={<LifeBuoy className="h-5 w-5" />} />
      <Card>Help is being prepared.</Card>
    </div>
  )
}
