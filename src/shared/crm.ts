/** CRM vocabulary shared by the main process (rules) and the screens. */
export const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'site_visit', label: 'Site visit' },
  { key: 'quoted', label: 'Quotation sent' },
  { key: 'negotiation', label: 'Negotiation' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' }
] as const
export type Stage = (typeof STAGES)[number]['key']
export const OPEN_STAGES: Stage[] = ['new', 'contacted', 'site_visit', 'quoted', 'negotiation']
export const stageLabel = (k: string): string => STAGES.find((s) => s.key === k)?.label ?? k

export const ACTIVITY_KINDS = ['call', 'whatsapp', 'visit', 'meeting', 'note'] as const
export const ACTIVITY_LABEL: Record<string, string> = { call: 'Phone call', whatsapp: 'WhatsApp', visit: 'Site visit', meeting: 'Meeting', note: 'Note', stage: 'Stage change' }
export const LEAD_SOURCES = ['Referral', 'Walk-in', 'Facebook', 'WhatsApp', 'Website', 'Phone call', 'Existing customer', 'Exhibition', 'Other']
