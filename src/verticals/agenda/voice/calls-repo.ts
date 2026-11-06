// ============================================================
// Filas de `booking_calls` (migración 056) que usan los webhooks de voz:
// las llamadas salientes del robot (T13) y, después, las entrantes (T14).
//
//   - Los tipos repiten los CHECK de la migración (estados y resultados).
//   - Todo se escribe con service role y acotado por la fila (el id sale de
//     una URL firmada con `t`).
//   - Las escrituras que deben pasar UNA sola vez (poner el resultado de la
//     llamada) son condicionales: un reintento del webhook no las repite.
//
// Un número o un nombre de paciente no va a ningún error de este archivo.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUuid } from '../panel-booking-input'

export type CallDirection = 'outbound' | 'inbound'
export type CallChannel = 'robot' | 'manual'

export type CallStatus =
  | 'queued'
  | 'calling'
  | 'in_progress'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'canceled'

export type CallOutcome =
  | 'confirmed'
  | 'cancelled'
  | 'human'
  | 'no_response'
  | 'wrong_number'
  | 'booking_link_sent'
  | 'advisor_connected'
  | 'advisor_missed'
  | 'out_of_hours'
  | 'info'
  | 'urgency'

/**
 * Resultados "de paso" de una llamada entrante: se escriben mientras el
 * paciente recorre el menú y el que viene después los puede reemplazar
 * (leer el horario y luego confirmar su cita deja `confirmed`). Cualquier
 * otro resultado es final: un reintento del webhook no lo repite.
 */
export const REPLACEABLE_OUTCOMES: readonly CallOutcome[] = ['no_response', 'info', 'out_of_hours']

/** La llamada ya terminó: no cambia más de estado. */
export const TERMINAL_STATUSES: readonly CallStatus[] = ['completed', 'no_answer', 'busy', 'failed', 'canceled']
/** La llamada sigue (o se está armando). */
export const IN_FLIGHT_STATUSES: readonly CallStatus[] = ['queued', 'calling', 'in_progress']

export const isTerminalStatus = (status: CallStatus): boolean => TERMINAL_STATUSES.includes(status)

/** Largos máximos de la migración (`menu_path`, `error`). */
export const MENU_PATH_MAX = 60
export const ERROR_MAX = 300

export interface CallRow {
  id: string
  accountId: string
  direction: CallDirection
  channel: CallChannel
  appointmentId: string | null
  contactId: string | null
  attempt: number | null
  fromNumber: string | null
  toNumber: string | null
  status: CallStatus
  outcome: CallOutcome | null
  menuPath: string | null
  digits: string | null
  providerCallSid: string | null
  error: string | null
  createdBy: string | null
  createdAt: string
}

export const CALL_COLUMNS =
  'id, account_id, direction, channel, appointment_id, contact_id, attempt, from_number, to_number, status, outcome, menu_path, digits, provider_call_sid, error, created_by, created_at'

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function callRowFromDb(raw: Record<string, unknown>): CallRow {
  return {
    id: String(raw.id),
    accountId: String(raw.account_id),
    direction: raw.direction === 'inbound' ? 'inbound' : 'outbound',
    channel: raw.channel === 'manual' ? 'manual' : 'robot',
    appointmentId: str(raw.appointment_id),
    contactId: str(raw.contact_id),
    attempt: typeof raw.attempt === 'number' ? raw.attempt : null,
    fromNumber: str(raw.from_number),
    toNumber: str(raw.to_number),
    status: (str(raw.status) ?? 'queued') as CallStatus,
    outcome: (str(raw.outcome) as CallOutcome | null) ?? null,
    menuPath: str(raw.menu_path),
    digits: str(raw.digits),
    providerCallSid: str(raw.provider_call_sid),
    error: str(raw.error),
    createdBy: str(raw.created_by),
    createdAt: str(raw.created_at) ?? '',
  }
}

/**
 * Carga una llamada por id. Un id que no es uuid nunca llega a la base
 * (daría 22P02). Un fallo de lectura LANZA: no es "la llamada no existe".
 */
export async function loadCallRow(db: SupabaseClient, callId: string): Promise<CallRow | null> {
  if (!isUuid(callId)) return null
  const { data, error } = await db.from('booking_calls').select(CALL_COLUMNS).eq('id', callId).maybeSingle()
  if (error) throw new Error(`No se pudo leer la llamada: ${error.message}`)
  return data ? callRowFromDb(data as Record<string, unknown>) : null
}

// ------------------------------------------------------------
// El CallSid ata la fila a UNA llamada de Telnyx
// ------------------------------------------------------------

/** El `CallSid` cabe en la columna (CHECK de la migración: máx. 100). */
export const SID_MAX = 100

/** El `CallSid` de un formulario: sin espacios y con el largo de la columna; '' si no hay. */
export function readCallSid(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, SID_MAX) : ''
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505'

export type SidBinding = 'ok' | 'mismatch'

/**
 * Ata la fila al `CallSid` del pedido, o comprueba que sea el que ya tiene.
 * La URL firmada (`t`) prueba que el pedido es de nuestra llamada, pero quien la
 * vea (un log, un proxy) podría repetirla desde otra llamada: el `CallSid` es lo
 * que distingue una llamada de Telnyx de otra.
 *
 *   - La fila ya tiene `provider_call_sid`: el pedido tiene que traer el MISMO;
 *     otro, o ninguno, es `mismatch`.
 *   - La fila no tiene: se escribe el del pedido con un UPDATE condicional
 *     (`provider_call_sid IS NULL`), así dos pedidos a la vez no se pisan; si otro
 *     ganó, se vuelve a leer y solo pasa quien trajo el mismo `CallSid`.
 *   - Un 23505 (índice único parcial de `provider_call_sid`) significa que ese
 *     `CallSid` ya es de OTRA fila: `mismatch`.
 *   - Sin `CallSid` ni en la fila ni en el pedido no hay nada que atar: `ok`.
 *
 * Un `mismatch` es un rechazo sin efectos: quien llama no actualiza nada y
 * responde con una despedida (`hangupOnlyXml`) en los webhooks de TeXML; el aviso
 * de estado también responde 200, porque Telnyx no lee su respuesta. Un fallo de
 * la base LANZA (el webhook responde 500 y Telnyx puede reintentar).
 */
export async function bindCallSid(db: SupabaseClient, call: CallRow, rawSid: unknown): Promise<SidBinding> {
  const sid = readCallSid(rawSid)
  if (call.providerCallSid) return sid === call.providerCallSid ? 'ok' : 'mismatch'
  if (sid === '') return 'ok'

  const { data, error } = await db
    .from('booking_calls')
    .update({ provider_call_sid: sid })
    .eq('id', call.id)
    .is('provider_call_sid', null)
    .select('id')
  if (error) {
    if (isUniqueViolation(error)) return 'mismatch'
    throw new Error(`No se pudo guardar el CallSid de la llamada: ${error.message}`)
  }
  if (((data ?? []) as unknown[]).length > 0) return 'ok'

  // Otro pedido la ató antes que este: solo pasa si fue con el mismo CallSid.
  const current = await loadCallRow(db, call.id)
  return current?.providerCallSid === sid ? 'ok' : 'mismatch'
}

/** Cambia columnas de la llamada. Lanza si la base lo rechaza. */
export async function updateCall(
  db: SupabaseClient,
  callId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('booking_calls').update(patch).eq('id', callId)
  if (error) throw new Error(`No se pudo guardar la llamada: ${error.message}`)
}

/**
 * Pone el resultado de la llamada SOLO si todavía no tiene uno de los valores
 * de `from` (por defecto, ninguno). Devuelve true si esta escritura fue la que
 * lo puso: quien gana hace el efecto (cancelar, avisar); un reintento no.
 */
export async function claimOutcome(
  db: SupabaseClient,
  callId: string,
  outcome: CallOutcome,
  options: { from?: readonly (CallOutcome | null)[]; extra?: Record<string, unknown> } = {},
): Promise<boolean> {
  const sources = options.from ?? [null]
  for (const source of sources) {
    const query = db
      .from('booking_calls')
      .update({ outcome, ...options.extra })
      .eq('id', callId)
    const { data, error } = await (source === null ? query.is('outcome', null) : query.eq('outcome', source)).select('id')
    if (error) throw new Error(`No se pudo guardar el resultado de la llamada: ${error.message}`)
    if (((data ?? []) as unknown[]).length > 0) return true
  }
  return false
}

/** Deshace un resultado que se reclamó y cuyo efecto falló (mejor esfuerzo). */
export async function releaseOutcome(db: SupabaseClient, callId: string, outcome: CallOutcome): Promise<void> {
  try {
    await db.from('booking_calls').update({ outcome: null }).eq('id', callId).eq('outcome', outcome)
  } catch {
    // Mejor esfuerzo: si no se puede soltar, el resultado queda y se ve en la lista.
  }
}

/** Las teclas marcadas, separadas por `>` ("2>1"). Si no cabe en 60, no agrega. */
export function appendMenuPath(path: string | null | undefined, key: string): string {
  const current = path ?? ''
  const next = current === '' ? key : `${current}>${key}`
  return next.length > MENU_PATH_MAX ? current : next
}

/** Un `menu_path` que viene de una URL: solo teclas y `>`, y no más de 60. */
export function readMenuPath(value: string | null | undefined): string {
  return typeof value === 'string' && /^[0-9*#>]{0,60}$/.test(value) ? value : ''
}

/** Recorta un texto al largo máximo de la columna `error`. */
export function truncateError(text: string): string {
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text
}

// ------------------------------------------------------------
// La cita de una llamada
// ------------------------------------------------------------

/** Estados en los que una cita todavía se puede confirmar o cancelar. */
export const ACTIVE_APPOINTMENT_STATUSES = ['pending', 'confirmed'] as const

export interface CallAppointment {
  id: string
  contactId: string
  staffId: string | null
  startsAt: Date
  status: string
  /** Cuándo el paciente dijo que va; null si todavía no. */
  attendanceConfirmedAt: string | null
}

/** Lee la cita de la llamada, acotada a la cuenta. Un fallo de lectura LANZA. */
export async function loadCallAppointment(
  db: SupabaseClient,
  accountId: string,
  appointmentId: string,
): Promise<CallAppointment | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, contact_id, staff_id, starts_at, status, attendance_confirmed_at')
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la cita de la llamada: ${error.message}`)
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: String(row.id),
    contactId: String(row.contact_id),
    staffId: str(row.staff_id),
    startsAt: new Date(String(row.starts_at)),
    status: String(row.status),
    attendanceConfirmedAt: str(row.attendance_confirmed_at),
  }
}

/** Activa = pendiente o confirmada, y todavía no empezó. */
export function isActiveAppointment(appointment: CallAppointment, now: Date): boolean {
  return (
    (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(appointment.status) &&
    appointment.startsAt.getTime() > now.getTime()
  )
}
