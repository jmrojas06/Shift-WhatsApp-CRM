// ============================================================
// Después de la cita (Fase 3, §7 del diseño de las Fases 2 y 3). Solo clínicas.
//
// Tres seguimientos por cita atendida, cada uno una fila de `clinic_followups`:
//   - `cuidados`: las instrucciones del servicio, al terminar la cita (solo si
//     el servicio las tiene);
//   - `como_sigues`: "¿Cómo sigues?" con Bien / Tengo molestias / Necesito ayuda,
//     al día siguiente a las 10:00 (hora de Bogotá);
//   - `calificacion`: Bien / Regular / Mal, a los dos días a las 10:00. Va aparte
//     de `como_sigues` para no mandar dos mensajes el mismo día.
//
// INTERRUPTOR POR CUENTA: nada de lo anterior corre en una cuenta hasta que
// `clinic_settings.followups_enabled` sea true (nace en false; sin fila de
// configuración también cuenta como apagado). Así desplegar el código no le escribe
// a los pacientes antes de que Meta apruebe las tres plantillas. Con la cuenta
// apagada no se siembra (si no, al prenderla saldría de golpe lo de días atrás) ni
// se envía lo que ya estuviera pendiente. El CIERRE DEL DÍA (3) no depende del
// interruptor: solo avisa al dueño dentro de la app y no escribe a nadie más.
//
// El runner hace tres cosas en cada corrida (cada 10 min desde el cron):
//   1. SIEMBRA: las citas `completed` con inicio en los últimos 3 días que aún
//      no tienen filas. Con upsert + ignoreDuplicates: correrlo dos veces, o dos
//      corridas a la vez, no duplica.
//   2. ENVÍA los vencidos. Cada uno se reclama con un UPDATE condicional
//      (`pending` → `sent`) ANTES de enviar, como los recordatorios; si el envío
//      falla vuelve a `pending` con un intento más, y al tercero queda `failed`.
//      Antes de reclamar se omiten (`skipped`, con el motivo) los que no deben salir.
//   3. CIERRE DEL DÍA: desde las 20:00 (Bogotá), si quedaron citas de hoy ya
//      empezadas sin marcar, avisa una vez al dueño en la app. `clinic_day_closes`
//      lleva la cuenta: su llave primaria deja que solo una corrida avise.
//
// El teléfono puede ser compartido y el texto pasa por Meta: los mensajes nombran
// al paciente y al negocio, nunca el procedimiento. Los cuidados (que sí vienen del
// servicio) solo salen con la ventana de 24 h abierta; con la ventana cerrada, la
// plantilla solo invita a verlos y el bot los manda al tocar el botón.
//
// Un paciente es un dato personal: ni su nombre ni su teléfono van a los logs ni a
// los errores de este archivo (solo el id del seguimiento y el mensaje de la base).
//
// Las reglas puras (`followupSchedule`, `commonSkipReason`, `ratingSkipReason`) y los
// builders no tocan red ni base. El runner recibe el envío inyectado
// (`followups-send.ts` es el real) y los tests corren con un fake.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUndefinedColumnError } from '@/lib/modules/undefined-column'
import { hasModule, type AccountModulesSource } from '@/lib/verticals/registry'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { findContactConversationId, insertNotification } from '@/verticals/agenda/agent/db'
import { hasRecentCustomerMessage } from '@/verticals/agenda/agent/reminders'
import {
  addDaysToKey,
  startOfZonedDay,
  zonedDateKey,
  zonedParts,
  zonedTimeToUtc,
} from '@/verticals/agenda/agent/time'
import { DEFAULT_LABELS, readLabels, type AgendaLabels } from '@/verticals/agenda/labels'

import { loadClinicReminderInfo } from './reminder-info'
import { clinicReminderBlock, type ReminderBlock } from './reminder-skip'
import { buildClinicTexts } from './texts'

// ------------------------------------------------------------
// Constantes
// ------------------------------------------------------------

export const FOLLOWUP_KINDS = ['cuidados', 'como_sigues', 'calificacion'] as const
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number]

/** Al tercer envío fallido el seguimiento queda `failed` y ya no se reintenta. */
export const FOLLOWUP_MAX_ATTEMPTS = 3

/** Etiqueta que ponen y quitan las personas del equipo: quien tiene una queja abierta no recibe la calificación. */
export const OPEN_COMPLAINT_TAG = 'queja-abierta'

/** Quien calificó hace menos de esto no recibe otra calificación. */
export const RATING_COOLDOWN_DAYS = 90

/** Se siembran las citas atendidas que empezaron en los últimos días de esta ventana. */
export const SEED_WINDOW_DAYS = 3

/** Hora local (Bogotá) del "¿Cómo sigues?" y de la calificación. */
export const FOLLOWUP_LOCAL_TIME = '10:00'

/** Hora local (Bogotá) desde la que se avisa al dueño de lo que quedó sin marcar. */
export const DAY_CLOSE_HOUR = 20

/** Por corrida, para acotar el tiempo de ejecución del cron. */
const DEFAULT_LIMIT = 50

/** Citas atendidas que se miran por cuenta y por corrida al sembrar. */
const SEED_LIMIT = 300

/** Ids por consulta `in(...)`: la URL de PostgREST tiene un largo máximo. */
const IN_CHUNK = 100

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Plantillas aprobadas en Meta para cuando la ventana de 24 h está cerrada.
 * El nombre y el idioma deben coincidir EXACTAMENTE con los de WhatsApp Manager
 * (docs/clinica-montaje.md). Cada una lleva dos variables: {{1}} negocio y
 * {{2}} paciente (en el cuerpo el negocio se nombra antes que el paciente, y Meta
 * pide las variables en orden numérico); el procedimiento nunca viaja.
 */
export const FOLLOWUP_TEMPLATES = {
  cuidados: { name: 'cuidados_cita_clinica', language: 'es' },
  como_sigues: { name: 'como_sigues_clinica', language: 'es' },
  calificacion: { name: 'calificacion_visita_clinica', language: 'es' },
} as const

// ------------------------------------------------------------
// Ids de los botones (los lee el bot: T17 `parseFollowupTap`)
//
//   fu:<acción>:<seguimiento>   cuidados | bien | molestias | ayuda
//   rt:<valor>:<seguimiento>    bien | regular | mal
//
// El id del seguimiento amarra el toque a una visita: el bot verifica que sea de la
// cuenta y del contacto. Una plantilla manda estos mismos ids como payload de sus
// botones (`quickReplyPayloads`), en el orden de los botones aprobados.
// ------------------------------------------------------------

export const FOLLOWUP_ACTIONS = ['cuidados', 'bien', 'molestias', 'ayuda'] as const
export type FollowupAction = (typeof FOLLOWUP_ACTIONS)[number]

export const RATING_VALUES = ['bien', 'regular', 'mal'] as const
export type RatingValue = (typeof RATING_VALUES)[number]

/** Lo que el paciente respondió en "¿Cómo sigues?" (`clinic_followups.response`). */
export type FollowupResponse = 'bien' | 'molestias' | 'ayuda'

export const followupPayload = (action: FollowupAction, followupId: string): string =>
  `fu:${action}:${followupId}`

export const ratingPayload = (value: RatingValue, followupId: string): string =>
  `rt:${value}:${followupId}`

const TEXTS = buildClinicTexts(DEFAULT_LABELS)

/** Los botones del mensaje libre, en el mismo orden que los de la plantilla aprobada. */
export function followupButtons(
  kind: FollowupKind,
  followupId: string,
): { id: string; title: string }[] {
  switch (kind) {
    case 'cuidados':
      return [{ id: followupPayload('cuidados', followupId), title: TEXTS.followupCareButton }]
    case 'como_sigues':
      return [
        { id: followupPayload('bien', followupId), title: TEXTS.followupHowGood },
        { id: followupPayload('molestias', followupId), title: TEXTS.followupHowTrouble },
        { id: followupPayload('ayuda', followupId), title: TEXTS.followupHowHelp },
      ]
    case 'calificacion':
      return [
        { id: ratingPayload('bien', followupId), title: TEXTS.followupRatingGood },
        { id: ratingPayload('regular', followupId), title: TEXTS.followupRatingRegular },
        { id: ratingPayload('mal', followupId), title: TEXTS.followupRatingBad },
      ]
  }
}

/** Un payload por botón de la plantilla, en su orden. */
export function followupQuickReplyPayloads(kind: FollowupKind, followupId: string): string[] {
  return followupButtons(kind, followupId).map((button) => button.id)
}

// ------------------------------------------------------------
// Reglas puras
// ------------------------------------------------------------

export interface FollowupScheduleItem {
  kind: FollowupKind
  /** ISO UTC. */
  dueAt: string
}

/**
 * Cuándo vence cada seguimiento de una cita atendida.
 *   - cuidados: al terminar la cita ("para ya": si se marca atendida después, vence
 *     de inmediato), solo si el servicio tiene instrucciones;
 *   - como_sigues: 10:00 del día siguiente, hora de Bogotá;
 *   - calificacion: 10:00 de dos días después.
 * El día es el de Bogotá, no el de UTC: una cita a las 23:30 locales es de ese día.
 */
export function followupSchedule(
  appt: { startsAt: string; endsAt?: string | null },
  serviceHasAftercare: boolean,
): FollowupScheduleItem[] {
  const startsAt = new Date(appt.startsAt)
  const dayKey = zonedDateKey(startsAt)
  const at = (days: number) =>
    zonedTimeToUtc(addDaysToKey(dayKey, days), FOLLOWUP_LOCAL_TIME).toISOString()

  return [
    ...(serviceHasAftercare
      ? [{ kind: 'cuidados' as const, dueAt: new Date(appt.endsAt ?? appt.startsAt).toISOString() }]
      : []),
    { kind: 'como_sigues', dueAt: at(1) },
    { kind: 'calificacion', dueAt: at(2) },
  ]
}

export type CommonSkipReason =
  | 'appointment_not_completed'
  | 'no_contact'
  | 'no_phone'
  | 'opt_out'
  | 'consent_revoked'

/**
 * Por qué NO se manda un seguimiento, sea cual sea: la cita ya no está atendida (se
 * corrigió a "No vino", por ejemplo), el contacto se borró o no tiene cómo recibir
 * WhatsApp, pidió la baja de envíos o revocó la autorización de datos.
 */
export function commonSkipReason(input: {
  appointmentStatus: string | null
  hasContact: boolean
  hasPhone: boolean
  block: ReminderBlock | null
}): CommonSkipReason | null {
  if (input.appointmentStatus !== 'completed') return 'appointment_not_completed'
  if (!input.hasContact) return 'no_contact'
  if (!input.hasPhone) return 'no_phone'
  if (input.block === 'opt_out') return 'opt_out'
  if (input.block === 'consent_revoked') return 'consent_revoked'
  return null
}

export type RatingSkipReason =
  | 'open_complaint'
  | 'trouble_reported'
  | 'future_appointment'
  | 'recent_rating'

/**
 * Por qué NO se pide la calificación: tiene una queja abierta, reportó molestias o
 * pidió ayuda en "¿Cómo sigues?", ya tiene otra cita por venir (calificará esa
 * visita) o calificó hace poco.
 */
export function ratingSkipReason(input: {
  hasFutureAppointment: boolean
  ratedRecently: boolean
  openComplaint: boolean
  howAreYouResponse: FollowupResponse | null
}): RatingSkipReason | null {
  if (input.openComplaint) return 'open_complaint'
  if (input.howAreYouResponse === 'molestias' || input.howAreYouResponse === 'ayuda') {
    return 'trouble_reported'
  }
  if (input.hasFutureAppointment) return 'future_appointment'
  if (input.ratedRecently) return 'recent_rating'
  return null
}

// ------------------------------------------------------------
// Mensaje y plantilla (builders puros)
// ------------------------------------------------------------

export interface FollowupDelivery {
  followupId: string
  appointmentId: string
  kind: FollowupKind
  accountId: string
  contactId: string
  conversationId: string
  /** Dueño de la cuenta: columnas de auditoría de los senders. */
  ownerUserId: string
  channel: 'text' | 'template'
  businessName: string
  patientName: string
  /**
   * Las instrucciones del servicio. Solo en los cuidados con la ventana abierta:
   * por una plantilla nunca viajan.
   */
  aftercare: string | null
  /** Palabras del negocio (cita, turno…) para el cuerpo del mensaje libre. */
  labels: AgendaLabels
}

export type FollowupSender = (delivery: FollowupDelivery) => Promise<void>

/**
 * Una sola línea y sin espacios de más: Meta rechaza una variable de la plantilla con
 * saltos de línea o tabulaciones.
 */
const oneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim()

/** El cuerpo del mensaje; con la plantilla, el mismo texto de la plantilla aprobada. */
export function buildFollowupBody(d: FollowupDelivery): string {
  const texts = buildClinicTexts(d.labels)
  const names = { patient: oneLine(d.patientName), business: oneLine(d.businessName) }
  switch (d.kind) {
    case 'cuidados': {
      const instructions = d.channel === 'text' ? d.aftercare?.trim() : ''
      return instructions
        ? texts.followupCareBody({ ...names, instructions })
        : texts.followupCareTemplateBody(names)
    }
    case 'como_sigues':
      return texts.followupHowBody(names)
    case 'calificacion':
      return texts.followupRatingBody(names)
  }
}

/** Variables del cuerpo de la plantilla: {{1}} negocio · {{2}} paciente. */
export function buildFollowupTemplateParams(d: FollowupDelivery): string[] {
  return [oneLine(d.businessName), oneLine(d.patientName)]
}

// ------------------------------------------------------------
// Lecturas del runner
// ------------------------------------------------------------

interface ClinicAccountRow extends AccountModulesSource {
  id: string
  name: string
  owner_user_id: string | null
}

/**
 * Cuentas con el módulo clínica. La base trae un superconjunto (`modules` contiene
 * 'clinica', o `vertical_key` es 'clinica') y la regla exacta la pone `hasModule`,
 * la misma de `getAccountModules`. Si la columna `modules` no existe todavía
 * (migración 053 sin aplicar) repite con `vertical_key`.
 */
async function readClinicAccounts(db: SupabaseClient) {
  const result = await db
    .from('accounts')
    .select('id, name, owner_user_id, modules, vertical_key')
    .or('modules.cs.{clinica},vertical_key.eq.clinica')
  const fallback = isUndefinedColumnError(result.error)
    ? await db
        .from('accounts')
        .select('id, name, owner_user_id, vertical_key')
        .eq('vertical_key', 'clinica')
    : result
  if (fallback.error) return { data: null, error: fallback.error }
  const rows = (fallback.data ?? []) as ClinicAccountRow[]
  return { data: rows.filter((row) => hasModule(row, 'clinica')), error: null }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ------------------------------------------------------------
// Siembra
// ------------------------------------------------------------

interface CompletedAppointmentRow {
  id: string
  contact_id: string | null
  service_id: string | null
  starts_at: string
  ends_at: string | null
}

/**
 * Crea los seguimientos de las citas atendidas que aún no tienen ninguno. Devuelve
 * cuántas filas nuevas quedaron. Lanza si una lectura o la escritura falla.
 */
async function seedAccount(db: SupabaseClient, accountId: string, now: Date): Promise<number> {
  const nowIso = now.toISOString()
  const sinceIso = new Date(now.getTime() - SEED_WINDOW_DAYS * DAY_MS).toISOString()

  const { data, error } = await db
    .from('booking_appointments')
    .select('id, contact_id, service_id, starts_at, ends_at')
    .eq('account_id', accountId)
    .eq('status', 'completed')
    .gte('starts_at', sinceIso)
    .lte('starts_at', nowIso)
    .order('starts_at', { ascending: false })
    .limit(SEED_LIMIT)
  if (error) throw new Error(`no se pudieron leer las citas atendidas: ${error.message}`)
  const appointments = (data ?? []) as CompletedAppointmentRow[]
  if (!appointments.length) return 0

  // Con alguna fila (de cualquier tipo) la cita ya está sembrada: no se toca.
  const seeded = new Set<string>()
  for (const ids of chunk(
    appointments.map((a) => a.id),
    IN_CHUNK,
  )) {
    const { data: existing, error: existingError } = await db
      .from('clinic_followups')
      .select('appointment_id')
      .eq('account_id', accountId)
      .in('appointment_id', ids)
    if (existingError) {
      throw new Error(`no se pudieron leer los seguimientos: ${existingError.message}`)
    }
    for (const row of (existing ?? []) as { appointment_id: string }[]) {
      seeded.add(row.appointment_id)
    }
  }
  const missing = appointments.filter((a) => !seeded.has(a.id))
  if (!missing.length) return 0

  const serviceIds = [...new Set(missing.flatMap((a) => (a.service_id ? [a.service_id] : [])))]
  const withAftercare = new Set<string>()
  for (const ids of chunk(serviceIds, IN_CHUNK)) {
    const { data: services, error: servicesError } = await db
      .from('booking_services')
      .select('id, aftercare_instructions')
      .eq('account_id', accountId)
      .in('id', ids)
    if (servicesError) throw new Error(`no se pudieron leer los servicios: ${servicesError.message}`)
    for (const service of (services ?? []) as {
      id: string
      aftercare_instructions: string | null
    }[]) {
      if (service.aftercare_instructions?.trim()) withAftercare.add(service.id)
    }
  }

  const rows = missing.flatMap((appointment) =>
    followupSchedule(
      { startsAt: appointment.starts_at, endsAt: appointment.ends_at },
      appointment.service_id !== null && withAftercare.has(appointment.service_id),
    ).map((item) => ({
      id: crypto.randomUUID(),
      account_id: accountId,
      appointment_id: appointment.id,
      contact_id: appointment.contact_id,
      kind: item.kind,
      due_at: item.dueAt,
      status: 'pending',
      attempts: 0,
    })),
  )

  // ON CONFLICT DO NOTHING sobre (appointment_id, kind): si otra corrida sembró
  // entre la lectura y la escritura, esa gana y aquí solo vuelven las filas nuevas.
  const { data: inserted, error: upsertError } = await db
    .from('clinic_followups')
    .upsert(rows, { onConflict: 'appointment_id,kind', ignoreDuplicates: true })
    .select('id')
  if (upsertError) throw new Error(`no se pudieron crear los seguimientos: ${upsertError.message}`)
  return ((inserted ?? []) as unknown[]).length
}

// ------------------------------------------------------------
// Lecturas de las reglas de omisión
// ------------------------------------------------------------

interface AppointmentRow {
  status: string
  conversation_id: string | null
  service_id: string | null
}

async function loadAppointmentRow(
  db: SupabaseClient,
  followup: DueFollowupRow,
): Promise<AppointmentRow | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('status, conversation_id, service_id')
    .eq('id', followup.appointment_id)
    .eq('account_id', followup.account_id)
    .maybeSingle()
  if (error) throw new Error(`no se pudo leer la cita: ${error.message}`)
  return (data as AppointmentRow | null) ?? null
}

async function loadContactRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ phone: string | null; wa_user_id: string | null } | null> {
  const { data, error } = await db
    .from('contacts')
    .select('phone, wa_user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`no se pudo leer el contacto: ${error.message}`)
  return (data as { phone: string | null; wa_user_id: string | null } | null) ?? null
}

async function hasFutureActiveAppointment(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; nowIso: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .in('status', ['pending', 'confirmed'])
    .gt('starts_at', args.nowIso)
    .limit(1)
  if (error) throw new Error(`no se pudieron leer las citas por venir: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

async function hasRecentRating(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; sinceIso: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('clinic_ratings')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .gte('created_at', args.sinceIso)
    .limit(1)
  if (error) throw new Error(`no se pudieron leer las calificaciones: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

async function hasContactTag(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; tagName: string },
): Promise<boolean> {
  const { data: tag, error: tagError } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', args.tagName)
    .maybeSingle()
  if (tagError) throw new Error(`no se pudo leer la etiqueta: ${tagError.message}`)
  const tagId = (tag as { id?: string } | null)?.id
  if (!tagId) return false
  const { data, error } = await db
    .from('contact_tags')
    .select('contact_id')
    .eq('contact_id', args.contactId)
    .eq('tag_id', tagId)
    .limit(1)
  if (error) throw new Error(`no se pudo leer la etiqueta del contacto: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

async function loadHowAreYouResponse(
  db: SupabaseClient,
  args: { accountId: string; appointmentId: string },
): Promise<FollowupResponse | null> {
  const { data, error } = await db
    .from('clinic_followups')
    .select('response')
    .eq('account_id', args.accountId)
    .eq('appointment_id', args.appointmentId)
    .eq('kind', 'como_sigues')
    .maybeSingle()
  if (error) throw new Error(`no se pudo leer la respuesta de "¿cómo sigues?": ${error.message}`)
  const response = (data as { response?: string | null } | null)?.response
  return response === 'bien' || response === 'molestias' || response === 'ayuda' ? response : null
}

async function loadAftercare(
  db: SupabaseClient,
  accountId: string,
  serviceId: string | null,
): Promise<string | null> {
  if (!serviceId) return null
  const { data, error } = await db
    .from('booking_services')
    .select('aftercare_instructions')
    .eq('id', serviceId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`no se pudieron leer los cuidados del servicio: ${error.message}`)
  const text = (data as { aftercare_instructions?: string | null } | null)?.aftercare_instructions
  return text?.trim() ? text : null
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

export interface FollowupRunSummary {
  /** Cuentas con el módulo clínica. */
  accounts: number
  /** De ellas, las que tienen prendido el interruptor de los seguimientos. */
  followupAccounts: number
  /** Seguimientos nuevos creados en esta corrida. */
  seeded: number
  /** Seguimientos vencidos que se revisaron en esta corrida. */
  due: number
  sent: number
  failed: number
  skipped: number
  byChannel: { text: number; template: number }
  byKind: Record<FollowupKind, number>
  /** Cuentas a las que se les avisó el cierre del día. */
  dayCloses: number
  errors: string[]
}

export interface RunClinicFollowupsArgs {
  db: SupabaseClient
  send: FollowupSender
  now?: Date
  limit?: number
}

interface DueFollowupRow {
  id: string
  account_id: string
  appointment_id: string
  contact_id: string | null
  kind: FollowupKind
  attempts: number
}

interface RunContext {
  db: SupabaseClient
  send: FollowupSender
  now: Date
  nowIso: string
  accounts: Map<string, ClinicAccountRow>
  labels: Map<string, AgendaLabels>
}

type Prepared = { skip: string } | { delivery: FollowupDelivery }

/**
 * Decide si el seguimiento sale y arma lo que se envía. No escribe nada: lo que
 * falle LANZA y quien llama lo deja pendiente para la próxima corrida.
 */
async function prepareFollowup(ctx: RunContext, followup: DueFollowupRow): Promise<Prepared> {
  const { db } = ctx
  const account = ctx.accounts.get(followup.account_id)
  if (!account) return { skip: 'no_account' }

  const appointment = await loadAppointmentRow(db, followup)
  const contactId = followup.contact_id
  const contact = contactId ? await loadContactRow(db, followup.account_id, contactId) : null
  const hasPhone = resolveContactSendTarget(contact) !== null

  // Las lecturas de la baja y de la autorización solo se hacen si lo de arriba pasó.
  const block =
    appointment?.status === 'completed' && contactId && contact && hasPhone
      ? await clinicReminderBlock(db, { accountId: followup.account_id, contactId })
      : null
  const common = commonSkipReason({
    appointmentStatus: appointment?.status ?? null,
    hasContact: contactId !== null && contact !== null,
    hasPhone,
    block,
  })
  if (common) return { skip: common }
  // commonSkipReason ya descartó cita y contacto ausentes.
  if (!appointment || !contactId) return { skip: 'appointment_not_completed' }

  if (followup.kind === 'calificacion') {
    const sinceIso = new Date(ctx.now.getTime() - RATING_COOLDOWN_DAYS * DAY_MS).toISOString()
    const reason = ratingSkipReason({
      hasFutureAppointment: await hasFutureActiveAppointment(db, {
        accountId: followup.account_id,
        contactId,
        nowIso: ctx.nowIso,
      }),
      ratedRecently: await hasRecentRating(db, { accountId: followup.account_id, contactId, sinceIso }),
      openComplaint: await hasContactTag(db, {
        accountId: followup.account_id,
        contactId,
        tagName: OPEN_COMPLAINT_TAG,
      }),
      howAreYouResponse: await loadHowAreYouResponse(db, {
        accountId: followup.account_id,
        appointmentId: followup.appointment_id,
      }),
    })
    if (reason) return { skip: reason }
  }

  // Si la cita no tiene conversación, la más reciente del contacto. Sin ninguna no hay
  // dónde guardar el mensaje: se omite para siempre (si quedara pendiente se
  // reintentaría en cada corrida y ocuparía el cupo de los que sí pueden salir).
  const conversationId =
    appointment.conversation_id ??
    (await findContactConversationId(db, followup.account_id, contactId))
  if (!conversationId) return { skip: 'no_conversation' }

  // Los cuidados salen con el texto del servicio, que pudo cambiar desde la siembra.
  const aftercare =
    followup.kind === 'cuidados'
      ? await loadAftercare(db, followup.account_id, appointment.service_id)
      : null
  if (followup.kind === 'cuidados' && !aftercare) return { skip: 'no_aftercare' }

  const channel = (await hasRecentCustomerMessage(db, conversationId, ctx.now)) ? 'text' : 'template'

  // El nombre del paciente. Si no se puede leer, no se envía ni se reclama: la
  // próxima corrida lo reintenta.
  const info = await loadClinicReminderInfo(db, {
    accountId: followup.account_id,
    appointmentId: followup.appointment_id,
    contactId,
  })

  return {
    delivery: {
      followupId: followup.id,
      appointmentId: followup.appointment_id,
      kind: followup.kind,
      accountId: followup.account_id,
      contactId,
      conversationId,
      ownerUserId: account.owner_user_id ?? '',
      channel,
      businessName: account.name,
      patientName: info.patientName,
      // Los cuidados solo viajan en un mensaje libre.
      aftercare: channel === 'text' ? aftercare : null,
      labels: ctx.labels.get(followup.account_id) ?? DEFAULT_LABELS,
    },
  }
}

/** `pending` → `skipped`, solo si nadie lo tomó antes. Devuelve si esta corrida lo omitió. */
async function markSkipped(
  db: SupabaseClient,
  followup: DueFollowupRow,
  reason: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('clinic_followups')
    .update({ status: 'skipped', skip_reason: reason })
    .eq('id', followup.id)
    .eq('account_id', followup.account_id)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`no se pudo omitir el seguimiento: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

/** `pending` → `sent`: solo gana quien lo encuentre pendiente. */
async function claimFollowup(
  db: SupabaseClient,
  followup: DueFollowupRow,
  claimedAtIso: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('clinic_followups')
    .update({ status: 'sent', sent_at: claimedAtIso })
    .eq('id', followup.id)
    .eq('account_id', followup.account_id)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`no se pudo reclamar el seguimiento: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Tras un envío fallido: vuelve a `pending` con un intento más, o a `failed` si ya
 * van tres. Solo toca la fila que esta corrida reclamó (`sent_at` es su marca).
 * Devuelve el error de la base, si lo hubo: si no se pudo revertir, el seguimiento
 * queda como enviado (se pierde antes que duplicarse).
 */
async function revertFollowup(
  db: SupabaseClient,
  followup: DueFollowupRow,
  claimedAtIso: string,
): Promise<string | null> {
  const attempts = followup.attempts + 1
  try {
    const { error } = await db
      .from('clinic_followups')
      .update({
        status: attempts >= FOLLOWUP_MAX_ATTEMPTS ? 'failed' : 'pending',
        attempts,
        sent_at: null,
      })
      .eq('id', followup.id)
      .eq('account_id', followup.account_id)
      .eq('status', 'sent')
      .eq('sent_at', claimedAtIso)
    return error ? error.message : null
  } catch (err) {
    return errorMessage(err)
  }
}

async function processFollowup(
  ctx: RunContext,
  followup: DueFollowupRow,
  summary: FollowupRunSummary,
): Promise<void> {
  const fail = (err: unknown) => {
    summary.failed++
    summary.errors.push(`seguimiento ${followup.id}: ${errorMessage(err)}`)
  }

  let prepared: Prepared
  try {
    prepared = await prepareFollowup(ctx, followup)
  } catch (err) {
    fail(err)
    return
  }

  if ('skip' in prepared) {
    try {
      if (await markSkipped(ctx.db, followup, prepared.skip)) summary.skipped++
    } catch (err) {
      fail(err)
    }
    return
  }

  try {
    if (!(await claimFollowup(ctx.db, followup, ctx.nowIso))) {
      // Otra corrida ganó el reclamo.
      summary.skipped++
      return
    }
  } catch (err) {
    fail(err)
    return
  }

  try {
    await ctx.send(prepared.delivery)
    summary.sent++
    summary.byChannel[prepared.delivery.channel]++
    summary.byKind[followup.kind]++
  } catch (err) {
    fail(err)
    const revertError = await revertFollowup(ctx.db, followup, ctx.nowIso)
    if (revertError) {
      summary.errors.push(
        `seguimiento ${followup.id}: no se pudo revertir el reclamo: ${revertError}`,
      )
    }
  }
}

/**
 * Cierre del día de una cuenta. Devuelve true si esta corrida avisó. Desde las
 * 20:00 de Bogotá, si hay citas de hoy ya empezadas sin marcar (`pending` o
 * `confirmed`), avisa una vez al dueño. Lanza si una lectura o el aviso fallan; si el
 * aviso falla, el cierre se suelta para que la próxima corrida lo reintente.
 */
async function closeDay(
  ctx: RunContext,
  account: ClinicAccountRow,
  labels: AgendaLabels,
): Promise<boolean> {
  const { db } = ctx
  const today = zonedParts(ctx.now)
  if (today.hour < DAY_CLOSE_HOUR || !account.owner_user_id) return false

  const { data: existing, error: existingError } = await db
    .from('clinic_day_closes')
    .select('date_key')
    .eq('account_id', account.id)
    .eq('date_key', today.dateKey)
    .maybeSingle()
  if (existingError) throw new Error(`no se pudo leer el cierre del día: ${existingError.message}`)
  if (existing) return false

  const { data: unmarked, error: unmarkedError } = await db
    .from('booking_appointments')
    .select('id')
    .eq('account_id', account.id)
    .in('status', ['pending', 'confirmed'])
    .gte('starts_at', startOfZonedDay(today.dateKey).toISOString())
    .lte('starts_at', ctx.nowIso)
  if (unmarkedError) {
    throw new Error(`no se pudieron leer las citas sin marcar: ${unmarkedError.message}`)
  }
  const count = ((unmarked ?? []) as unknown[]).length
  if (count === 0) return false

  // Se reclama el día ANTES de avisar: dos corridas a la vez no avisan las dos.
  const { data: claimed, error: claimError } = await db
    .from('clinic_day_closes')
    .upsert(
      { account_id: account.id, date_key: today.dateKey, notified_at: ctx.nowIso },
      { onConflict: 'account_id,date_key', ignoreDuplicates: true },
    )
    .select('account_id')
  if (claimError) throw new Error(`no se pudo reclamar el cierre del día: ${claimError.message}`)
  if (((claimed ?? []) as unknown[]).length === 0) return false

  const texts = buildClinicTexts(labels)
  try {
    await insertNotification(db, {
      accountId: account.id,
      userId: account.owner_user_id,
      conversationId: null,
      contactId: null,
      title: texts.dayCloseTitle,
      body: texts.dayCloseBody(count),
      createdAtIso: ctx.nowIso,
    })
  } catch (err) {
    // Sin aviso no hay cierre: se suelta el día para reintentar. Si tampoco se
    // puede soltar, el error lo dice: ese día quedaría sin aviso.
    const { error: releaseError } = await db
      .from('clinic_day_closes')
      .delete()
      .eq('account_id', account.id)
      .eq('date_key', today.dateKey)
    if (releaseError) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${reason} (y no se pudo soltar el cierre del día ${today.dateKey}: ${releaseError.message})`,
      )
    }
    throw err
  }
  return true
}

/**
 * Una pasada del runner: siembra los seguimientos de las citas atendidas, envía los
 * vencidos y, desde las 20:00, avisa el cierre del día. Pensado para ejecutarse cada
 * 10 min desde el cron.
 */
export async function runClinicFollowups(
  args: RunClinicFollowupsArgs,
): Promise<FollowupRunSummary> {
  const { db } = args
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()
  const summary: FollowupRunSummary = {
    accounts: 0,
    followupAccounts: 0,
    seeded: 0,
    due: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    byChannel: { text: 0, template: 0 },
    byKind: { cuidados: 0, como_sigues: 0, calificacion: 0 },
    dayCloses: 0,
    errors: [],
  }

  // Un fallo de lectura LANZA: devolver "0 cuentas" haría que el runner dejara de
  // enviar sin que la ruta alertara (responde 500 + alerta).
  const { data: accountRows, error: accountsError } = await readClinicAccounts(db)
  if (accountsError) {
    throw new Error(`no se pudieron leer las cuentas: ${accountsError.message}`)
  }
  const accounts = new Map((accountRows ?? []).map((account) => [account.id, account]))
  summary.accounts = accounts.size
  if (!accounts.size) return summary

  const { data: settingsRows, error: settingsError } = await db
    .from('booking_settings')
    .select('account_id, labels')
    .in('account_id', [...accounts.keys()])
  if (settingsError) {
    throw new Error(`no se pudo leer la configuración de las cuentas: ${settingsError.message}`)
  }
  const labels = new Map<string, AgendaLabels>()
  for (const row of (settingsRows ?? []) as { account_id: string; labels: unknown }[]) {
    labels.set(row.account_id, readLabels(row.labels))
  }

  // El interruptor de los seguimientos. Falta de fila = apagado; un fallo de lectura
  // LANZA (no se asume prendido: se le escribiría a pacientes sin permiso).
  const { data: switchRows, error: switchError } = await db
    .from('clinic_settings')
    .select('account_id, followups_enabled')
    .in('account_id', [...accounts.keys()])
  if (switchError) {
    throw new Error(`no se pudo leer el interruptor de los seguimientos: ${switchError.message}`)
  }
  const enabledIds = (
    (switchRows ?? []) as { account_id: string; followups_enabled: boolean | null }[]
  )
    .filter((row) => row.followups_enabled === true)
    .map((row) => row.account_id)
  summary.followupAccounts = enabledIds.length

  const ctx: RunContext = { db, send: args.send, now, nowIso, accounts, labels }

  // 1. Siembra. Una cuenta con problemas no frena a las demás.
  for (const accountId of enabledIds) {
    try {
      summary.seeded += await seedAccount(db, accountId, now)
    } catch (err) {
      summary.failed++
      summary.errors.push(`cuenta ${accountId}: ${errorMessage(err)}`)
    }
  }

  // 2. Envío de los vencidos, los más viejos primero. Solo de las cuentas con el
  // interruptor prendido: lo que quedó pendiente en una apagada espera.
  if (enabledIds.length) {
    const { data: dueRows, error: dueError } = await db
      .from('clinic_followups')
      .select('id, account_id, appointment_id, contact_id, kind, attempts')
      .in('account_id', enabledIds)
      .eq('status', 'pending')
      .lte('due_at', nowIso)
      .order('due_at', { ascending: true })
      .limit(args.limit ?? DEFAULT_LIMIT)
    if (dueError) {
      throw new Error(`no se pudieron leer los seguimientos: ${dueError.message}`)
    }
    const due = (dueRows ?? []) as DueFollowupRow[]
    summary.due = due.length
    for (const followup of due) {
      await processFollowup(ctx, followup, summary)
    }
  }

  // 3. Cierre del día (todas las cuentas con clínica, con o sin el interruptor).
  for (const account of accounts.values()) {
    try {
      if (await closeDay(ctx, account, labels.get(account.id) ?? DEFAULT_LABELS)) {
        summary.dayCloses++
      }
    } catch (err) {
      summary.failed++
      summary.errors.push(`cuenta ${account.id}: ${errorMessage(err)}`)
    }
  }

  return summary
}
