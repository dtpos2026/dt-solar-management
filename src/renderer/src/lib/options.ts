import { useApp } from '../store'
import { optionOn } from '@shared/options'

/** One option (see shared/options.ts): Standard mode always gives its standard value. */
export function useOption(key: string): boolean {
  return useApp((s) => optionOn(s.settings, key))
}

/** Several options in one component: const opt = useOptions(); opt('doc.tax') */
export function useOptions(): (key: string) => boolean {
  const settings = useApp((s) => s.settings)
  return (key) => optionOn(settings, key)
}
