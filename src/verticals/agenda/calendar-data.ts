// ============================================================
// Datos del calendario del panel (/agenda/calendario).
//
// Lee con el cliente del navegador (RLS: los miembros de la cuenta leen
// citas, equipo, horarios, bloqueos, contactos y pacientes). No escribe
// nada: crear, mover y cancelar van por las rutas de la API
// (calendar-api.ts). Igual que /agenda, trae el nombre de servicio,
// profesional y contacto con consultas aparte, sin embeds de PostgREST.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { AppointmentStatus } from './appointments'
import { addDaysToKey, startOfZonedDay } from './agent/time'
import { isMissingMigrationError } from './panel'

export interface CalendarService {
  id: string
  name: string
  durationMinutes: number
  isActive: boolean
}

export interface CalendarStaff {
  id: string
  name: string
  isActive: boolean
}

export interface CalendarWorkBlock {
  staffId: string
  /** 0 = domingo … 6 = sábado. */
  weekday: number
  /** 'HH:MM:SS' como lo devuelve Postgres. */
  startTime: string
  endTime: string
}

export interface CalendarTimeOff {
  id: string
  staffId: string
  startsAt: Date
  endsAt: Date
  reason: string | null
}

export interface CalendarAppointment {
  id: string
  startsAt: Date
  endsAt: Date
  status: AppointmentStatus
  staffId: string | null
  serviceId: string | null
  serviceName: string | null
  contactId: string
  contactName: string | null
  contactPhone: string | null
  /** Solo clínicas: quien va a la consulta. */
  patientName: string | null
  conversationId: string | null
  /** El paciente dijo que va (botón del recordatorio, llamada o recepción). */
  patientConfirmed: boolean
}

export interface CalendarData {
  services: CalendarService[]
  staff: CalendarStaff[]
  /** Qué atiende cada profesional (la misma relación que usa el bot). */
  staffServices: { staffId: string; serviceId: string }[]
  workBlocks: CalendarWorkBlock[]
  timeOff: CalendarTimeOff[]
  appointments: CalendarAppointment[]
}

export interface ContactOption {
  id: string
  name: string | null
  phone: string | null
}

export interface PatientOption {
  id: string
  fullName: string
}

/** De dónde salen los contactos y pacientes de "Nueva cita" (la vista previa pone los suyos). */
export interface ContactSource {
  search(query: string): Promise<ContactOption[]>
  patients(contactId: string): Promise<PatientOption[]>
}

/**
 * Nombre para mostrar: paciente (clínica), si no el contacto, si no el texto
 * de respaldo. Nunca el celular: este título se pinta en la cuadrícula, a la
 * vista de cualquier rol; el celular solo va en el detalle de la cita.
 */
export function appointmentTitle(
  a: { patientName: string | null; contactName: string | null },
  fallback: string,
): string {
  return a.patientName?.trim() || a.contactName?.trim() || fallback
}

// ------------------------------------------------------------
// Búsqueda de contactos
// ------------------------------------------------------------

export type ContactQuery = { kind: 'name' | 'phone'; text: string }

const QUERY_MAX = 60
/** Signos que tienen significado dentro de un filtro `or(...)` de PostgREST o de un `ilike`. */
const FILTER_SYNTAX = /[,()%_*\\"'`:;]/g

/**
 * Lo que la recepción escribió → qué buscar. Mayormente números = celular
 * (solo los dígitos, sin +, espacios ni guiones); si no, nombre. Devuelve
 * null si es muy corto para buscar o si no queda nada útil.
 */
export function parseContactQuery(raw: string): ContactQuery | null {
  const trimmed = raw.trim().slice(0, 200)
  const digits = trimmed.replace(/\D/g, '')
  const letters = trimmed.replace(/[^\p{L}]/gu, '')

  if (digits.length >= 3 && letters.length === 0) {
    return { kind: 'phone', text: digits.slice(0, QUERY_MAX) }
  }
  if (digits.length > 0 && digits.length < 3 && letters.length === 0) return null

  const text = trimmed.replace(FILTER_SYNTAX, '').replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX)
  if ([...text.replace(/\s/g, '')].length < 2) return null
  return { kind: 'name', text }
}

/** Hasta 8 contactos de la cuenta que coincidan con lo escrito. */
export async function searchContacts(
  db: SupabaseClient,
  accountId: string,
  raw: string,
): Promise<ContactOption[]> {
  const query = parseContactQuery(raw)
  if (!query) return []
  const column = query.kind === 'phone' ? 'phone' : 'name'
  const { data, error } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', accountId)
    .ilike(column, `%${query.text}%`)
    .order('name', { ascending: true })
    .limit(8)
  if (error) throw new Error('contact search failed')
  return ((data ?? []) as { id: string; name: string | null; phone: string | null }[]).map((c) => ({
    id: c.id,
    name: c.name,
    phone: c.phone,
  }))
}

/** Los pacientes registrados con el número de ese contacto (clínicas). */
export async function listContactPatients(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<PatientOption[]> {
  const { data, error } = await db
    .from('clinic_patients')
    .select('id, full_name')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(20)
  if (error) throw new Error('patients load failed')
  return ((data ?? []) as { id: string; full_name: string }[]).map((p) => ({
    id: p.id,
    fullName: p.full_name,
  }))
}

// ------------------------------------------------------------
// Carga del rango visible
// ------------------------------------------------------------

export class CalendarLoadError extends Error {
  constructor(
    message: string,
    readonly migrationMissing: boolean,
  ) {
    super(message)
    this.name = 'CalendarLoadError'
  }
}

interface AppointmentRow {
  id: string
  starts_at: string
  ends_at: string
  status: string
  service_id: string | null
  staff_id: string | null
  contact_id: string
  conversation_id: string | null
  patient_id?: string | null
  attendance_confirmed_at?: string | null
}

const BASE_COLS = 'id, starts_at, ends_at, status, service_id, staff_id, contact_id, conversation_id'

const ids = (values: (string | null | undefined)[]): string[] => [
  ...new Set(values.filter((v): v is string => Boolean(v))),
]

/**
 * Todo lo que el calendario necesita para los días [fromKey, toKey) (sin el
 * último). `clinic` suma el paciente de cada cita. Lanza `CalendarLoadError`
 * si algo no se pudo leer: nunca se pinta un calendario a medias.
 */
export async function loadCalendarData(
  db: SupabaseClient,
  args: { accountId: string; fromKey: string; toKey: string; clinic: boolean },
): Promise<CalendarData> {
  const { accountId, fromKey, toKey, clinic } = args
  const fromIso = startOfZonedDay(fromKey).toISOString()
  const toIso = startOfZonedDay(toKey).toISOString()

  const appointmentsQuery = (columns: string) =>
    db
      .from('booking_appointments')
      .select(columns)
      .eq('account_id', accountId)
      .gte('starts_at', fromIso)
      .lt('starts_at', toIso)
      .order('starts_at', { ascending: true })
      .limit(1000)

  const optionalCols = `${BASE_COLS}${clinic ? ', patient_id' : ''}, attendance_confirmed_at`

  const [servicesRes, staffRes, linksRes, hoursRes, offRes, apptRes] = await Promise.all([
    db
      .from('booking_services')
      .select('id, name, duration_minutes, is_active')
      .eq('account_id', accountId)
      .order('position', { ascending: true }),
    db
      .from('booking_staff')
      .select('id, name, is_active')
      .eq('account_id', accountId)
      .order('position', { ascending: true }),
    db.from('booking_staff_services').select('staff_id, service_id').eq('account_id', accountId),
    db
      .from('booking_working_hours')
      .select('staff_id, weekday, start_time, end_time')
      .eq('account_id', accountId),
    db
      .from('booking_time_off')
      .select('id, staff_id, starts_at, ends_at, reason')
      .eq('account_id', accountId)
      .lt('starts_at', toIso)
      .gt('ends_at', fromIso),
    appointmentsQuery(optionalCols),
  ])

  // La columna `attendance_confirmed_at` llega con la migración 056: si aún no
  // está, el calendario funciona igual, solo sin la marca de "confirmó que va".
  let apptRows = apptRes.data as unknown as AppointmentRow[] | null
  let apptError = apptRes.error
  if (apptError && isMissingMigrationError(apptError)) {
    const retry = await appointmentsQuery(`${BASE_COLS}${clinic ? ', patient_id' : ''}`)
    apptRows = retry.data as unknown as AppointmentRow[] | null
    apptError = retry.error
  }

  const failed = [servicesRes.error, staffRes.error, linksRes.error, hoursRes.error, offRes.error, apptError].find(
    Boolean,
  )
  if (failed) {
    throw new CalendarLoadError('calendar load failed', isMissingMigrationError(failed))
  }

  const rows = apptRows ?? []
  const contactIds = ids(rows.map((r) => r.contact_id))
  const patientIds = clinic ? ids(rows.map((r) => r.patient_id)) : []

  const [contactsRes, patientsRes] = await Promise.all([
    contactIds.length
      ? db.from('contacts').select('id, name, phone').eq('account_id', accountId).in('id', contactIds)
      : Promise.resolve({ data: [], error: null }),
    patientIds.length
      ? db.from('clinic_patients').select('id, full_name').eq('account_id', accountId).in('id', patientIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (contactsRes.error || patientsRes.error) {
    throw new CalendarLoadError('calendar load failed', false)
  }

  const services = ((servicesRes.data ?? []) as {
    id: string
    name: string
    duration_minutes: number
    is_active: boolean
  }[]).map((s) => ({
    id: s.id,
    name: s.name,
    durationMinutes: Number(s.duration_minutes),
    isActive: s.is_active,
  }))
  const serviceNames = new Map(services.map((s) => [s.id, s.name]))
  const contacts = new Map(
    ((contactsRes.data ?? []) as { id: string; name: string | null; phone: string | null }[]).map((c) => [c.id, c]),
  )
  const patients = new Map(
    ((patientsRes.data ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]),
  )

  return {
    services,
    staff: ((staffRes.data ?? []) as { id: string; name: string; is_active: boolean }[]).map((s) => ({
      id: s.id,
      name: s.name,
      isActive: s.is_active,
    })),
    staffServices: ((linksRes.data ?? []) as { staff_id: string; service_id: string }[]).map((l) => ({
      staffId: l.staff_id,
      serviceId: l.service_id,
    })),
    workBlocks: (
      (hoursRes.data ?? []) as { staff_id: string; weekday: number; start_time: string; end_time: string }[]
    ).map((h) => ({
      staffId: h.staff_id,
      weekday: Number(h.weekday),
      startTime: h.start_time,
      endTime: h.end_time,
    })),
    timeOff: (
      (offRes.data ?? []) as {
        id: string
        staff_id: string
        starts_at: string
        ends_at: string
        reason: string | null
      }[]
    ).map((o) => ({
      id: o.id,
      staffId: o.staff_id,
      startsAt: new Date(o.starts_at),
      endsAt: new Date(o.ends_at),
      reason: o.reason,
    })),
    appointments: rows.map((row) => {
      const contact = contacts.get(row.contact_id)
      return {
        id: row.id,
        startsAt: new Date(row.starts_at),
        endsAt: new Date(row.ends_at),
        status: row.status as AppointmentStatus,
        staffId: row.staff_id,
        serviceId: row.service_id,
        serviceName: row.service_id ? (serviceNames.get(row.service_id) ?? null) : null,
        contactId: row.contact_id,
        contactName: contact?.name ?? null,
        contactPhone: contact?.phone ?? null,
        patientName: row.patient_id ? (patients.get(row.patient_id) ?? null) : null,
        conversationId: row.conversation_id,
        patientConfirmed: Boolean(row.attendance_confirmed_at),
      }
    }),
  }
}

/** Primer día (incluido) y último (excluido) que hay que cargar para una vista. */
export function rangeKeys(view: 'day' | 'week', dateKey: string, mondayKey: string): { fromKey: string; toKey: string } {
  return view === 'day'
    ? { fromKey: dateKey, toKey: addDaysToKey(dateKey, 1) }
    : { fromKey: mondayKey, toKey: addDaysToKey(mondayKey, 7) }
}
