/** Day & month closing (owner: data area). */
import { CalendarCheck } from 'lucide-react'
import { Card, PageHeader } from '../../components/ui'

export function ClosingPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <PageHeader title="Day & Month Closing" subtitle="Close the day, count cash and keep a closing backup" icon={<CalendarCheck className="h-5 w-5" />} />
      <Card>Closing is being prepared.</Card>
    </div>
  )
}
