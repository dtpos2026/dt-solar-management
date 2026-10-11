export interface ThemeDef {
  key: string
  name: string
  dark?: boolean
  swatch: [string, string, string]
}

export const THEMES: ThemeDef[] = [
  { key: 'solar', name: 'Solar Blue', swatch: ['#0f1d45', '#2f5bea', '#f3f6fb'] },
  { key: 'wetco', name: 'WETCO Blue & Sun', swatch: ['#0b3f70', '#0d60a6', '#f7931e'] },
  { key: 'digital', name: 'Digital Target Purple', swatch: ['#2b0750', '#5b21b6', '#efe7ff'] },
  { key: 'emerald', name: 'Emerald Green', swatch: ['#063b2f', '#059669', '#e3f8f0'] },
  { key: 'sunset', name: 'Sunset Orange', swatch: ['#3b1606', '#ea580c', '#fff0e6'] },
  { key: 'midnight', name: 'Midnight (Dark)', dark: true, swatch: ['#0a0f1b', '#4f7cff', '#151c2f'] },
  { key: 'graphite', name: 'Graphite Solar (Dark)', dark: true, swatch: ['#0c0c0d', '#f7931e', '#1c1c1e'] }
]

const KEY = 'dt-theme'

export function getTheme(): string {
  try {
    return localStorage.getItem(KEY) || 'solar'
  } catch {
    return 'solar'
  }
}

export function applyTheme(key: string): void {
  const t = THEMES.find((x) => x.key === key) ? key : 'solar'
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* storage unavailable */
  }
}
