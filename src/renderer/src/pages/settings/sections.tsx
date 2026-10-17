/**
 * Extra Settings sections contributed by feature areas. Each section is shown only to users holding one of its
 * permissions (the owner sees everything). Order here is the tab order after the built-in tabs.
 */
import type { ComponentType } from 'react'
import { TemplatesSection } from './TemplatesSection'
import { PrintersSection } from './PrintersSection'
import { WhatsAppSection } from './WhatsAppSection'
import { SupportSection } from './SupportSection'
import { CloudSection } from './CloudSection'
import { LicenseSection } from './LicenseSection'

export interface SettingsSection {
  key: string
  label: string
  /** Any of these permissions shows the section. Empty = every signed-in user. */
  perms: string[]
  component: ComponentType
}

export const EXTRA_SECTIONS: SettingsSection[] = [
  { key: 'templates', label: 'Invoice templates', perms: ['templates.manage'], component: TemplatesSection },
  { key: 'printers', label: 'Printers', perms: ['printers.manage'], component: PrintersSection },
  { key: 'whatsapp', label: 'WhatsApp', perms: ['settings.manage', 'whatsapp.send'], component: WhatsAppSection },
  { key: 'cloud', label: 'Device location', perms: ['settings.manage'], component: CloudSection },
  { key: 'support', label: 'Support messages', perms: ['support.use'], component: SupportSection },
  { key: 'license', label: 'License & About', perms: [], component: LicenseSection }
]

/** Permissions that make the Settings screen reachable at all. */
export const SETTINGS_ENTRY_PERMS = ['settings.manage', ...new Set(EXTRA_SECTIONS.flatMap((s) => s.perms))]
