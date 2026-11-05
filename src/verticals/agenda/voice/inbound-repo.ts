// ============================================================
// Lecturas y escrituras de la llamada entrante (T14):
//
//   - `findInboundAccount`: la cuenta dueña del número que se marcó
//     (`booking_call_settings.inbound_number`, único en toda la plataforma).
//   - `findOrCreateInboundCall`: la fila de `booking_calls` de la llamada. Se
//     crea en el primer pedido y, si Telnyx lo reintenta, se reutiliza por su
//     `CallSid` en vez de duplicarla (el índice único parcial de
//     `provider_call_sid` lo garantiza aunque dos reintentos lleguen a la vez).
//   - `findCallBySid`: la llamada entrante de un `CallSid`, y opcionalmente solo
//     si el `From` y el `To` también son los de esa fila.
//   - `loadNextAppointment`: la próxima cita activa de quien llama, lista para
//     decirla (misma regla que `listUpcoming` del bot): solo el día y la hora,
//     nunca el nombre del paciente ni del profesional (el número de quien llama
//     se puede falsificar y un teléfono se comparte).
//   - `dialableNumber`: un teléfono escrito a mano → E.164 que se puede marcar.
//
// Todo se escribe con service role. Una lectura que falla LANZA: un error de la
// base no es "este número no existe" ni "no tienes citas". Ni el número ni el
// nombre de quien llama van a ningún mensaje de error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  ACTIVE_APPOINTMENT_STATUSES,
  CALL_COLUMNS,
  callRowFromDb,
  SID_MAX,
  type CallRow,
} from './calls-repo'
import type { InboundNextAppointment } from './inbound-flow'
import { spokenWhen } from './scripts'
import { CALL_SETTINGS_COLUMNS, callSettingsFromRow, toE164, type CallSettings } from './settings'

// ------------------------------------------------------------
// La cuenta del número marcado
// ------------------------------------------------------------

export interface InboundAccount {
  accountId: string
  settings: CallSettings
}

/** La cuenta cuyo `inbound_number` es `to` (E.164), o null si ninguna lo tiene. */
export async function findInboundAccount(db: SupabaseClient, to: string | null): Promise<InboundAccount | null> {
  if (!to) return null
  const { data, error } = await db
    .from('booking_call_settings')
    .select(`account_id, ${CALL_SETTINGS_COLUMNS}`)
    .eq('inbound_number', to)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la configuración de llamadas: ${error.message}`)
  if (!data) return null
  const row = data as unknown as Record<string, unknown>
  return { accountId: String(row.account_id), settings: callSettingsFromRow(row) }
}

// ------------------------------------------------------------
// La fila de la llamada
// ------------------------------------------------------------

/**
 * Los números que tiene que traer el pedido además del `CallSid` (E.164 ya
 * normalizado). Una propiedad ausente no se mira; `null` significa "la fila no
 * tiene número" (llamada privada).
 */
export interface CallSidMatch {
  from?: string | null
  to?: string | null
}

/**
 * La llamada entrante con ese `CallSid`, o null. Con `match`, además el `From` y
 * el `To` del pedido tienen que ser los de la fila (`from_number`, `to_number`):
 * el aviso de fin de una entrante llega a una URL fija, sin id de fila, y el
 * `CallSid` solo no basta para que sea de la misma llamada.
 */
export async function findCallBySid(
  db: SupabaseClient,
  sid: string,
  match: CallSidMatch = {},
): Promise<CallRow | null> {
  if (!sid) return null
  let query = db
    .from('booking_calls')
    .select(CALL_COLUMNS)
    .eq('direction', 'inbound')
    .eq('provider_call_sid', sid.slice(0, SID_MAX))
  if (match.to !== undefined) query = match.to === null ? query.is('to_number', null) : query.eq('to_number', match.to)
  if (match.from !== undefined) {
    query = match.from === null ? query.is('from_number', null) : query.eq('from_number', match.from)
  }
  const { data, error } = await query.order('created_at', { ascending: true }).limit(1)
  if (error) throw new Error(`No se pudo leer la llamada: ${error.message}`)
  const row = ((data ?? []) as Record<string, unknown>[])[0]
  return row ? callRowFromDb(row) : null
}

export interface NewInboundCall {
  accountId: string
  /** `CallSid` de Telnyx; con él un reintento encuentra la misma fila. */
  sid: string | null
  /** E.164 de quien llama; null si no mostró un número válido. */
  from: string | null
  /** E.164 que se marcó (el `inbound_number`). */
  to: string
  /** El contacto de ese número, si ya existe. */
  contactId: string | null
  now: Date
}

/**
 * La fila de la llamada entrante. Si Telnyx reintenta el primer pedido (mismo
 * `CallSid`) devuelve la que ya existe. Dos reintentos EXACTAMENTE a la vez no
 * duplican la fila: el índice único parcial de `provider_call_sid` (23505) deja
 * pasar al primero, y el otro vuelve a leer y toma la que creó el primero. Un
 * `CallSid` que ya es de otra cuenta o de una saliente no se reutiliza nunca: la
 * llamada no se registra.
 */
export async function findOrCreateInboundCall(db: SupabaseClient, args: NewInboundCall): Promise<CallRow> {
  if (args.sid) {
    const existing = await findCallBySid(db, args.sid)
    if (existing && existing.accountId === args.accountId) return existing
  }

  const { data, error } = await db
    .from('booking_calls')
    .insert({
      id: crypto.randomUUID(),
      account_id: args.accountId,
      direction: 'inbound',
      channel: 'robot',
      contact_id: args.contactId,
      from_number: args.from,
      to_number: args.to,
      status: 'in_progress',
      provider_call_sid: args.sid ? args.sid.slice(0, SID_MAX) : null,
      created_at: args.now.toISOString(),
    })
    .select(CALL_COLUMNS)
    .single()
  if (error && args.sid && (error as { code?: string }).code === '23505') {
    // Otro reintento la creó entre la lectura y el insert: es la misma llamada si es de esta cuenta.
    const winner = await findCallBySid(db, args.sid)
    if (winner && winner.accountId === args.accountId) return winner
  }
  if (error || !data) {
    throw new Error(`No se pudo registrar la llamada entrante: ${error?.message ?? 'sin respuesta'}`)
  }
  return callRowFromDb(data as Record<string, unknown>)
}

// ------------------------------------------------------------
// La próxima cita de quien llama
// ------------------------------------------------------------

/**
 * La próxima cita activa del contacto (pendiente o confirmada y futura), con el
 * día y la hora ya dichos. NO lee ni dice el nombre del paciente ni del profesional:
 * el identificador de llamada se puede falsificar y un teléfono se comparte, así
 * que quien conteste solo se entera de cuándo es la cita.
 */
export async function loadNextAppointment(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; now: Date },
): Promise<InboundNextAppointment | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, starts_at')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .in('status', [...ACTIVE_APPOINTMENT_STATUSES])
    .gt('starts_at', args.now.toISOString())
    .order('starts_at')
    .limit(1)
  if (error) throw new Error(`No se pudieron leer las citas: ${error.message}`)
  const row = ((data ?? []) as { id: string; starts_at: string }[])[0]
  if (!row) return null

  const when = spokenWhen(new Date(row.starts_at), args.now)
  return { id: row.id, speech: { day: when.day, time: when.time } }
}

// ------------------------------------------------------------
// Teléfonos escritos a mano
// ------------------------------------------------------------

/**
 * Un teléfono que alguien escribió ("+57 300 123 4567", "300 123 4567") → E.164
 * para marcarlo. Sin indicativo se asume Colombia (10 dígitos). null si no se
 * puede marcar.
 */
export function dialableNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const international = toE164(raw)
  if (international) return international
  const digits = raw.replace(/[\s().-]/g, '')
  return /^\d{10}$/.test(digits) ? `+57${digits}` : null
}
