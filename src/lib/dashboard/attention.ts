import type { SupabaseClient } from '@supabase/supabase-js'

import {
  addDaysToKey,
  startOfZonedDay,
  zonedDateKey,
} from '@/verticals/agenda/agent/time'

// ------------------------------------------------------------
// "Para atender" — the read-only lookups behind the dashboard's
// action-first strip. Every query is a plain read scoped by RLS (and
// by account where the table needs it); nothing here writes.
// ------------------------------------------------------------

type DB = SupabaseClient

// --- WhatsApp connection ----------------------------------------------

export type WhatsAppHealth = 'connected' | 'not_configured' | 'needs_attention' | 'unknown'

/**
 * Maps the `/api/whatsapp/config` health payload to what the dashboard
 * shows. Server-side or lookup failures map to `unknown` so a flaky
 * check never raises a false alarm.
 */
export function whatsappHealthFrom(payload: unknown): WhatsAppHealth {
  if (!payload || typeof payload !== 'object') return 'unknown'
  const { connected, reason } = payload as { connected?: unknown; reason?: unknown }
  if (connected === true) return 'connected'
  if (reason === 'no_config') return 'not_configured'
  if (reason === 'token_corrupted' || reason === 'meta_api_error') return 'needs_attention'
  return 'unknown'
}

export async function loadWhatsAppHealth(): Promise<WhatsAppHealth> {
  try {
    const res = await fetch('/api/whatsapp/config', { cache: 'no-store' })
    return whatsappHealthFrom(await res.json())
  } catch {
    return 'unknown'
  }
}

// --- Unread conversations ---------------------------------------------

export interface UnreadSummary {
  count: number
  latest: { conversationId: string; who: string | null; at: string | null } | null
}

type ContactEmbed = { name: string | null; phone: string | null }

export async function loadUnreadSummary(db: DB): Promise<UnreadSummary> {
  const { data, count, error } = await db
    .from('conversations')
    .select('id, last_message_at, contacts(name, phone)', { count: 'exact' })
    .gt('unread_count', 0)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  if (error) throw error

  const row = (data ?? [])[0] as
    | { id: string; last_message_at: string | null; contacts: ContactEmbed | ContactEmbed[] | null }
    | undefined
  const contact = Array.isArray(row?.contacts) ? row?.contacts[0] : row?.contacts
  return {
    count: count ?? 0,
    latest: row
      ? {
          conversationId: row.id,
          who: contact?.name || contact?.phone || null,
          at: row.last_message_at,
        }
      : null,
  }
}

// --- Today's appointments (Agenda module) -----------------------------

export interface TodayAppointment {
  id: string
  startsAt: string
  status: string
  service: string | null
  staff: string | null
  contact: string | null
}

export interface TodayAppointments {
  /** Appointments today that are not cancelled. */
  total: number
  /** The next ones still to happen (pending or confirmed), soonest first. */
  upcoming: TodayAppointment[]
}

type AppointmentRow = {
  id: string
  starts_at: string
  status: string
  service_id: string | null
  staff_id: string | null
  contact_id: string | null
}

const OPEN_STATUSES = new Set(['pending', 'confirmed'])

/**
 * Pure part of the agenda summary: counts the day's non-cancelled
 * appointments and keeps the next `limit` open ones from `now` on.
 */
export function summarizeAppointments(
  rows: readonly AppointmentRow[],
  names: {
    services: ReadonlyMap<string, string>
    staff: ReadonlyMap<string, string>
    contacts: ReadonlyMap<string, string>
  },
  now: Date,
  limit = 3,
): TodayAppointments {
  const active = rows.filter((r) => r.status !== 'cancelled')
  const upcoming = active
    .filter((r) => OPEN_STATUSES.has(r.status) && new Date(r.starts_at) >= now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      startsAt: r.starts_at,
      status: r.status,
      service: (r.service_id && names.services.get(r.service_id)) || null,
      staff: (r.staff_id && names.staff.get(r.staff_id)) || null,
      contact: (r.contact_id && names.contacts.get(r.contact_id)) || null,
    }))
  return { total: active.length, upcoming }
}

const idsOf = (values: (string | null)[]) => [
  ...new Set(values.filter((v): v is string => Boolean(v))),
]

/** Same day window and lookups as the Agenda page, in Colombia time. */
export async function loadTodayAppointments(
  db: DB,
  accountId: string,
  now: Date = new Date(),
): Promise<TodayAppointments> {
  const dayKey = zonedDateKey(now)
  const from = startOfZonedDay(dayKey)
  const to = startOfZonedDay(addDaysToKey(dayKey, 1))
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, starts_at, status, service_id, staff_id, contact_id')
    .eq('account_id', accountId)
    .gte('starts_at', from.toISOString())
    .lt('starts_at', to.toISOString())
    .order('starts_at', { ascending: true })
  if (error) throw error

  const rows = (data ?? []) as AppointmentRow[]
  const lookup = async (table: string, columns: string, ids: string[]) => {
    if (ids.length === 0) return new Map<string, string>()
    const res = await db.from(table).select(columns).eq('account_id', accountId).in('id', ids)
    const map = new Map<string, string>()
    for (const r of (res.data ?? []) as unknown as Array<{ id: string; name: string | null; phone?: string | null }>) {
      const label = r.name || r.phone
      if (label) map.set(r.id, label)
    }
    return map
  }

  const [services, staff, contacts] = await Promise.all([
    lookup('booking_services', 'id, name', idsOf(rows.map((r) => r.service_id))),
    lookup('booking_staff', 'id, name', idsOf(rows.map((r) => r.staff_id))),
    lookup('contacts', 'id, name, phone', idsOf(rows.map((r) => r.contact_id))),
  ])
  return summarizeAppointments(rows, { services, staff, contacts }, now)
}
