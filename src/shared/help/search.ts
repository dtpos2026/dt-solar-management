/**
 * Offline help search engine (owner: assist area).
 * - Tokenizer for English, Urdu script and Roman Urdu (normalises Arabic/Urdu letter variants, strips diacritics).
 * - Synonym map: every word is mapped to a canonical concept ("bill", "bil", "انوائس" -> invoice).
 * - BM25 ranking over weighted fields (title > keywords > path > steps), with typo tolerance (edit distance).
 * - Confidence threshold: below it the assistant says it could not find an answer instead of guessing.
 * Pure TypeScript, no network, no Node/Electron APIs (used by the renderer and by unit tests).
 */
import type { HelpArticle } from './kb'

/* ------------------------------ normalisation ------------------------------ */

const URDU_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g
const LETTER_MAP: Record<string, string> = {
  'ي': 'ی', 'ى': 'ی', 'ئ': 'ی', 'ے': 'ی', 'ۓ': 'ی',
  'ك': 'ک', 'ه': 'ہ', 'ة': 'ہ', 'ۃ': 'ہ', 'ھ': 'ہ',
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و', 'ۀ': 'ہ'
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(URDU_DIACRITICS, '')
    .replace(/[يىئےۓكهةۃھأإآٱؤۀ]/g, (c) => LETTER_MAP[c] ?? c)
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
}

/** Words that carry no meaning for search (English, Roman Urdu, Urdu script - normalised forms). */
const STOP = new Set(
  (
    'a an the to of in on for and or is are am be do does did i me my we our you your it this that these those how what where when which who why can could should would will ' +
    'please pls plz with from by at as into about there here want need get show tell using use way kindly ' +
    'kaise kaisay kese kesay kesy kaisy kya kia kyun ka ki ke ko se sy me mein main mai mujhe mujhay hai hain he hy tha thi ho hota hoti karna karni karen kare karein karo kar karte karta ' +
    'lein lain len lena lo liya gaya gya gayi gai hua hui raha rahi rha rhi krna krne kren kro kr apna apni apne yeh ye woh wo is us aur ya bhi koi kuch sakta sakte sakti skta jata jati ' +
    normalize('کیسے کیا کا کی کے کو سے میں ہے ہیں ہو تھا تھی کرنا کرنی کریں کرے کرو کر اپنا اپنی اپنے یہ وہ اس اور یا بھی کوئی کچھ سکتا سکتے مجھے')
  ).split(/\s+/)
)

/**
 * Synonym groups: the first word is the canonical concept; all others (English, Roman Urdu, Urdu script) map to it.
 * Matching is on the normalised form, so Urdu letter variants are covered automatically.
 */
const SYNONYM_GROUPS: string[][] = [
  ['invoice', 'invoices', 'bill', 'bills', 'bil', 'billing', 'انوائس', 'بل', 'بِل'],
  ['create', 'make', 'new', 'add', 'banaye', 'banayen', 'banain', 'banana', 'banao', 'bnaye', 'bnana', 'banaen', 'banaun', 'naya', 'nayi', 'naye', 'dalna', 'daalna', 'dalen', 'shamil', 'بنائیں', 'بنانا', 'بنائے', 'بناؤ', 'نیا', 'نئی', 'نئے', 'شامل', 'ڈالیں'],
  ['item', 'items', 'product', 'products', 'maal', 'mal', 'saman', 'samaan', 'cheez', 'cheezen', 'سامان', 'مال', 'آئٹم', 'پروڈکٹ', 'چیز'],
  ['quotation', 'quotations', 'quote', 'quotes', 'estimate', 'estimates', 'quotaion', 'kotation', 'qoutation', 'کوٹیشن', 'تخمینہ'],
  ['convert', 'conversion', 'change', 'tabdeel', 'tabdil', 'badlo', 'badalna', 'تبدیل', 'بدلیں'],
  ['purchase', 'purchases', 'buy', 'bought', 'khareed', 'kharid', 'khareedari', 'kharidari', 'خرید', 'خریداری'],
  ['sale', 'sales', 'sell', 'sold', 'becha', 'bechna', 'farokht', 'فروخت', 'بیچنا', 'سیل'],
  ['return', 'returns', 'wapas', 'wapsi', 'waapsi', 'واپس', 'واپسی', 'ریٹرن'],
  ['payment', 'payments', 'pay', 'paid', 'paisa', 'paise', 'raqam', 'adaigi', 'adayegi', 'ادائیگی', 'رقم', 'پیسے', 'پیمنٹ'],
  ['receive', 'received', 'collect', 'collection', 'wasool', 'wasooli', 'wasul', 'وصول', 'وصولی'],
  ['customer', 'customers', 'client', 'clients', 'buyer', 'gahak', 'grahak', 'گاہک', 'کسٹمر'],
  ['supplier', 'suppliers', 'vendor', 'vendors', 'dealer', 'سپلائر', 'ڈیلر'],
  ['party', 'parties', 'account holder', 'پارٹی'],
  ['stock', 'inventory', 'godown', 'stok', 'اسٹاک', 'سٹاک', 'انوینٹری', 'گودام'],
  ['category', 'categories', 'group', 'qisam', 'kism', 'قسم', 'کیٹیگری'],
  ['adjustment', 'adjust', 'correct', 'correction', 'theek', 'durust', 'ایڈجسٹمنٹ', 'درست'],
  ['opening', 'shuru', 'ابتدائی', 'اوپننگ'],
  ['serial', 'serials', 'warranty', 'guarantee', 'سیریل', 'وارنٹی'],
  ['project', 'projects', 'site', 'installation', 'pv', 'پروجیکٹ', 'منصوبہ', 'سائٹ'],
  ['solar', 'panel', 'panels', 'سولر', 'پینل'],
  ['profit', 'munafa', 'nafa', 'margin', 'منافع', 'نفع', 'پرافٹ'],
  ['cost', 'costing', 'lagat', 'لاگت', 'خرچ'],
  ['material', 'materials', 'issue', 'issued', 'میٹیریل', 'مٹیریل'],
  ['expense', 'expenses', 'kharche', 'kharcha', 'ikhrajat', 'akhrajat', 'اخراجات', 'خرچہ', 'خرچے'],
  ['account', 'accounts', 'bank', 'cash', 'khata', 'کھاتہ', 'بینک', 'کیش', 'اکاؤنٹ'],
  ['transfer', 'transfers', 'move', 'muntaqil', 'منتقل', 'ٹرانسفر'],
  ['close', 'closing', 'band', 'bandh', 'khatam', 'بند', 'کلوزنگ'],
  ['day', 'din', 'daily', 'roz', 'دن', 'روزانہ'],
  ['month', 'mahina', 'maheena', 'monthly', 'مہینہ', 'ماہانہ'],
  ['report', 'reports', 'riport', 'hisab', 'hisaab', 'رپورٹ', 'حساب'],
  ['print', 'printing', 'chapo', 'chapna', 'چھاپیں', 'پرنٹ'],
  ['pdf', 'پی ڈی ایف'],
  ['printer', 'printers', 'پرنٹر'],
  ['template', 'templates', 'design', 'format', 'layout', 'ٹیمپلیٹ', 'ڈیزائن'],
  ['whatsapp', 'watsapp', 'whatsap', 'whats', 'wa', 'watsap', 'واٹس', 'واٹس_ایپ', 'وٹس'],
  ['send', 'bhejna', 'bhejen', 'bhejo', 'bhejein', 'share', 'بھیجیں', 'بھیجنا'],
  ['link', 'connect', 'jorna', 'jodna', 'scan', 'qr', 'لنک', 'جوڑیں', 'اسکین'],
  ['backup', 'backups', 'bakup', 'copy', 'بیک', 'بیک_اپ'],
  ['restore', 'recover', 'wapis', 'بحال', 'ریسٹور'],
  ['import', 'excel', 'csv', 'امپورٹ'],
  ['user', 'users', 'staff', 'employee', 'worker', 'mulazim', 'ملازم', 'یوزر', 'صارف'],
  ['role', 'roles', 'permission', 'permissions', 'ijazat', 'access', 'اجازت', 'رول'],
  ['password', 'passwd', 'pasword', 'paswrd', 'پاس_ورڈ', 'پاسورڈ'],
  ['pin', 'پن'],
  ['lock', 'locked', 'تالا', 'لاک'],
  ['forgot', 'forget', 'bhool', 'bhul', 'yaad', 'بھول'],
  ['firm', 'firms', 'company', 'business', 'branch', 'karobar', 'kaarobar', 'فرم', 'کمپنی', 'کاروبار', 'برانچ'],
  ['switch', 'swap', 'دوسری'],
  ['license', 'licence', 'lisence', 'key', 'activation', 'activate', 'لائسنس', 'ایکٹیویٹ'],
  ['trial', 'demo', 'ٹرائل'],
  ['readonly', 'read-only', 'only read', 'ریڈ'],
  ['support', 'help', 'madad', 'complaint', 'contact', 'مدد', 'سپورٹ', 'شکایت'],
  ['message', 'messages', 'msg', 'paigham', 'پیغام', 'میسج'],
  ['theme', 'themes', 'color', 'colour', 'dark', 'rang', 'رنگ', 'تھیم'],
  ['error', 'errors', 'problem', 'fail', 'failed', 'masla', 'kharabi', 'galat', 'mistake', 'مسئلہ', 'خرابی', 'غلط'],
  ['slow', 'hang', 'stuck', 'ahista', 'aahista', 'سست', 'آہستہ'],
  ['blank', 'empty', 'khali', 'خالی'],
  ['found', 'missing', 'nahi', 'nahin', 'نہیں'],
  ['database', 'data', 'ڈیٹا', 'ڈیٹابیس'],
  ['tax', 'gst', 'ٹیکس'],
  ['order', 'orders', 'آرڈر'],
  ['challan', 'delivery', 'چالان', 'ڈیلیوری'],
  ['statement', 'ledger', 'khata', 'کھاتا', 'لیجر', 'اسٹیٹمنٹ'],
  ['warehouse', 'warehouses', 'store', 'گودام'],
  ['delete', 'remove', 'cancel', 'hatana', 'mitana', 'ہٹائیں', 'منسوخ'],
  ['setting', 'settings', 'setup', 'سیٹنگ', 'سیٹنگز'],
  ['advance', 'advances', 'peshgi', 'پیشگی', 'ایڈوانس'],
  ['unlink', 'logout', 'disconnect', 'hatao']
]

const SYN = new Map<string, string>()
for (const g of SYNONYM_GROUPS) {
  const canon = g[0]
  for (const raw of g) {
    const w = normalize(raw.replace(/\?$/, '')).replace(/_/g, ' ')
    // multi-word synonyms are matched token by token: only the first token is mapped
    for (const part of w.split(/\s+/)) if (part && !SYN.has(part)) SYN.set(part, canon)
  }
}

function stem(t: string): string {
  if (/^[a-z]+$/.test(t) && t.length > 4) {
    if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3)
    if (t.endsWith('ies')) return t.slice(0, -3) + 'y'
    if (t.endsWith('es') && /(ch|sh|x|ss)es$/.test(t)) return t.slice(0, -2)
    if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1)
  }
  return t
}

/** Splits text into normalised words (stop words removed, synonyms not applied). */
export function rawTokens(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOP.has(t))
}

/** Maps a raw token to its canonical concept. */
export function canonical(token: string): string {
  return SYN.get(token) ?? SYN.get(stem(token)) ?? stem(token)
}

export function tokenize(text: string): string[] {
  return rawTokens(text).map(canonical)
}

/** Levenshtein distance with an early exit when it exceeds max. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/* ------------------------------ index & ranking ------------------------------ */

const FIELD_BOOST = { title: 3, keywords: 2.5, path: 1, body: 1 } as const
type FieldKey = keyof typeof FIELD_BOOST

interface DocIndex {
  article: HelpArticle
  tf: Record<FieldKey, Map<string, number>>
  len: Record<FieldKey, number>
}

export interface HelpIndex {
  docs: DocIndex[]
  df: Map<string, number>
  avgLen: Record<FieldKey, number>
  /** All indexed terms (for typo correction) */
  vocab: string[]
  /** Raw (pre-synonym) words seen in the KB mapped to their canonical term (for typo correction of synonyms) */
  surface: Map<string, string>
}

function count(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

export function buildIndex(articles: HelpArticle[]): HelpIndex {
  const df = new Map<string, number>()
  const surface = new Map<string, string>()
  const sum: Record<FieldKey, number> = { title: 0, keywords: 0, path: 0, body: 0 }
  const docs = articles.map((a) => {
    const texts: Record<FieldKey, string> = {
      title: `${a.title.en} ${a.title.ur}`,
      keywords: a.keywords.join(' '),
      path: `${a.path.en} ${a.path.ur}`,
      body: `${a.summary.en} ${a.summary.ur} ${a.steps.en.join(' ')} ${a.steps.ur.join(' ')}`
    }
    const tf = {} as Record<FieldKey, Map<string, number>>
    const len = {} as Record<FieldKey, number>
    const seen = new Set<string>()
    for (const f of Object.keys(texts) as FieldKey[]) {
      const raw = rawTokens(texts[f])
      const toks = raw.map(canonical)
      raw.forEach((r, i) => surface.set(r, toks[i]))
      tf[f] = count(toks)
      len[f] = toks.length
      sum[f] += toks.length
      toks.forEach((t) => seen.add(t))
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
    return { article: a, tf, len }
  })
  // synonym words also count as known surface forms
  for (const [w, c] of SYN) if (df.has(c)) surface.set(w, c)
  const n = Math.max(1, docs.length)
  const avgLen = { title: sum.title / n, keywords: sum.keywords / n, path: sum.path / n, body: sum.body / n }
  return { docs, df, avgLen, vocab: [...df.keys()], surface }
}

export interface QueryTerm {
  term: string
  weight: number
  from: string
}

/** Resolves query words to index terms, correcting typos by edit distance when a word is unknown. */
export function queryTerms(index: HelpIndex, query: string): { terms: QueryTerm[]; unknown: string[] } {
  const terms: QueryTerm[] = []
  const unknown: string[] = []
  for (const raw of rawTokens(query)) {
    const c = canonical(raw)
    if (index.df.has(c)) {
      terms.push({ term: c, weight: 1, from: raw })
      continue
    }
    const max = raw.length >= 8 ? 2 : raw.length >= 4 ? 1 : 0
    let best: { term: string; d: number } | null = null
    if (max > 0) {
      for (const [w, t] of index.surface) {
        if (Math.abs(w.length - raw.length) > max) continue
        const d = editDistance(raw, w, max)
        if (d <= max && (!best || d < best.d)) best = { term: t, d }
        if (best?.d === 1 && max === 1) break
      }
    }
    if (best) terms.push({ term: best.term, weight: best.d === 1 ? 0.75 : 0.55, from: raw })
    else unknown.push(raw)
  }
  // de-duplicate terms keeping the highest weight
  const dedup = new Map<string, QueryTerm>()
  for (const t of terms) if (!dedup.has(t.term) || dedup.get(t.term)!.weight < t.weight) dedup.set(t.term, t)
  return { terms: [...dedup.values()], unknown }
}

export interface SearchHit {
  article: HelpArticle
  score: number
  /** Share of the meaningful query words that matched this article (0..1) */
  coverage: number
}

export interface SearchResult {
  hits: SearchHit[]
  /** true when the top hit is good enough to answer with */
  confident: boolean
  /** Words of the question that matched nothing in the knowledge base */
  unknown: string[]
}

const K1 = 1.2
const B = 0.75
/** Minimum BM25 score and query coverage for a confident answer. */
export const MIN_SCORE = 1.5
export const MIN_COVERAGE = 0.5

export function search(index: HelpIndex, query: string, limit = 5): SearchResult {
  const { terms, unknown } = queryTerms(index, query)
  const total = terms.length + unknown.length
  if (terms.length === 0) return { hits: [], confident: false, unknown }
  const N = index.docs.length
  const hits: SearchHit[] = []
  for (const d of index.docs) {
    let score = 0
    let matched = 0
    for (const q of terms) {
      const df = index.df.get(q.term) ?? 0
      if (!df) continue
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      let tw = 0
      for (const f of Object.keys(FIELD_BOOST) as FieldKey[]) {
        const tf = d.tf[f].get(q.term) ?? 0
        if (!tf) continue
        const norm = tf / (1 - B + B * (d.len[f] / (index.avgLen[f] || 1)))
        tw += FIELD_BOOST[f] * norm
      }
      if (tw > 0) {
        matched += q.weight
        score += q.weight * idf * ((tw * (K1 + 1)) / (tw + K1))
      }
    }
    if (score > 0) hits.push({ article: d.article, score, coverage: matched / total })
  }
  // coverage matters: an article that answers every word of the question ranks above a partial match
  hits.sort((a, b) => b.score * (0.5 + b.coverage) - a.score * (0.5 + a.coverage))
  const top = hits[0]
  const confident = !!top && top.score >= MIN_SCORE && top.coverage >= MIN_COVERAGE
  return { hits: hits.slice(0, limit), confident, unknown }
}
