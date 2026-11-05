// ============================================================
// Lecturas y escrituras de la llamada entrante (T14):
//
//   - `findInboundAccount`: la cuenta dueña del número que se marcó
//     (`booking_call_settings.inbound_number`, único en toda la plataforma).
//   - `findOrCreateInboundCall`: la fila de `booking_calls` de la llamada. Se
//     crea en el primer pedido y, si Telnyx lo reintenta, se reutiliza por su
//     `CallSid` en vez de duplicarla.
//   - `loadNextAppointment`: la próxima cita activa de quien llama, lista para
//     decirla (misma regla que `listUpcoming` del bot).
//   - `dialableNumber`: un teléfono escrito a mano → E.164 que se puede marcar.
//
// Todo se escribe con service role. Una lectura que falla LANZA: un error de la
// base no es "este número no existe" ni "no tienes citas". Ni el número ni el
// nombre de quien llama van a ningún mensaje de error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadClinicReminderInfo } from '@/modules/clinica/reminder-info'

import { loadStaffName } from '../agent/db'
import {
  ACTIVE_APPOINTMENT_STATUSES,
  CALL_COLUMNS,
  callRowFromDb,
  type CallRow,
} from './calls-repo'
import type { InboundNextAppointment } from './inbound-flow'
import { spokenStaff, spokenWhen } from './scripts'
import { CALL_SETTINGS_COLUMNS, callSettingsFromRow, toE164, type CallSettings } from './settings'

/** El `CallSid` cabe en la columna (máx. 100). */
const SID_MAX = 100

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

/** La llamada entrante con ese `CallSid`, o null. */
export async function findCallBySid(db: SupabaseClient, sid: string): Promise<CallRow | null> {
  if (!sid) return null
  const { data, error } = await db
    .from('booking_calls')
    .select(CALL_COLUMNS)
    .eq('direction', 'inbound')
    .eq('provider_call_sid', sid.slice(0, SID_MAX))
    .order('created_at', { ascending: true })
    .limit(1)
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
 * `CallSid`) devuelve la que ya existe. La base no tiene un único por `CallSid`,
 * así que dos reintentos EXACTAMENTE a la vez podrían crear dos filas; es raro y
 * solo deja una fila sobrante sin resultado.
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
 * día y la hora ya dichos. En una clínica lleva el nombre del paciente. Los
 * nombres son un extra: si no se pueden leer, la cita se lee sin ellos.
 */
export async function loadNextAppointment(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; clinic: boolean; now: Date },
): Promise<InboundNextAppointment | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, staff_id, starts_at')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .in('status', [...ACTIVE_APPOINTMENT_STATUSES])
    .gt('starts_at', args.now.toISOString())
    .order('starts_at')
    .limit(1)
  if (error) throw new Error(`No se pudieron leer las citas: ${error.message}`)
  const row = ((data ?? []) as { id: string; staff_id: string | null; starts_at: string }[])[0]
  if (!row) return null

  const [staffName, patient] = await Promise.all([
    row.staff_id ? loadStaffName(db, args.accountId, row.staff_id).catch(() => null) : null,
    // Solo una clínica nombra al paciente; las demás dicen "tu próxima cita".
    args.clinic
      ? loadClinicReminderInfo(db, { accountId: args.accountId, appointmentId: row.id, contactId: args.contactId })
          .then((info) => info.patientName)
          .catch(() => null)
      : null,
  ])
  const when = spokenWhen(new Date(row.starts_at), args.now)
  return {
    id: row.id,
    speech: { patient, day: when.day, time: when.time, staff: spokenStaff(staffName) || null },
  }
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
