/**
 * "Send on WhatsApp" button (owner: assist area). Placeholder until the WhatsApp integration is implemented:
 * renders nothing so screens that include it keep working.
 */
export interface WhatsAppButtonProps {
  /** What is being sent. 'statement' uses partyId + optional from/to params. */
  entity: 'document' | 'payment' | 'project' | 'statement' | 'material'
  id: number
  partyId?: number | null
  phone?: string | null
  params?: Record<string, unknown>
  size?: 'sm' | 'md'
  label?: string
}

export function WhatsAppButton(_props: WhatsAppButtonProps): JSX.Element | null {
  return null
}
