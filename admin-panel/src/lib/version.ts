/** Software versions: dotted numbers (1.5.0). The latest published version lives in publicSettings/version (public read, branding.manage write). */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/** -1 / 0 / 1; null when either side is not a version (nothing is claimed then). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

export interface PublishedVersion {
  latest: string
  minimum: string
  notes: string
  url: string
}

export const EMPTY_VERSION: PublishedVersion = { latest: '', minimum: '', notes: '', url: '' }

export function validateVersion(v: PublishedVersion): string | null {
  if (!v.latest.trim()) return 'Enter the latest version, for example 1.5.0.'
  if (!parseVersion(v.latest)) return 'The latest version must look like 1.5.0.'
  if (v.minimum.trim() && !parseVersion(v.minimum)) return 'The minimum version must look like 1.4.0, or be empty.'
  if (v.minimum.trim() && compareVersions(v.minimum, v.latest) === 1) return 'The minimum version cannot be higher than the latest version.'
  if (v.url.trim() && !/^https:\/\/\S+$/.test(v.url.trim())) return 'The download link must start with https://.'
  if (v.notes.length > 500) return 'Release notes are limited to 500 characters.'
  return null
}

/** Where one computer stands against the published versions. */
export type VersionState = 'current' | 'update' | 'required' | 'unknown'

export function versionState(installed: string, published: PublishedVersion | null): VersionState {
  if (!published?.latest || !parseVersion(installed)) return 'unknown'
  if (published.minimum && compareVersions(installed, published.minimum) === -1) return 'required'
  return compareVersions(installed, published.latest) === -1 ? 'update' : 'current'
}
