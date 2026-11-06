// ============================================================
// Copia de las citas a Google Calendar (Shift → Google, una sola vía).
//
// Cada cita con `google_dirty` se escribe como un evento. El id del evento
// es el uuid de la cita sin guiones, así reintentar nunca duplica.
//
// Reglas (diseño §5):
//   - Hasta 50 citas por corrida, de hace 1 día a 180 días adelante.
//   - pending → tentative · confirmed → confirmed · completed → "✓ " ·
//     no_show → "No vino · " · cancelled → el evento se marca cancelled.
//   - Calendario: el del profesional o, si no tiene, el general de la
//     conexión. Si cambió el destino, se borra la copia del calendario anterior.
//   - Al terminar se limpia `google_dirty` SOLO si `updated_at` sigue igual a lo
//     leído: si la cita cambió mientras tanto, queda pendiente.
//   - Un error de una cita se anota en ella y se sigue con la siguiente.
//     `invalid_grant` revoca la conexión, avisa al dueño una vez y se deja de
//     intentar hasta reconectar.
//
// Ids quemados: si un evento se borra con DELETE (o desde Google), su id queda
// reservado: PUT da 404 y POST da 409, y la cita no se podría volver a copiar.
// Por eso (1) las canceladas se marcan `cancelled` en vez de borrarse (sigue
// siendo restaurable) y (2) si aun así el id base está quemado, se prueban los
// ids `${base}v1`, `${base}v2` y `${base}v3`, siempre en ese orden y siempre
// empezando por el base. No hace falta guardar cuál id se usó.
//
// Privacidad: el evento NO lleva teléfono, notas ni respuestas extra. Un
// nombre o un error de Google nunca se escribe en logs ni en mensajes de error.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleNetworkError,
  buildEventBody,
  deleteEvent,
  eventIdForAppointment,
  putEvent,
  refreshAccessToken,
  type GoogleEventBody,
  type GoogleEventStatus,
} from '@/lib/google/calendar-api'
import { hasModule, type AccountModulesSource } from '@/lib/verticals/registry'
import { decrypt } from '@/lib/whatsapp/encryption'

import { insertNotification } from './agent/db'
import { AGENDA_TZ } from './agent/time'

// ---------------------------------------------------------------------------
// Constantes y textos
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
/** Citas por corrida. */
const MAX_PER_RUN = 50
/** Ventana: desde hace 1 día... */
const WINDOW_PAST_MS = DAY_MS
/** ...hasta 180 días adelante. */
const WINDOW_FUTURE_MS = 180 * DAY_MS
/** Máximo de caracteres de `google_sync_error` y `last_error` (CHECK de la 056). */
const MAX_ERROR_LENGTH = 300
const MAX_NAME_LENGTH = 80

/** Sufijos de id, en el orden en que se prueban. '' es el id base. */
const EVENT_ID_SUFFIXES = ['', 'v1', 'v2', 'v3'] as const

/** Textos del evento, de los errores y del aviso al dueño, en un solo lugar. */
export const CALENDAR_SYNC_TEXTS = {
  createdFromShift: 'Creada desde Shift',
  staffLine: (name: string) => `Profesional: ${name}`,
  doneMark: '✓ ',
  noShowPrefix: 'No vino · ',
  titleSeparator: ' · ',
  fallbackService: 'Cita',
  fallbackClient: 'Cliente',
  fallbackPatient: 'Paciente',

  eventUnavailable: 'Google no aceptó crear el evento (el calendario no existe o no hay permiso).',
  googleHttp: (status: number, reason: string | null) =>
    `Google respondió un error (HTTP ${status}${reason ? `, ${reason}` : ''})`,
  googleAuth: (code: string) => `Google rechazó el acceso (${code})`,
  googleTimeout: 'Google no respondió a tiempo',
  googleUnreachable: 'No se pudo conectar con Google',
  unknownError: 'No se pudo copiar esta cita a Google',
  cannotReadToken:
    'No se pudo leer el permiso guardado de Google. Vuelve a conectar Google Calendar.',
  revokedError: 'Google revocó el permiso de Shift. Vuelve a conectar Google Calendar.',
  /** Para el resumen del cron (ruta y alerta): faltan las variables de Google en el servidor. */
  notConfigured: 'Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el servidor',

  revokedNoticeTitle: 'Google Calendar se desconectó',
  revokedNoticeBody:
    'Google revocó el permiso de Shift, así que las citas dejaron de copiarse a tu calendario. Vuelve a conectarlo en Agenda > Configuración.',
} as const

const T = CALENDAR_SYNC_TEXTS

// ---------------------------------------------------------------------------
// Texto del evento (puro)
// ---------------------------------------------------------------------------

/** Una sola línea y sin espacios de más. */
function oneLine(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

/** Secuencias que parecen un teléfono: 7 o más cifras con separadores. */
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/gu
const HAS_LETTER = /\p{L}/u

/**
 * Nombre apto para el evento: una línea, sin teléfonos y con al menos una
 * letra. Un contacto sin nombre suele traer su número: eso nunca sale.
 */
function safeName(value: string | null | undefined): string | null {
  const cleaned = oneLine(oneLine(value).replace(PHONE_LIKE, ' ')).slice(0, MAX_NAME_LENGTH)
  return HAS_LETTER.test(cleaned) ? cleaned : null
}

function safeLabel(value: string | null | undefined): string | null {
  const cleaned = oneLine(value).slice(0, MAX_NAME_LENGTH)
  return cleaned === '' ? null : cleaned
}

/** Estado del evento en Google para el estado de la cita. */
function googleStatusFor(status: string): GoogleEventStatus {
  if (status === 'pending') return 'tentative'
  if (status === 'cancelled') return 'cancelled'
  return 'confirmed'
}

/**
 * Título y descripción del evento. Sin teléfono, sin notas, sin respuestas
 * extra: solo la atención, el nombre y el profesional.
 */
export function buildEventText(args: {
  status: string
  serviceName: string | null
  personName: string | null
  staffName: string | null
  /** En clínica el nombre es el del paciente. */
  isClinic: boolean
}): { title: string; description: string } {
  const prefix =
    args.status === 'completed' ? T.doneMark : args.status === 'no_show' ? T.noShowPrefix : ''
  const service = safeLabel(args.serviceName) ?? T.fallbackService
  const person =
    safeName(args.personName) ?? (args.isClinic ? T.fallbackPatient : T.fallbackClient)
  const staff = safeLabel(args.staffName)
  return {
    title: `${prefix}${service}${T.titleSeparator}${person}`,
    description: [staff ? T.staffLine(staff) : null, T.createdFromShift]
      .filter((line): line is string => line !== null)
      .join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** No hay ningún id de evento que Google acepte en ese calendario. */
class CalendarSyncError extends Error {
  constructor() {
    super('No Google event id could be used in this calendar')
    this.name = 'CalendarSyncError'
  }
}

/**
 * Texto corto para guardar en la cita o en la conexión. Se arma desde códigos
 * y números: nunca copia el mensaje de un error desconocido, porque podría
 * traer un token, un nombre o un teléfono.
 */
function describeSyncError(err: unknown): string {
  let text: string = T.unknownError
  if (err instanceof CalendarSyncError) text = T.eventUnavailable
  else if (err instanceof GoogleApiError) text = T.googleHttp(err.httpStatus, err.reason)
  else if (err instanceof GoogleAuthError) text = T.googleAuth(err.code)
  else if (err instanceof GoogleNetworkError) {
    text = err.kind === 'timeout' ? T.googleTimeout : T.googleUnreachable
  }
  return text.slice(0, MAX_ERROR_LENGTH)
}

/** Para el log: solo mensajes de este módulo o de la base, sin datos de pacientes. */
function logText(err: unknown): string {
  return err instanceof Error ? err.message : 'error desconocido'
}

/**
 * El id del evento no sirve en Google: no existe y tampoco se puede crear
 * (404 tras el POST), o está reservado por un borrado (409/410).
 */
function isEventIdDeadEnd(err: unknown): boolean {
  return (
    err instanceof GoogleApiError &&
    (err.httpStatus === 404 || err.httpStatus === 409 || err.httpStatus === 410)
  )
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

interface ConnectionRow {
  account_id: string
  refresh_token_encrypted: string
  default_calendar_id: string | null
  status: string
}

interface AccountRow extends AccountModulesSource {
  owner_user_id?: string | null
}

interface AppointmentRow {
  id: string
  starts_at: string
  ends_at: string
  status: string
  staff_id: string | null
  service_id: string | null
  contact_id: string | null
  patient_id: string | null
  updated_at: string
  google_calendar_id: string | null
}

const APPOINTMENT_COLUMNS =
  'id, starts_at, ends_at, status, staff_id, service_id, contact_id, patient_id, updated_at, google_calendar_id'

async function readConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<ConnectionRow | null> {
  const { data, error } = await db
    .from('agenda_calendar_connections')
    .select('account_id, refresh_token_encrypted, default_calendar_id, status')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la conexión de Google: ${error.message}`)
  return (data as ConnectionRow | null) ?? null
}

async function readAccount(db: SupabaseClient, accountId: string): Promise<AccountRow> {
  const { data, error } = await db
    .from('accounts')
    .select('owner_user_id, modules, vertical_key')
    .eq('id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la cuenta: ${error.message}`)
  return (data as AccountRow | null) ?? {}
}

/**
 * Citas pendientes de copiar. Las que ya fallaron van al final: así unas
 * pocas citas con error permanente no dejan sin turno a las demás.
 */
async function readDirtyAppointments(
  db: SupabaseClient,
  accountId: string,
  now: Date,
): Promise<AppointmentRow[]> {
  const { data, error } = await db
    .from('booking_appointments')
    .select(APPOINTMENT_COLUMNS)
    .eq('account_id', accountId)
    .eq('google_dirty', true)
    .gte('starts_at', new Date(now.getTime() - WINDOW_PAST_MS).toISOString())
    .lte('starts_at', new Date(now.getTime() + WINDOW_FUTURE_MS).toISOString())
    .order('google_sync_error', { ascending: true, nullsFirst: true })
    .order('starts_at', { ascending: true })
    .limit(MAX_PER_RUN)
  if (error) throw new Error(`No se pudieron leer las citas: ${error.message}`)
  return (data ?? []) as AppointmentRow[]
}

type LookupRow = Record<string, unknown>

/** Filas por id de una tabla de la cuenta (nombres para los textos). */
async function loadById(
  db: SupabaseClient,
  args: { table: string; columns: string; accountId: string; ids: Array<string | null>; what: string },
): Promise<Map<string, LookupRow>> {
  const ids = [...new Set(args.ids.filter((id): id is string => Boolean(id)))]
  const out = new Map<string, LookupRow>()
  if (ids.length === 0) return out
  const { data, error } = await db
    .from(args.table)
    .select(args.columns)
    .eq('account_id', args.accountId)
    .in('id', ids)
  if (error) throw new Error(`No se pudo leer ${args.what}: ${error.message}`)
  for (const row of (data ?? []) as unknown as LookupRow[]) out.set(row.id as string, row)
  return out
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

// ---------------------------------------------------------------------------
// Escritura en Google
// ---------------------------------------------------------------------------

interface RunContext {
  db: SupabaseClient
  accountId: string
  now: Date
  fetchImpl?: typeof fetch
  accessToken: string
  defaultCalendarId: string
  isClinic: boolean
  services: Map<string, LookupRow>
  staff: Map<string, LookupRow>
  contacts: Map<string, LookupRow>
  patients: Map<string, LookupRow>
  /** Calendarios donde ningún id funcionó en esta corrida: no se vuelve a insistir. */
  deadCalendars: Set<string>
}

const candidateEventIds = (baseId: string): string[] =>
  EVENT_ID_SUFFIXES.map((suffix) => `${baseId}${suffix}`)

/**
 * Crea o actualiza el evento. Si el id base está quemado (404/409), prueba los
 * sufijos en orden. Si ninguno sirve, el calendario no existe o no hay permiso.
 */
async function upsertEvent(
  ctx: RunContext,
  args: { calendarId: string; baseId: string; body: GoogleEventBody },
): Promise<void> {
  if (ctx.deadCalendars.has(args.calendarId)) throw new CalendarSyncError()
  for (const eventId of candidateEventIds(args.baseId)) {
    try {
      await putEvent({
        accessToken: ctx.accessToken,
        calendarId: args.calendarId,
        eventId,
        body: args.body,
        fetchImpl: ctx.fetchImpl,
      })
      return
    } catch (err) {
      if (!isEventIdDeadEnd(err)) throw err
    }
  }
  ctx.deadCalendars.add(args.calendarId)
  throw new CalendarSyncError()
}

/**
 * Marca el evento como cancelado (no lo borra: así el id sigue sirviendo si la
 * cita vuelve). Solo actualiza, nunca crea. Si ningún id existe, el evento ya
 * no está en Google y no hay nada que cancelar.
 */
async function cancelEvent(
  ctx: RunContext,
  args: { calendarId: string; baseId: string; body: GoogleEventBody },
): Promise<void> {
  for (const eventId of candidateEventIds(args.baseId)) {
    try {
      await putEvent({
        accessToken: ctx.accessToken,
        calendarId: args.calendarId,
        eventId,
        body: args.body,
        createIfMissing: false,
        fetchImpl: ctx.fetchImpl,
      })
      return
    } catch (err) {
      if (!isEventIdDeadEnd(err)) throw err
    }
  }
}

/**
 * Quita la copia de un calendario anterior (la cita cambió de calendario).
 * Es el único lugar que usa DELETE. Para al borrar una; si ya no estaba,
 * prueba también los sufijos.
 */
async function removeCopy(
  ctx: RunContext,
  args: { calendarId: string; baseId: string },
): Promise<void> {
  for (const eventId of candidateEventIds(args.baseId)) {
    const removed = await deleteEvent({
      accessToken: ctx.accessToken,
      calendarId: args.calendarId,
      eventId,
      fetchImpl: ctx.fetchImpl,
    })
    if (removed) return
  }
}

// ---------------------------------------------------------------------------
// Una cita
// ---------------------------------------------------------------------------

/**
 * Deja la cita limpia si no cambió desde que se leyó. Devuelve `false` si
 * cambió: queda pendiente para la próxima corrida.
 */
async function markClean(
  ctx: RunContext,
  appt: AppointmentRow,
  calendarId: string | null,
): Promise<boolean> {
  const { data, error } = await ctx.db
    .from('booking_appointments')
    .update({
      google_dirty: false,
      google_synced_at: ctx.now.toISOString(),
      google_calendar_id: calendarId,
      google_sync_error: null,
    })
    .eq('id', appt.id)
    .eq('account_id', ctx.accountId)
    .eq('updated_at', appt.updated_at)
    .select('id')
  if (error) throw new Error(`No se pudo marcar la cita como copiada: ${error.message}`)
  if ((data ?? []).length > 0) return true

  // La cita cambió mientras se copiaba: sigue pendiente. Se recuerda dónde
  // quedó el evento, por si ahora se cancela y hay que encontrarlo.
  if (calendarId && calendarId !== appt.google_calendar_id) {
    const { error: calendarError } = await ctx.db
      .from('booking_appointments')
      .update({ google_calendar_id: calendarId })
      .eq('id', appt.id)
      .eq('account_id', ctx.accountId)
    if (calendarError) {
      throw new Error(`No se pudo guardar el calendario de la cita: ${calendarError.message}`)
    }
  }
  return false
}

/** `true` si quedó limpia; `false` si cambió en medio y queda pendiente. */
async function syncOne(ctx: RunContext, appt: AppointmentRow): Promise<boolean> {
  const baseId = eventIdForAppointment(appt.id)
  const staff = appt.staff_id ? ctx.staff.get(appt.staff_id) : undefined
  const previousCalendar = appt.google_calendar_id
  const targetCalendar = stringOrNull(staff?.google_calendar_id) ?? ctx.defaultCalendarId

  const patientName =
    ctx.isClinic && appt.patient_id
      ? stringOrNull(ctx.patients.get(appt.patient_id)?.full_name)
      : null
  const contactName = appt.contact_id ? stringOrNull(ctx.contacts.get(appt.contact_id)?.name) : null
  const { title, description } = buildEventText({
    status: appt.status,
    serviceName: appt.service_id ? stringOrNull(ctx.services.get(appt.service_id)?.name) : null,
    personName: patientName ?? contactName,
    staffName: stringOrNull(staff?.name),
    isClinic: ctx.isClinic,
  })
  const body = buildEventBody({
    title,
    description,
    startIso: appt.starts_at,
    endIso: appt.ends_at,
    status: googleStatusFor(appt.status),
    timeZone: AGENDA_TZ,
  })

  if (appt.status === 'cancelled') {
    // El evento vive donde se guardó por última vez. Si nunca se copió, no hay
    // nada que cancelar.
    if (previousCalendar) await cancelEvent(ctx, { calendarId: previousCalendar, baseId, body })
    return markClean(ctx, appt, previousCalendar)
  }

  await upsertEvent(ctx, { calendarId: targetCalendar, baseId, body })
  // Primero se escribe en el nuevo y recién después se borra el anterior: la
  // cita nunca se queda sin evento si el borrado falla (se reintenta).
  if (previousCalendar && previousCalendar !== targetCalendar) {
    await removeCopy(ctx, { calendarId: previousCalendar, baseId })
  }
  return markClean(ctx, appt, targetCalendar)
}

/** Anota el error en la cita. Si tampoco se puede anotar, se ignora: se reintenta igual. */
async function recordAppointmentError(
  ctx: RunContext,
  appointmentId: string,
  message: string,
): Promise<void> {
  await ctx.db
    .from('booking_appointments')
    .update({ google_sync_error: message.slice(0, MAX_ERROR_LENGTH) })
    .eq('id', appointmentId)
    .eq('account_id', ctx.accountId)
}

// ---------------------------------------------------------------------------
// Una cuenta
// ---------------------------------------------------------------------------

export type CalendarSyncOutcome =
  | 'ok'
  | 'no_connection'
  | 'inactive'
  | 'not_configured'
  | 'revoked'
  | 'error'

export interface CalendarSyncSummary {
  outcome: CalendarSyncOutcome
  /** Citas pendientes que se tomaron (máximo 50). */
  found: number
  synced: number
  failed: number
  /** Cambiaron mientras se copiaban: siguen pendientes. */
  raced: number
}

const emptySummary = (outcome: CalendarSyncOutcome, found = 0): CalendarSyncSummary => ({
  outcome,
  found,
  synced: 0,
  failed: 0,
  raced: 0,
})

/** Anota un problema de la conexión (el panel lo muestra). Si falla, se ignora. */
async function recordConnectionError(
  db: SupabaseClient,
  accountId: string,
  message: string,
): Promise<void> {
  await db
    .from('agenda_calendar_connections')
    .update({ last_error: message.slice(0, MAX_ERROR_LENGTH) })
    .eq('account_id', accountId)
    .eq('status', 'active')
}

/**
 * Google revocó el permiso: la conexión pasa a `revoked` y se avisa al dueño
 * una sola vez. El `UPDATE ... WHERE status = 'active'` decide quién avisa, y
 * así dos corridas a la vez no mandan dos avisos.
 */
async function revokeConnection(db: SupabaseClient, accountId: string): Promise<void> {
  const { data, error } = await db
    .from('agenda_calendar_connections')
    .update({ status: 'revoked', last_error: T.revokedError })
    .eq('account_id', accountId)
    .eq('status', 'active')
    .select('account_id')
  if (error) throw new Error(`No se pudo revocar la conexión de Google: ${error.message}`)
  if ((data ?? []).length === 0) return

  try {
    const owner = (await readAccount(db, accountId)).owner_user_id
    if (!owner) return
    await insertNotification(db, {
      accountId,
      userId: owner,
      conversationId: null,
      contactId: null,
      title: T.revokedNoticeTitle,
      body: T.revokedNoticeBody,
    })
  } catch (err) {
    // La conexión ya quedó revocada y el panel lo muestra; el aviso es un extra.
    console.error('[agenda calendar-sync] no se pudo avisar al dueño:', logText(err))
  }
}

/**
 * Copia a Google las citas pendientes de una cuenta. Sin conexión activa no
 * hace nada. Lanza solo si la base falla; los problemas de Google se anotan.
 */
export async function syncAccountCalendar(args: {
  db: SupabaseClient
  accountId: string
  now: Date
  fetchImpl?: typeof fetch
}): Promise<CalendarSyncSummary> {
  const { db, accountId, now, fetchImpl } = args

  const connection = await readConnection(db, accountId)
  if (!connection) return emptySummary('no_connection')
  // 'revoked' y 'error' se dejan quietas hasta que el dueño reconecte.
  if (connection.status !== 'active') return emptySummary('inactive')

  const dirty = await readDirtyAppointments(db, accountId, now)
  if (dirty.length === 0) return emptySummary('ok')

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return emptySummary('not_configured', dirty.length)

  let refreshToken: string
  try {
    refreshToken = decrypt(connection.refresh_token_encrypted)
  } catch {
    await recordConnectionError(db, accountId, T.cannotReadToken)
    return emptySummary('error', dirty.length)
  }

  let accessToken: string
  try {
    accessToken = (await refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl }))
      .accessToken
  } catch (err) {
    if (err instanceof GoogleAuthError && err.code === 'invalid_grant') {
      await revokeConnection(db, accountId)
      return emptySummary('revoked', dirty.length)
    }
    await recordConnectionError(db, accountId, describeSyncError(err))
    return emptySummary('error', dirty.length)
  }

  const account = await readAccount(db, accountId)
  const isClinic = hasModule(account, 'clinica')
  const [services, staff, contacts, patients] = await Promise.all([
    loadById(db, {
      table: 'booking_services',
      columns: 'id, name',
      accountId,
      ids: dirty.map((a) => a.service_id),
      what: 'los servicios',
    }),
    loadById(db, {
      table: 'booking_staff',
      columns: 'id, name, google_calendar_id',
      accountId,
      ids: dirty.map((a) => a.staff_id),
      what: 'los profesionales',
    }),
    loadById(db, {
      table: 'contacts',
      columns: 'id, name',
      accountId,
      ids: dirty.map((a) => a.contact_id),
      what: 'los contactos',
    }),
    isClinic
      ? loadById(db, {
          table: 'clinic_patients',
          columns: 'id, full_name',
          accountId,
          ids: dirty.map((a) => a.patient_id),
          what: 'los pacientes',
        })
      : Promise.resolve(new Map<string, LookupRow>()),
  ])

  const ctx: RunContext = {
    db,
    accountId,
    now,
    fetchImpl,
    accessToken,
    defaultCalendarId: connection.default_calendar_id || 'primary',
    isClinic,
    services,
    staff,
    contacts,
    patients,
    deadCalendars: new Set(),
  }

  const summary = emptySummary('ok', dirty.length)
  let firstError: string | null = null

  // Una tras otra: así el orden es estable y no se rebasa el límite de Google.
  for (const appt of dirty) {
    try {
      if (await syncOne(ctx, appt)) summary.synced += 1
      else summary.raced += 1
    } catch (err) {
      summary.failed += 1
      const message = describeSyncError(err)
      firstError ??= message
      await recordAppointmentError(ctx, appt.id, message)
    }
  }

  // Estado de la conexión para el panel (un fallo aquí no cambia el resultado).
  const patch: Record<string, unknown> = {}
  if (summary.synced > 0) patch.last_sync_at = now.toISOString()
  if (firstError) patch.last_error = firstError
  else if (summary.synced > 0 || summary.raced > 0) patch.last_error = null
  if (Object.keys(patch).length > 0) {
    await db
      .from('agenda_calendar_connections')
      .update(patch)
      .eq('account_id', accountId)
      .eq('status', 'active')
  }

  return summary
}

// ---------------------------------------------------------------------------
// Todas las cuentas
// ---------------------------------------------------------------------------

export interface CalendarRunSummary {
  /** Conexiones activas recorridas. */
  accounts: number
  synced: number
  failed: number
  raced: number
  /** Conexiones que Google revocó en esta corrida. */
  revoked: number
  /** Conexiones con problema de token o de configuración (se reintenta solo). */
  connectionErrors: number
  /** Cuentas que lanzaron (falló la base). Sin datos personales. */
  errors: string[]
}

/** Recorre todas las conexiones `active`, una tras otra. */
export async function runCalendarSync(args: {
  db: SupabaseClient
  now: Date
  fetchImpl?: typeof fetch
}): Promise<CalendarRunSummary> {
  const { data, error } = await args.db
    .from('agenda_calendar_connections')
    .select('account_id')
    .eq('status', 'active')
    .order('account_id', { ascending: true })
  if (error) throw new Error(`No se pudieron leer las conexiones de Google: ${error.message}`)

  const rows = (data ?? []) as Array<{ account_id: string }>
  const summary: CalendarRunSummary = {
    accounts: rows.length,
    synced: 0,
    failed: 0,
    raced: 0,
    revoked: 0,
    connectionErrors: 0,
    errors: [],
  }

  for (const { account_id: accountId } of rows) {
    try {
      const result = await syncAccountCalendar({
        db: args.db,
        accountId,
        now: args.now,
        fetchImpl: args.fetchImpl,
      })
      summary.synced += result.synced
      summary.failed += result.failed
      summary.raced += result.raced
      if (result.outcome === 'revoked') summary.revoked += 1
      if (result.outcome === 'error' || result.outcome === 'not_configured') {
        summary.connectionErrors += 1
      }
      if (result.outcome === 'not_configured') {
        if (!summary.errors.includes(T.notConfigured)) summary.errors.push(T.notConfigured)
      }
    } catch (err) {
      const text = `cuenta ${accountId}: ${logText(err)}`
      console.error('[agenda calendar-sync] la cuenta falló:', text)
      summary.errors.push(text)
    }
  }

  return summary
}

// ---------------------------------------------------------------------------
// Empujón inmediato
// ---------------------------------------------------------------------------

/**
 * Copia ya las citas pendientes de una cuenta (se llama con `after()` después
 * de crear, mover o cancelar una cita desde el panel). Nunca lanza: si falla,
 * el cron de cada 5 minutos lo reintenta. El log no lleva datos personales.
 */
export async function kickCalendarSyncNow(accountId: string): Promise<void> {
  try {
    await syncAccountCalendar({ db: supabaseAdmin(), accountId, now: new Date() })
  } catch (err) {
    console.error('[agenda calendar-sync] el empujón falló:', logText(err))
  }
}
