import { it } from 'vitest'
import { HELP_ARTICLES } from '../src/shared/help/kb'
import { buildIndex, search, queryTerms } from '../src/shared/help/search'
it('d', () => {
  const ix = buildIndex(HELP_ARTICLES)
  for (const q of (process.env.Q ?? '').split('|')) {
    const r = search(ix, q)
    console.log('Q:', q, JSON.stringify(queryTerms(ix, q)), r.hits.slice(0, 3).map((h) => `${h.article.id} ${h.score.toFixed(2)} ${h.coverage.toFixed(2)}`))
  }
})
