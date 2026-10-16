/** Help & Support: offline Urdu / English help assistant (owner: assist area). Runs fully offline on the local knowledge base. */
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, ChevronDown, ChevronRight, LifeBuoy, MapPin, MessageSquare, Search, SendHorizonal, Trash2, WifiOff } from 'lucide-react'
import { Badge, Button, Card, PageHeader, cx } from '../../components/ui'
import { CATEGORY_LABELS, EXAMPLE_QUESTIONS, HELP_ARTICLES, HelpArticle, HelpCategory } from '@shared/help/kb'
import { buildIndex, search } from '@shared/help/search'

type Lang = 'en' | 'ur'

const URDU_FONT = "'Noto Nastaliq Urdu', 'Jameel Noori Nastaleeq', 'Urdu Typesetting', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif"

const T = {
  en: {
    subtitle: 'Offline help assistant — answers come from the built-in help guide on this computer. No internet needed (this is not a cloud AI).',
    placeholder: 'Ask in English, Urdu or Roman Urdu — e.g. "invoice kaise banaye"',
    ask: 'Ask',
    examples: 'Try asking',
    where: 'Where to find it',
    steps: 'Steps',
    open: 'Open this screen',
    related: 'Related',
    notFoundTitle: 'I could not find this in the help guide',
    notFound: 'Try simpler words (for example "invoice", "stock", "backup", "din band"), pick a topic below, or message Digital Target support.',
    didYouMean: 'Maybe you meant',
    support: 'Message Digital Target',
    browse: 'Browse all topics',
    clear: 'Clear',
    you: 'You',
    offline: 'Works offline',
    articles: 'articles'
  },
  ur: {
    subtitle: 'آف لائن ہیلپ اسسٹنٹ — جوابات اسی کمپیوٹر پر موجود ہیلپ گائیڈ سے آتے ہیں۔ انٹرنیٹ کی ضرورت نہیں (یہ کلاؤڈ AI نہیں ہے)۔',
    placeholder: 'اردو، انگریزی یا رومن اردو میں پوچھیں — مثلاً "انوائس کیسے بنائیں"',
    ask: 'پوچھیں',
    examples: 'یہ پوچھ کر دیکھیں',
    where: 'کہاں ملے گا',
    steps: 'طریقہ',
    open: 'یہ اسکرین کھولیں',
    related: 'متعلقہ',
    notFoundTitle: 'یہ بات ہیلپ گائیڈ میں نہیں ملی',
    notFound: 'آسان الفاظ استعمال کریں (مثلاً "انوائس"، "اسٹاک"، "بیک اپ"، "دن بند")، نیچے سے موضوع منتخب کریں، یا Digital Target سپورٹ کو پیغام بھیجیں۔',
    didYouMean: 'شاید آپ کا مطلب تھا',
    support: 'Digital Target کو پیغام بھیجیں',
    browse: 'تمام موضوعات',
    clear: 'صاف کریں',
    you: 'آپ',
    offline: 'آف لائن کام کرتا ہے',
    articles: 'مضامین'
  }
}

interface Turn {
  id: number
  q: string
  article: HelpArticle | null
  suggestions: HelpArticle[]
}

function loadLang(): Lang {
  try {
    return localStorage.getItem('dt.help.lang') === 'ur' ? 'ur' : 'en'
  } catch {
    return 'en'
  }
}

export function HelpPage(): JSX.Element {
  const nav = useNavigate()
  const index = useMemo(() => buildIndex(HELP_ARTICLES), [])
  const byId = useMemo(() => new Map(HELP_ARTICLES.map((a) => [a.id, a])), [])
  const [lang, setLangState] = useState<Lang>(loadLang)
  const [q, setQ] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [openCat, setOpenCat] = useState<HelpCategory | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const t = T[lang]
  const rtl = lang === 'ur'
  const textStyle = rtl ? { fontFamily: URDU_FONT, lineHeight: 2 } : undefined

  const setLang = (l: Lang): void => {
    setLangState(l)
    try {
      localStorage.setItem('dt.help.lang', l)
    } catch {
      /* per-viewer convenience only */
    }
  }

  useEffect(() => {
    // Braces matter: newer Chromium returns a Promise from scrollIntoView, which must not become the effect cleanup.
    void endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  const ask = (question: string): void => {
    const text = question.trim()
    if (!text) return
    const r = search(index, text, 5)
    // Answer in the language the question was typed in (Urdu script -> Urdu).
    if (/[؀-ۿ]/.test(text) && lang !== 'ur') setLang('ur')
    setTurns((prev) => [
      ...prev,
      { id: Date.now(), q: text, article: r.confident ? r.hits[0].article : null, suggestions: (r.confident ? r.hits.slice(1, 4) : r.hits.slice(0, 3)).map((h) => h.article) }
    ])
    setQ('')
    inputRef.current?.focus()
  }

  const showArticle = (a: HelpArticle): void => {
    setTurns((prev) => [...prev, { id: Date.now(), q: a.title[lang], article: a, suggestions: [] }])
  }

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    ask(q)
  }

  const categories = useMemo(() => {
    const m = new Map<HelpCategory, HelpArticle[]>()
    for (const a of HELP_ARTICLES) m.set(a.category, [...(m.get(a.category) ?? []), a])
    return [...m.entries()]
  }, [])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Help & Support"
        subtitle={<span dir={rtl ? 'rtl' : 'ltr'} style={textStyle}>{t.subtitle}</span>}
        icon={<LifeBuoy className="h-5 w-5" />}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="ok" className="hidden sm:inline-flex">
              <WifiOff className="mr-1 h-3.5 w-3.5" /> {t.offline}
            </Badge>
            <div className="inline-flex rounded-[9px] border border-line bg-surface p-0.5" role="group" aria-label="Language">
              <button type="button" className={cx('h-8 rounded-[7px] px-3 text-[13px] cursor-pointer', lang === 'en' ? 'bg-brand text-on-brand' : 'text-ink')} onClick={() => setLang('en')}>
                English
              </button>
              <button type="button" className={cx('h-8 rounded-[7px] px-3 text-[14px] cursor-pointer', lang === 'ur' ? 'bg-brand text-on-brand' : 'text-ink')} style={{ fontFamily: URDU_FONT }} onClick={() => setLang('ur')}>
                اردو
              </button>
            </div>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-3">
          <Card>
            <form onSubmit={submit} className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  ref={inputRef}
                  aria-label="Question"
                  className="input h-10 w-full pl-9"
                  dir="auto"
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t.placeholder}
                  style={rtl ? { fontFamily: URDU_FONT } : undefined}
                  maxLength={300}
                />
              </div>
              <Button variant="primary" type="submit" icon={<SendHorizonal className="h-4 w-4" />} disabled={!q.trim()}>
                <span style={rtl ? { fontFamily: URDU_FONT } : undefined}>{t.ask}</span>
              </Button>
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-2" dir={rtl ? 'rtl' : 'ltr'}>
              <span className="text-[12.5px] text-muted" style={textStyle}>{t.examples}:</span>
              {EXAMPLE_QUESTIONS.map((ex) => (
                <button key={ex.en} type="button" onClick={() => ask(ex[lang])} className="rounded-full border border-line bg-surface-2 px-3 py-1 text-[12.5px] hover:border-brand hover:text-brand cursor-pointer" style={rtl ? { fontFamily: URDU_FONT } : undefined}>
                  {ex[lang]}
                </button>
              ))}
            </div>
          </Card>

          {turns.length > 0 && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setTurns([])}>
                {t.clear}
              </Button>
            </div>
          )}

          {turns.map((turn) => (
            <div key={turn.id} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand px-4 py-2 text-[13.5px] text-on-brand" dir="auto">
                  {turn.q}
                </div>
              </div>
              {turn.article ? (
                <AnswerCard a={turn.article} lang={lang} onOpen={(r) => nav(r)} onRelated={(id) => byId.get(id) && showArticle(byId.get(id)!)} byId={byId} extra={turn.suggestions} />
              ) : (
                <div className="card border-warn/40 p-4" dir={rtl ? 'rtl' : 'ltr'} style={textStyle}>
                  <div className="font-semibold">{t.notFoundTitle}</div>
                  <p className="mt-1 text-[13.5px] text-muted">{t.notFound}</p>
                  {turn.suggestions.length > 0 && (
                    <div className="mt-3">
                      <div className="text-[12.5px] text-muted">{t.didYouMean}:</div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {turn.suggestions.map((s) => (
                          <button key={s.id} type="button" className="rounded-full border border-line px-3 py-1 text-[12.5px] hover:border-brand hover:text-brand cursor-pointer" onClick={() => showArticle(s)}>
                            {s.title[lang]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <Button className="mt-3" size="sm" variant="soft" icon={<MessageSquare className="h-4 w-4" />} onClick={() => nav('/settings?tab=support')}>
                    {t.support}
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <Card
          title={
            <span className="flex items-center gap-2" style={rtl ? { fontFamily: URDU_FONT } : undefined}>
              <BookOpen className="h-4 w-4" /> {t.browse}
            </span>
          }
          actions={<span className="text-[12px] text-muted">{HELP_ARTICLES.length} {t.articles}</span>}
          pad={false}
          className="h-fit"
        >
          <div className="max-h-[70vh] overflow-y-auto p-2" dir={rtl ? 'rtl' : 'ltr'}>
            {categories.map(([cat, list]) => (
              <div key={cat}>
                <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[13px] font-medium hover:bg-surface-2 cursor-pointer" style={rtl ? { fontFamily: URDU_FONT } : undefined} onClick={() => setOpenCat(openCat === cat ? null : cat)}>
                  {openCat === cat ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className={cx('h-4 w-4 shrink-0', rtl && 'rotate-180')} />}
                  <span className="flex-1">{CATEGORY_LABELS[cat][lang]}</span>
                  <span className="text-[11.5px] text-muted">{list.length}</span>
                </button>
                {openCat === cat && (
                  <div className="mb-1 ps-7">
                    {list.map((a) => (
                      <button key={a.id} type="button" className="block w-full rounded-md px-2 py-1 text-start text-[12.5px] text-muted hover:bg-surface-2 hover:text-ink cursor-pointer" style={rtl ? { fontFamily: URDU_FONT } : undefined} onClick={() => showArticle(a)}>
                        {a.title[lang]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-line p-3">
            <Button size="sm" variant="soft" className="w-full" icon={<MessageSquare className="h-4 w-4" />} onClick={() => nav('/settings?tab=support')}>
              <span style={rtl ? { fontFamily: URDU_FONT } : undefined}>{t.support}</span>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}

function AnswerCard({ a, lang, onOpen, onRelated, byId, extra }: { a: HelpArticle; lang: Lang; onOpen: (route: string) => void; onRelated: (id: string) => void; byId: Map<string, HelpArticle>; extra: HelpArticle[] }): JSX.Element {
  const t = T[lang]
  const rtl = lang === 'ur'
  const style = rtl ? { fontFamily: URDU_FONT, lineHeight: 2.1 } : undefined
  const related = [...new Set([...a.related, ...extra.map((e) => e.id)])].filter((id) => id !== a.id && byId.has(id)).slice(0, 5)
  return (
    <div className="card fade-in p-4" dir={rtl ? 'rtl' : 'ltr'} style={style} data-testid="help-answer" data-article={a.id}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{a.title[lang]}</div>
          <div className="mt-0.5 text-[13px] text-muted">{a.summary[lang]}</div>
        </div>
        <Badge tone="info">{CATEGORY_LABELS[a.category][lang]}</Badge>
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <div>
          <span className="text-muted">{t.where}: </span>
          <span className="font-medium" dir="auto">{a.path[lang]}</span>
        </div>
      </div>
      <div className="mt-3 text-[12.5px] font-semibold text-muted">{t.steps}</div>
      <ol className="mt-1 space-y-1.5">
        {a.steps[lang].map((s, i) => (
          <li key={i} className="flex gap-2 text-[13.5px]">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand">{i + 1}</span>
            <span className="min-w-0 flex-1">{s}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {a.route && (
          <Button size="sm" variant="primary" icon={<ArrowRight className={cx('h-4 w-4', rtl && 'rotate-180')} />} onClick={() => onOpen(a.route!)}>
            {t.open}
          </Button>
        )}
        {related.length > 0 && <span className="text-[12px] text-muted">{t.related}:</span>}
        {related.map((id) => (
          <button key={id} type="button" className="rounded-full border border-line px-2.5 py-0.5 text-[12px] hover:border-brand hover:text-brand cursor-pointer" onClick={() => onRelated(id)}>
            {byId.get(id)!.title[lang]}
          </button>
        ))}
      </div>
    </div>
  )
}
