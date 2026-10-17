import { AlertOctagon } from 'lucide-react'
import { VendorLine } from '../../components/Brand'

export function FatalError({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="card max-w-xl p-8">
        <AlertOctagon className="mb-3 h-10 w-10 text-bad" />
        <div className="text-[20px] font-bold">The database could not be opened</div>
        <div className="mt-2 text-muted">{message}</div>
        <div className="mt-5 space-y-2 text-[13.5px]">
          <div className="font-semibold">What you can do:</div>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Close the application completely and start it again.</li>
            <li>Make sure the disk is not full and that you have permission to write to your user folder.</li>
            <li>If the problem continues, do not delete anything. Contact Digital Target support - your automatic backups are in <b>Documents\DT Solar Pro Backups</b> and can be restored.</li>
          </ol>
        </div>
        <div className="mt-6"><VendorLine /></div>
      </div>
    </div>
  )
}
