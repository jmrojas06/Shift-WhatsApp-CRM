// ============================================================
// Utilidades de prueba del flujo clínico: cuenta con el módulo, un
// grabador de mensajes y un envío como lo haría el dispatcher.
// ============================================================

import type { ModuleKey, VerticalSession } from '@/lib/verticals/types'

import { handleAgendaInbound, type AgendaSender } from '../controller'
import { asClient, makeFakeDb, type FakeDb, type Row } from './fake-db'

export const ACCOUNT = 'acc-1'
export const CONTACT = 'ct-1'
export const CONVERSATION = 'cv-1'
export const OWNER = 'user-owner'
export const SERVICE_LIMPIEZA = 'svc-limpieza'
export const SERVICE_URGENCIA = 'svc-urgencia'
export const STAFF_ANA = 'st-ana'
export const LOCATION = 'loc-1'

/** Lunes 19 de octubre de 2026, 08:00 en Bogotá (13:00Z). */
export const NOW = new Date('2026-10-19T13:00:00Z')

const weekdayHours = (staffId: string): Row[] =>
  [1, 2, 3, 4, 5].map((weekday) => ({
    account_id: ACCOUNT,
    staff_id: staffId,
    weekday,
    start_time: '09:00:00',
    end_time: '12:00:00',
  }))

export function clinicDb(extra: Record<string, Row[]> = {}): FakeDb {
  return makeFakeDb({
    accounts: [{ id: ACCOUNT, default_currency: 'COP', owner_user_id: OWNER }],
    ai_configs: [],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Marta Ruiz', phone: '573001112233' }],
    conversations: [
      {
        id: CONVERSATION,
        account_id: ACCOUNT,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
        assigned_agent_id: null,
      },
    ],
    booking_services: [
      {
        id: SERVICE_LIMPIEZA,
        account_id: ACCOUNT,
        name: 'Limpieza',
        description: null,
        duration_minutes: 30,
        price: 0,
        is_active: true,
        position: 0,
        prep_instructions: 'Cepíllate antes de venir.',
      },
      {
        id: SERVICE_URGENCIA,
        account_id: ACCOUNT,
        name: 'Urgencia',
        description: null,
        duration_minutes: 30,
        price: 0,
        is_active: true,
        position: 1,
        prep_instructions: null,
      },
    ],
    booking_staff: [
      { id: STAFF_ANA, account_id: ACCOUNT, name: 'Dra. Ana', bio: null, is_active: true, position: 0 },
    ],
    booking_staff_services: [
      { account_id: ACCOUNT, staff_id: STAFF_ANA, service_id: SERVICE_LIMPIEZA },
      { account_id: ACCOUNT, staff_id: STAFF_ANA, service_id: SERVICE_URGENCIA },
    ],
    booking_working_hours: weekdayHours(STAFF_ANA),
    booking_time_off: [],
    booking_appointments: [],
    booking_sessions: [],
    booking_settings: [
      {
        account_id: ACCOUNT,
        bot_texts: {},
        labels: {},
        choose_staff: true,
        show_price: false,
        show_duration: false,
        reminders_enabled: true,
        allow_reschedule: true,
      },
    ],
    booking_questions: [],
    tags: [],
    contact_tags: [],
    notifications: [],
    booking_events: [],
    messages: [],
    pipelines: [],
    clinic_settings: [
      {
        account_id: ACCOUNT,
        consent_text: 'Texto de autorización',
        consent_version: 2,
        urgency_words: ['urgencia', 'dolor'],
        urgency_alarm_text: 'Signos de alarma',
        urgency_service_id: SERVICE_URGENCIA,
        offer_days: 30,
      },
    ],
    clinic_locations: [
      {
        id: LOCATION,
        account_id: ACCOUNT,
        name: 'Centro',
        address: 'Calle 1 # 2-3',
        latitude: 4.6,
        longitude: -74.08,
        on_call_phone: '3001234567',
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    clinic_patients: [],
    clinic_consents: [],
    ...extra,
  })
}

/** Autorización de datos ya dada por el contacto. */
export const grantedConsent = (): Row => ({
  id: 'cons-1',
  account_id: ACCOUNT,
  contact_id: CONTACT,
  contact_ref: '573001112233',
  kind: 'datos_sensibles',
  granted: true,
  text_version: 2,
  text_snapshot: 'Texto de autorización',
  source: 'whatsapp',
  created_at: '2026-10-01T00:00:00.000Z',
})

export interface SentCall {
  kind: 'text' | 'buttons' | 'list'
  bodyText: string
  ids: string[]
  titles: string[]
}

export function makeRecorder() {
  const calls: SentCall[] = []
  const sender: AgendaSender = {
    sendText: async ({ text }) => {
      calls.push({ kind: 'text', bodyText: text, ids: [], titles: [] })
    },
    sendButtons: async ({ bodyText, buttons }) => {
      calls.push({
        kind: 'buttons',
        bodyText,
        ids: buttons.map((b) => b.id),
        titles: buttons.map((b) => b.title),
      })
    },
    sendList: async ({ bodyText, sections }) => {
      const rows = sections.flatMap((s) => s.rows)
      calls.push({
        kind: 'list',
        bodyText,
        ids: rows.map((r) => r.id),
        titles: rows.map((r) => r.title),
      })
    },
  }
  return { calls, sender }
}

export type Recorder = ReturnType<typeof makeRecorder>

export function last(rec: Recorder): SentCall {
  const call = rec.calls.at(-1)
  if (!call) throw new Error('el bot no envió nada')
  return call
}

function activeSession(db: FakeDb, now: Date): VerticalSession | null {
  const row = db._tables.booking_sessions.find(
    (r) => r.status === 'active' && String(r.expires_at) > now.toISOString(),
  )
  return row
    ? {
        id: row.id as string,
        state: (row.state ?? {}) as Record<string, unknown>,
        expiresAt: row.expires_at as string,
      }
    : null
}

let counter = 0

export async function send(
  db: FakeDb,
  rec: Recorder,
  input: { text?: string; replyId?: string },
  opts: {
    now?: Date
    modules?: ModuleKey[]
    humanOwned?: boolean
    /** La respuesta automática con IA está activa. Por defecto, sí. */
    aiOn?: boolean | (() => Promise<boolean>)
  } = {},
) {
  counter += 1
  const messageId = `wamid-${counter}`
  db._tables.messages.push({
    id: `msg-${counter}`,
    conversation_id: CONVERSATION,
    message_id: messageId,
    content_text: input.text ?? '',
    interactive_reply_id: input.replyId ?? null,
  })
  const now = opts.now ?? NOW
  const aiOn = opts.aiOn ?? true
  return handleAgendaInbound({
    db: asClient(db),
    sender: rec.sender,
    now,
    accountId: ACCOUNT,
    conversationId: CONVERSATION,
    contactId: CONTACT,
    configOwnerUserId: OWNER,
    inboundMessageId: messageId,
    session: activeSession(db, now),
    humanOwned: opts.humanOwned,
    modules: opts.modules ?? ['agenda', 'clinica'],
    aiAutoReplyOn: typeof aiOn === 'function' ? aiOn : async () => aiOn,
  })
}
