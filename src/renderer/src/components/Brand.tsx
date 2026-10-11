import { VENDOR } from '@shared/branding'
import appIcon from '../assets/app-icon.png'

export function DtMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 264 264" className={className} aria-hidden>
      <g fill="currentColor">
        <polygon points="0,0 132,0 132,132" />
        <polygon points="132,0 264,0 264,132" />
        <polygon points="0,132 132,132 132,264" />
        <polygon points="132,132 264,132 264,264" />
      </g>
    </svg>
  )
}

export function AppLogo({ size = 44, light }: { size?: number; light?: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <img src={appIcon} style={{ width: size, height: size }} className="rounded-xl shadow-md" alt="" />
      <div className="leading-tight">
        <div className={light ? 'text-[20px] font-extrabold text-white' : 'text-[20px] font-extrabold'}>
          DT Solar <span className="text-sun">Pro</span>
        </div>
        <div className={light ? 'text-[11.5px] text-white/75' : 'text-[11.5px] text-muted'}>{VENDOR.tagline}</div>
      </div>
    </div>
  )
}

export function VendorLine({ light }: { light?: boolean }): JSX.Element {
  return (
    <div className={light ? 'flex items-center gap-2 text-[12px] text-white/80' : 'flex items-center gap-2 text-[12px] text-muted'}>
      <DtMark className="h-4 w-4" />
      <span>
        Developed by <b className="tracking-wider">DIGITAL TARGET</b> · {VENDOR.phone} · {VENDOR.email}
      </span>
    </div>
  )
}
