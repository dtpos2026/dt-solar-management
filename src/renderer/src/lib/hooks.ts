import { DependencyList, useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { toast } from '../components/ui'
import type { Option } from '../components/Combobox'
import { money, qty } from './format'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList, initial?: T): { data: T | undefined; loading: boolean; reload: () => Promise<void>; setData: (d: T) => void } {
  const [data, setData] = useState<T | undefined>(initial)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    try {
      const d = await fn()
      if (my === seq.current) setData(d)
    } catch (e) {
      if (my === seq.current) toast.error(e)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    reload()
  }, [reload])
  return { data, loading, reload, setData }
}

export interface ProductLite {
  id: number
  name: string
  sku: string | null
  type: 'goods' | 'service'
  unit: string
  sale_price: number
  purchase_price: number | null
  avg_cost: number | null
  tax_rate: number
  stock: number
  track_serial: number
  warranty_months: number
  brand: string | null
  model: string | null
  category_name: string | null
  is_active: number
}

export function useProducts(includeInactive = false): { products: ProductLite[]; options: Option[]; reload: () => Promise<void> } {
  const { data, reload } = useLoad(() => api<{ rows: ProductLite[] }>('products.list', { limit: 5000, active: includeInactive ? 'all' : 'active' }), [includeInactive])
  const products = data?.rows ?? []
  const options = products.map((p) => ({
    value: p.id,
    label: p.name,
    search: `${p.sku ?? ''} ${p.brand ?? ''} ${p.model ?? ''} ${p.category_name ?? ''}`,
    sub: `${p.sku ? p.sku + ' · ' : ''}${p.type === 'service' ? 'Service' : `Stock: ${qty(p.stock)} ${p.unit}`} · ${money(p.sale_price)}`
  }))
  return { products, options, reload }
}

export interface PartyLite {
  id: number
  name: string
  type: string
  phone: string | null
  city: string | null
  address: string | null
  balance: number
  credit_limit: number
  payment_terms_days: number
}

export function useParties(type?: 'customer' | 'supplier'): { parties: PartyLite[]; options: Option[]; reload: () => Promise<void> } {
  const { data, reload } = useLoad(() => api<PartyLite[]>('parties.list', { type }), [type])
  const parties = data ?? []
  const options = parties.map((p) => ({
    value: p.id,
    label: p.name,
    search: `${p.phone ?? ''} ${p.city ?? ''}`,
    sub: `${p.phone ?? ''}${p.city ? ' · ' + p.city : ''}${Math.abs(p.balance) > 0.5 ? ` · Balance ${money(p.balance)}` : ''}`
  }))
  return { parties, options, reload }
}

export function useProjects(): { projects: Array<{ id: number; code: string; name: string; customer_id: number | null; status: string }>; options: Option[]; reload: () => Promise<void> } {
  const { data, reload } = useLoad(() => api<Array<{ id: number; code: string; name: string; customer_id: number | null; status: string }>>('projects.options'), [])
  const projects = data ?? []
  return { projects, options: projects.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, sub: p.status.replace('_', ' ') })), reload }
}

export function useAccounts(): Array<{ id: number; name: string; type: string; balance: number; is_default: number }> {
  const { data } = useLoad(() => api<any[]>('accounts.list'), [])
  return data ?? []
}

export function useWarehouses(): Array<{ id: number; name: string; is_default: number; firm_id: number | null }> {
  const { data } = useLoad(() => api<any[]>('warehouses.list'), [])
  return data ?? []
}

export function useTaxRates(): Array<{ id: number; name: string; rate: number; is_default: number; is_active: number }> {
  const { data } = useLoad(() => api<any[]>('taxRates.list'), [])
  return (data ?? []).filter((t) => t.is_active)
}

export function useQuery(): URLSearchParams {
  const hash = window.location.hash
  const i = hash.indexOf('?')
  return new URLSearchParams(i >= 0 ? hash.slice(i + 1) : '')
}
