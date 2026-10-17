/** Version helpers shared by the desktop app (and mirrored in the Super Admin panel): dotted numbers, no pre-release tags. */
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

export interface VersionInfo {
  installed: string
  latest: string
  minimum: string
  notes: string
  url: string
  checkedAt: string | null
  /** A newer version than the installed one exists. */
  updateAvailable: boolean
  /** The installed version is below the minimum supported version. */
  updateRequired: boolean
}

export function describeVersion(installed: string, published: { latest?: string; minimum?: string; notes?: string; url?: string; checkedAt?: string | null } | null): VersionInfo {
  const latest = published?.latest ?? ''
  const minimum = published?.minimum ?? ''
  return {
    installed,
    latest,
    minimum,
    notes: published?.notes ?? '',
    url: published?.url ?? '',
    checkedAt: published?.checkedAt ?? null,
    updateAvailable: !!latest && compareVersions(installed, latest) === -1,
    updateRequired: !!minimum && compareVersions(installed, minimum) === -1
  }
}
