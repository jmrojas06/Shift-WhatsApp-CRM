// ============================================================
// Lista "Para llamar" de /agenda (diseño §4.7).
//
// Son las citas activas de las próximas 48 horas que todavía no están
// confirmadas por el paciente y que a alguien le toca llamar:
//   - el recordatorio de 24 h salió hace al menos `call_after_minutes`
//     y el paciente no contestó (motivo `reminder_unanswered`), o
//   - el último intento del robot las dejó para una persona: pidió hablar con
//     alguien, nadie contestó al asesor, no marcó nada o Telnyx rechazó la
//     llamada.
//
// Se queda fuera: lo que ya no está activo, ya empezó, pasa de 48 h, ya
// confirmó el paciente, o es de un contacto con la etiqueta `no-llamar`.
//
// `buildCallList` es puro (lo prueba call-list.test.ts); `loadCallList` lee
// lo que necesita con el cliente del usuario (la RLS deja leer a los
// miembros) y siempre acotado por `account_id`. Una lectura que falla LANZA
// `CallListError`: una lista a medias haría creer que no hay nada que llamar.
//
// Ni el nombre ni el teléfono de un paciente van a un mensaje de error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { ACTIVE_STATUSES } from './active-statuses'
import { accountHasClinic } from './panel-booking-repo'
import { isMissingMigrationError } from './panel'
import {
  IN_FLIGHT_STATUSES,
  type CallOutcome,
  type CallStatus,
} from './voice/calls-repo'
import {
  hasInFlightRobotCall,
  HARD_MAX_ATTEMPTS,
  NO_CALL_TAG,
  nextRobotAttempt,
  type CallHistoryItem,
} from './voice/outbound-runner'
import { CALL_SETTINGS_COLUMNS, callSettingsFromRow } from './voice/settings'

/** Cuánto hacia adelante mira la lista. */
export const CALL_LIST_HORIZON_HOURS = 48
/** Citas que se leen por pasada: más de eso en 48 h no cabe en una pantalla de recepción. */
const APPOINTMENT_LIMIT = 300

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------

export type CallListReason =
  | 'reminder_unanswered'
  | 'robot_human'
  | 'robot_advisor_missed'
  | 'robot_no_response'
  | 'robot_failed'

/** Lo último que pasó en una llamada, para mostrarlo en la fila. */
export interface CallListLastCall {
  outcome: CallOutcome | null
  status: CallStatus
  /** ISO. */
  at: string
}

export interface CallListRow {
  appointmentId: string
  /** ISO. */
  startsAt: string
  contactId: string
  /** Quien va a la cita en una clínica; null si no hay paciente. */
  patientName: string | null
  contactName: string | null
  /** Tal como está guardado en el contacto (dígitos); null si no tiene. */
  phone: string | null
  staffName: string | null
  reason: CallListReason
  /** Intentos del robot a esta cita, también los que Telnyx rechazó (gastan el número de intento). */
  robotAttempts: number
  manualAttempts: number
  lastRobot: CallListLastCall | null
  lastManual: CallListLastCall | null
  /** El robot está llamando ahora mismo. */
  robotInProgress: boolean
  /** Se le puede pedir otra llamada al robot (quedan intentos y no hay una en curso). */
  canRobotCall: boolean
}

export interface CallListAppointment {
  id: string
  /** ISO. */
  startsAt: string
  status: string
  contactId: string
  staffId: string | null
  patientId: string | null
  reminderSentAt: string | null
  attendanceConfirmedAt: string | null
}

/** Una llamada saliente de una cita (del robot o anotada a mano). */
export interface CallListCall extends CallHistoryItem {
  appointmentId: string
}

export interface BuildCallListArgs {
  now: Date
  callAfterMinutes: number
  appointments: readonly CallListAppointment[]
  calls: readonly CallListCall[]
  contacts: readonly { id: string; name: string | null; phone: string | null }[]
  staff: readonly { id: string; name: string }[]
  patients: readonly { id: string; fullName: string }[]
  /** Contactos con la etiqueta `no-llamar`. */
  noCallContactIds: ReadonlySet<string>
}

// ------------------------------------------------------------
// Armado (puro)
// ------------------------------------------------------------

/** El robot ya no está llamando: la llamada terminó (con o sin resultado guardado). */
const FINISHED_WITHOUT_RESULT: readonly CallStatus[] = ['completed', 'no_answer', 'busy', 'canceled']

const isRobotCall = (call: CallListCall): boolean => call.direction === 'outbound' && call.channel === 'robot'
const isManualCall = (call: CallListCall): boolean => call.direction === 'outbound' && call.channel === 'manual'

/** Más reciente primero; a la misma hora, el intento mayor. */
const newestFirst = (a: CallListCall, b: CallListCall): number =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || (b.attempt ?? 0) - (a.attempt ?? 0)

const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? '').replace(/\s+/gu, ' ').trim()
  return text === '' ? null : text
}

/**
 * ¿Lo último que hizo el robot deja la cita para una persona? Una llamada que
 * sigue sonando no es un resultado; una "en curso" de hace mucho se da por
 * perdida (igual que el runner) y cuenta como que nadie contestó.
 */
function robotReason(last: CallListCall | undefined, now: Date): CallListReason | null {
  if (!last) return null
  if (last.status === 'failed') return 'robot_failed'
  if (last.outcome === 'human') return 'robot_human'
  if (last.outcome === 'advisor_missed') return 'robot_advisor_missed'
  if (last.outcome === 'no_response') return 'robot_no_response'
  if (last.outcome !== null) return null

  if (FINISHED_WITHOUT_RESULT.includes(last.status)) return 'robot_no_response'
  if (IN_FLIGHT_STATUSES.includes(last.status) && !hasInFlightRobotCall([last], now)) return 'robot_no_response'
  return null
}

const lastCallOf = (call: CallListCall | undefined): CallListLastCall | null =>
  call ? { outcome: call.outcome, status: call.status, at: call.createdAt } : null

export function buildCallList(args: BuildCallListArgs): CallListRow[] {
  const nowMs = args.now.getTime()
  const horizonMs = nowMs + CALL_LIST_HORIZON_HOURS * 3_600_000
  const reminderCutoffMs = nowMs - args.callAfterMinutes * 60_000

  const callsByAppointment = new Map<string, CallListCall[]>()
  for (const call of args.calls) {
    callsByAppointment.set(call.appointmentId, [...(callsByAppointment.get(call.appointmentId) ?? []), call])
  }
  const contacts = new Map(args.contacts.map((contact) => [contact.id, contact]))
  const staff = new Map(args.staff.map((member) => [member.id, member.name]))
  const patients = new Map(args.patients.map((patient) => [patient.id, patient.fullName]))

  const rows: CallListRow[] = []
  for (const appointment of args.appointments) {
    const startsMs = new Date(appointment.startsAt).getTime()
    if (!ACTIVE_STATUSES.includes(appointment.status)) continue
    if (appointment.attendanceConfirmedAt) continue
    if (!(startsMs > nowMs && startsMs <= horizonMs)) continue
    if (args.noCallContactIds.has(appointment.contactId)) continue

    const calls = (callsByAppointment.get(appointment.id) ?? []).filter((call) => isRobotCall(call) || isManualCall(call))
    const robotCalls = calls.filter(isRobotCall).sort(newestFirst)
    const manualCalls = calls.filter(isManualCall).sort(newestFirst)

    const reminderMs = appointment.reminderSentAt ? new Date(appointment.reminderSentAt).getTime() : null
    const reminderDue = reminderMs !== null && reminderMs <= reminderCutoffMs
    const reason = robotReason(robotCalls[0], args.now) ?? (reminderDue ? 'reminder_unanswered' : null)
    if (!reason) continue

    const contact = contacts.get(appointment.contactId)
    const robotInProgress = hasInFlightRobotCall(robotCalls, args.now)
    rows.push({
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
      contactId: appointment.contactId,
      patientName: appointment.patientId ? clean(patients.get(appointment.patientId)) : null,
      contactName: clean(contact?.name),
      phone: clean(contact?.phone),
      staffName: appointment.staffId ? clean(staff.get(appointment.staffId)) : null,
      reason,
      robotAttempts: robotCalls.length,
      manualAttempts: manualCalls.length,
      lastRobot: lastCallOf(robotCalls[0]),
      lastManual: lastCallOf(manualCalls[0]),
      robotInProgress,
      canRobotCall: !robotInProgress && nextRobotAttempt(robotCalls) <= HARD_MAX_ATTEMPTS,
    })
  }

  return rows.sort(
    (a, b) =>
      new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() ||
      (a.appointmentId < b.appointmentId ? -1 : a.appointmentId > b.appointmentId ? 1 : 0),
  )
}

// ------------------------------------------------------------
// Lectura
// ------------------------------------------------------------

/** La lista no se pudo leer. `missingMigration`: a la base le falta la 056 (la pantalla no avisa de error). */
export class CallListError extends Error {
  constructor(
    message: string,
    readonly missingMigration: boolean,
  ) {
    super(message)
    this.name = 'CallListError'
  }
}

function failRead(what: string, error: { message: string; code?: string | null }): never {
  throw new CallListError(`No se pudo leer ${what}: ${error.message}`, isMissingMigrationError(error))
}

const unique = (values: (string | null)[]): string[] => [...new Set(values.filter((v): v is string => Boolean(v)))]

export interface LoadedCallList {
  rows: CallListRow[]
  /** Las llamadas salientes están prendidas en la cuenta. */
  outboundEnabled: boolean
}

export async function loadCallList(
  db: SupabaseClient,
  args: { accountId: string; now: Date },
): Promise<LoadedCallList> {
  const { accountId, now } = args

  const { data: settingsRow, error: settingsError } = await db
    .from('booking_call_settings')
    .select(CALL_SETTINGS_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (settingsError) failRead('la configuración de llamadas', settingsError)
  const settings = callSettingsFromRow((settingsRow as Record<string, unknown> | null) ?? null)

  const horizonIso = new Date(now.getTime() + CALL_LIST_HORIZON_HOURS * 3_600_000).toISOString()
  const { data: appointmentRows, error: appointmentError } = await db
    .from('booking_appointments')
    .select('id, starts_at, status, contact_id, staff_id, reminder_sent_at, attendance_confirmed_at')
    .eq('account_id', accountId)
    .in('status', [...ACTIVE_STATUSES])
    .is('attendance_confirmed_at', null)
    .gt('starts_at', now.toISOString())
    .lte('starts_at', horizonIso)
    .order('starts_at', { ascending: true })
    .limit(APPOINTMENT_LIMIT)
  if (appointmentError) failRead('las citas', appointmentError)

  const base = ((appointmentRows ?? []) as Record<string, unknown>[]).map(
    (row): CallListAppointment => ({
      id: String(row.id),
      startsAt: String(row.starts_at),
      status: String(row.status),
      contactId: String(row.contact_id),
      staffId: (row.staff_id as string | null) ?? null,
      patientId: null,
      reminderSentAt: (row.reminder_sent_at as string | null) ?? null,
      attendanceConfirmedAt: (row.attendance_confirmed_at as string | null) ?? null,
    }),
  )
  if (base.length === 0) return { rows: [], outboundEnabled: settings.outboundEnabled }

  const appointmentIds = base.map((a) => a.id)
  const contactIds = unique(base.map((a) => a.contactId))
  const staffIds = unique(base.map((a) => a.staffId))

  const [contactsRes, staffRes, callsRes, tagRes, clinic] = await Promise.all([
    db.from('contacts').select('id, name, phone').eq('account_id', accountId).in('id', contactIds),
    staffIds.length > 0
      ? db.from('booking_staff').select('id, name').eq('account_id', accountId).in('id', staffIds)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('booking_calls')
      .select('appointment_id, direction, channel, attempt, status, outcome, created_at')
      .eq('account_id', accountId)
      .eq('direction', 'outbound')
      .in('appointment_id', appointmentIds),
    db.from('tags').select('id').eq('account_id', accountId).eq('name', NO_CALL_TAG).maybeSingle(),
    accountHasClinic(db, accountId).catch(() => {
      throw new CallListError('No se pudieron leer los módulos de la cuenta.', false)
    }),
  ])
  if (contactsRes.error) failRead('los contactos', contactsRes.error)
  if (staffRes.error) failRead('a los profesionales', staffRes.error)
  if (callsRes.error) failRead('las llamadas', callsRes.error)
  if (tagRes.error) failRead('las etiquetas', tagRes.error)

  // Quién tiene la etiqueta no-llamar (si la cuenta nunca la creó, nadie).
  let noCallContactIds = new Set<string>()
  const noCallTagId = (tagRes.data as { id?: string } | null)?.id
  if (noCallTagId) {
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', noCallTagId)
      .in('contact_id', contactIds)
    if (error) failRead('las etiquetas de los contactos', error)
    noCallContactIds = new Set(((data ?? []) as { contact_id: string }[]).map((row) => row.contact_id))
  }

  // El paciente de la cita (solo clínicas). Va aparte: la columna es de la 055.
  let patients: { id: string; fullName: string }[] = []
  if (clinic) {
    const { data: links, error: linksError } = await db
      .from('booking_appointments')
      .select('id, patient_id')
      .eq('account_id', accountId)
      .in('id', appointmentIds)
    if (linksError) failRead('los pacientes de las citas', linksError)
    const patientByAppointment = new Map(
      ((links ?? []) as { id: string; patient_id: string | null }[]).map((row) => [row.id, row.patient_id]),
    )
    for (const appointment of base) appointment.patientId = patientByAppointment.get(appointment.id) ?? null

    const patientIds = unique(base.map((a) => a.patientId))
    if (patientIds.length > 0) {
      const { data, error } = await db
        .from('clinic_patients')
        .select('id, full_name')
        .eq('account_id', accountId)
        .in('id', patientIds)
      if (error) failRead('los pacientes', error)
      patients = ((data ?? []) as { id: string; full_name: string }[]).map((row) => ({
        id: row.id,
        fullName: row.full_name,
      }))
    }
  }

  const calls = ((callsRes.data ?? []) as Record<string, unknown>[]).map(
    (row): CallListCall => ({
      appointmentId: String(row.appointment_id),
      direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
      channel: row.channel === 'manual' ? 'manual' : 'robot',
      attempt: typeof row.attempt === 'number' ? row.attempt : null,
      status: row.status as CallStatus,
      outcome: (row.outcome as CallOutcome | null) ?? null,
      createdAt: String(row.created_at),
    }),
  )

  return {
    rows: buildCallList({
      now,
      callAfterMinutes: settings.callAfterMinutes,
      appointments: base,
      calls,
      contacts: ((contactsRes.data ?? []) as { id: string; name: string | null; phone: string | null }[]).map(
        (row) => ({ id: row.id, name: row.name, phone: row.phone }),
      ),
      staff: ((staffRes.data ?? []) as { id: string; name: string }[]).map((row) => ({ id: row.id, name: row.name })),
      patients,
      noCallContactIds,
    }),
    outboundEnabled: settings.outboundEnabled,
  }
}
