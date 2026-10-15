/** PIN entry + user avatar shared by the sign-in screen, the lock screen and the Users page (owner: access area). */
import { forwardRef, useEffect, useRef } from 'react'
import { cx } from '../../components/ui'

export const PIN_RE = /^\d{4,6}$/

/** Masked numeric field for a 4–6 digit PIN, with a dot indicator. Non-digits are ignored. */
export const PinInput = forwardRef<HTMLInputElement, {
  value: string
  onChange: (v: string) => void
  onEnter?: () => void
  autoFocus?: boolean
  disabled?: boolean
  invalid?: boolean
  label?: string
  size?: 'md' | 'lg'
}>(function PinInput({ value, onChange, onEnter, autoFocus, disabled, invalid, label = 'PIN', size = 'lg' }, ref) {
  const inner = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (autoFocus && !disabled) inner.current?.focus()
  }, [autoFocus, disabled])
  return (
    <div>
      <input
        ref={(el) => {
          inner.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        placeholder={label}
        maxLength={6}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        className={cx(
          'input text-center font-semibold placeholder:font-normal placeholder:tracking-normal',
          size === 'lg' ? 'h-12 text-[22px] tracking-[0.6em]' : 'h-10 text-[17px] tracking-[0.45em]',
          invalid && 'border-bad'
        )}
      />
      <div className="mt-2 flex justify-center gap-2" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className={cx('h-2 w-2 rounded-full transition', i < value.length ? 'bg-brand' : i < 4 ? 'bg-line' : 'border border-line')} />
        ))}
      </div>
    </div>
  )
})

const AVATAR_TONES = [
  'from-[#2f5bea] to-[#1d3fb8]',
  'from-[#0ea5a4] to-[#0b7f7e]',
  'from-[#f59e0b] to-[#d97706]',
  'from-[#8b5cf6] to-[#6d28d9]',
  'from-[#ef4444] to-[#b91c1c]',
  'from-[#10b981] to-[#047857]'
]

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?'
  )
}

export function Avatar({ name, id, size = 44 }: { name: string; id: number; size?: number }): JSX.Element {
  return (
    <span
      className={cx('flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white', AVATAR_TONES[Math.abs(id) % AVATAR_TONES.length])}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initialsOf(name)}
    </span>
  )
}
