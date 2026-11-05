// ============================================================
// Llamadas que la recepción hace a mano y anota en "Para llamar".
//
// Cada anotación es una fila de `booking_calls` con `channel = 'manual'` y
// `direction = 'outbound'`, a nombre de quien la hizo (la RLS de la migración
// 056 exige `created_by = auth.uid()`). El intento va de 1 a 3: la base no
// admite más, así que con 3 ya anotadas la cuarta no se inserta.
//
// Aquí vive lo que la ruta necesita:
//   - `parseManualCallBody` (puro): revisa la forma del cuerpo.
//   - `loadCallTarget`: la cita, acotada por cuenta.
//   - `writeAttendanceConfirmed`: "el paciente dijo que va". A diferencia de
//     `markAppointmentConfirmed` del bot, solo escribe si la cita sigue activa
//     y nadie la confirmó antes: una cita que alguien canceló entre tanto nunca
//     se revive, ni se pisa la hora de una confirmación que ya quedó. No toca
//     `confirmed_at`, que es la confirmación de la reserva que puso el bot.
//   - `countManualCalls` e `insertManualCall`: el historial. Un índice único
//     (cita + intento, solo manuales) evita que dos personas anoten el mismo
//     intento a la vez; la segunda recibe `duplicate`.
//
// Las lecturas y escrituras que deciden algo LANZAN si fallan. Ni el nombre
// ni el teléfono del paciente van a un error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { ACTIVE_STATUSES } from './active-statuses'
import type { EditableAppointment } from './panel-booking-repo'
import { isUuid } from './panel-booking-input'
import type { CallOutcome, CallStatus } from './voice/calls-repo'

/** Lo que la recepción puede anotar tras una llamada. */
export const MANUAL_OUTCOMES = ['confirmed', 'cancelled', 'no_response', 'wrong_number'] as const
export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number]

/** Tope de intentos manuales por cita (CHECK `attempt BETWEEN 1 AND 3` de la base). */
export const MANUAL_ATTEMPTS_MAX = 3

/** Estado con el que queda la fila según lo que pasó en la llamada. */
export const MANUAL_STATUS: Record<ManualOutcome, CallStatus> = {
  confirmed: 'completed',
  cancelled: 'completed',
  wrong_number: 'completed',
  no_response: 'no_answer',
}

// ------------------------------------------------------------
// Cuerpo
// ------------------------------------------------------------

export interface ManualCallInput {
  appointmentId: string
  outcome: ManualOutcome
  /** Solo cuenta si la cita se cancela: avisar al paciente por WhatsApp. */
  notify: boolean
}

export type ManualCallParse = { ok: true; value: ManualCallInput } | { ok: false; message: string }

const BAD_BODY = 'La solicitud no es válida. Recarga la página e intenta de nuevo.'

export function parseManualCallBody(body: unknown): ManualCallParse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: BAD_BODY }
  const record = body as Record<string, unknown>

  if (!isUuid(record.appointment_id)) return { ok: false, message: 'La cita elegida no es válida.' }
  const outcome = record.outcome
  if (typeof outcome !== 'string' || !(MANUAL_OUTCOMES as readonly string[]).includes(outcome)) {
    return { ok: false, message: 'El resultado de la llamada no es válido.' }
  }
  if (record.notify !== undefined && typeof record.notify !== 'boolean') return { ok: false, message: BAD_BODY }

  return {
    ok: true,
    value: {
      appointmentId: record.appointment_id,
      outcome: outcome as ManualOutcome,
      notify: record.notify !== false,
    },
  }
}

// ------------------------------------------------------------
// La cita
// ------------------------------------------------------------

export interface CallTarget {
  /** Lo que `writeCancel` necesita. */
  appointment: EditableAppointment
  contactId: string
  /** Cuándo el paciente dijo que va; null si todavía no. */
  attendanceConfirmedAt: string | null
}

export async function loadCallTarget(
  db: SupabaseClient,
  accountId: string,
  appointmentId: string,
): Promise<CallTarget | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, status, starts_at, ends_at, staff_id, service_id, updated_at, contact_id, attendance_confirmed_at')
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la cita: ${error.message}`)
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    appointment: {
      id: row.id as string,
      status: row.status as string,
      startsAt: new Date(row.starts_at as string),
      endsAt: new Date(row.ends_at as string),
      staffId: (row.staff_id as string | null) ?? null,
      serviceId: (row.service_id as string | null) ?? null,
      updatedAt: row.updated_at as string,
    },
    contactId: row.contact_id as string,
    attendanceConfirmedAt: (row.attendance_confirmed_at as string | null) ?? null,
  }
}

/** Activa = pendiente o confirmada, y todavía no empezó. */
export function isCallable(target: CallTarget, now: Date): boolean {
  return ACTIVE_STATUSES.includes(target.appointment.status) && target.appointment.startsAt.getTime() > now.getTime()
}

/**
 * El paciente dijo que va: confirma la cita y deja `attendance_confirmed_at`
 * (migración 056). Solo escribe si la cita sigue activa y todavía sin
 * `attendance_confirmed_at`; devuelve false si nadie la pudo actualizar (la
 * cancelaron o la confirmó otra persona entre tanto). `confirmed_at` no se
 * toca: sigue siendo la hora en que el bot confirmó la reserva.
 */
export async function writeAttendanceConfirmed(
  db: SupabaseClient,
  args: { accountId: string; appointmentId: string; nowIso: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('booking_appointments')
    .update({
      status: 'confirmed',
      attendance_confirmed_at: args.nowIso,
      updated_at: args.nowIso,
    })
    .eq('id', args.appointmentId)
    .eq('account_id', args.accountId)
    .in('status', [...ACTIVE_STATUSES])
    .is('attendance_confirmed_at', null)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`No se pudo confirmar la cita: ${error.message}`)
  return data !== null
}

// ------------------------------------------------------------
// El historial
// ------------------------------------------------------------

/** Cuántas llamadas manuales tiene ya anotadas la cita. */
export async function countManualCalls(db: SupabaseClient, accountId: string, appointmentId: string): Promise<number> {
  const { data, error } = await db
    .from('booking_calls')
    .select('id')
    .eq('account_id', accountId)
    .eq('appointment_id', appointmentId)
    .eq('direction', 'outbound')
    .eq('channel', 'manual')
  if (error) throw new Error(`No se pudieron leer las llamadas de la cita: ${error.message}`)
  return ((data ?? []) as unknown[]).length
}

/** Código de Postgres para una violación de índice único. */
const UNIQUE_VIOLATION = '23505'

/**
 * Anota la llamada. `duplicate`: otra persona anotó ese mismo intento en el
 * mismo instante (índice único de la migración 056), así que ya está en el
 * historial y no se repite. Cualquier otro fallo lanza.
 */
export async function insertManualCall(
  db: SupabaseClient,
  args: {
    accountId: string
    appointmentId: string
    contactId: string
    userId: string
    attempt: number
    outcome: ManualOutcome
    nowIso: string
  },
): Promise<'inserted' | 'duplicate'> {
  const { error } = await db.from('booking_calls').insert({
    account_id: args.accountId,
    direction: 'outbound',
    channel: 'manual',
    appointment_id: args.appointmentId,
    contact_id: args.contactId,
    attempt: args.attempt,
    status: MANUAL_STATUS[args.outcome],
    outcome: args.outcome satisfies CallOutcome,
    created_by: args.userId,
    finished_at: args.nowIso,
  })
  if (error?.code === UNIQUE_VIOLATION) return 'duplicate'
  if (error) throw new Error(`No se pudo guardar la llamada: ${error.message}`)
  return 'inserted'
}
