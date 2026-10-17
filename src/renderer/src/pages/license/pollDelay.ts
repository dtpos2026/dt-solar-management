/**
 * How long to wait before asking Digital Target again about a pending activation: quick at first (an approval or a freed
 * slot should show up within seconds), then gentler, so a request that waits for days does not burn the free Firestore
 * read quota (one read per poll).
 */
export function pollDelay(elapsedMs: number): number {
  if (elapsedMs < 2 * 60_000) return 3_000
  if (elapsedMs < 10 * 60_000) return 10_000
  return 30_000
}
