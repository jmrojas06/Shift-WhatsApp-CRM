// ============================================================
// Acceso a datos de las citas que la recepción crea, mueve o cancela
// desde el panel. Las rutas lo llaman con el cliente del usuario (RLS);
// todo va SIEMPRE acotado por `account_id`.
//
// Las reglas viven en panel-booking.ts (puro). Aquí solo se lee lo que
// esas reglas necesitan y se escribe lo que decidieron. Las lecturas
// que alimentan una regla LANZAN si fallan: decidir con datos a medias
// (sin horario, sin sillones) sería peor que no decidir. Los errores
// llevan solo el mensaje de la base, nunca nombres ni teléfonos.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'
import { recordConsent } from '@/modules/clinica/consent'
import { insertPatient, listPatients, PATIENT_NAME_MAX } from '@/modules/clinica/patients'

import type { WorkBlock } from './agent/availability'
import { loadChairContext, type ChairContext } from './agent/chairs'
import { listWorkBlocks } from './agent/db'
import { DEFAULT_LABELS, readLabels, type AgendaLabels } from './labels'

// ------------------------------------------------------------
// Cuenta y catálogo
// ------------------------------------------------------------

/** Las palabras de la cuenta ("doctor", "turno"…). Si no se leen, las de por defecto. */
export async function loadPanelLabels(db: SupabaseClient, accountId: string): Promise<AgendaLabels> {
  const { data, error } = await db
    .from('booking_settings')
    .select('labels')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[agenda panel] no se pudieron leer las palabras de la cuenta:', error.message)
    return { ...DEFAULT_LABELS }
  }
  return readLabels((data as { labels?: unknown } | null)?.labels)
}

/** ¿La cuenta tiene el módulo clínica? Lanza si no se pueden leer los módulos. */
export async function accountHasClinic(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { account, error } = await readAccountModules(db, accountId)
  if (error) throw new Error(`No se pudieron leer los módulos de la cuenta: ${error.message ?? ''}`)
  return hasModule(account, 'clinica')
}

export interface BookableService {
  id: string
  name: string
  durationMinutes: number
}

/** El servicio, si es de la cuenta y está activo. */
export async function loadBookableService(
  db: SupabaseClient,
  accountId: string,
  serviceId: string,
): Promise<BookableService | null> {
  const { data, error } = await db
    .from('booking_services')
    .select('id, name, duration_minutes')
    .eq('id', serviceId)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer el servicio: ${error.message}`)
  if (!data) return null
  const row = data as { id: string; name: string; duration_minutes: number | string }
  return { id: row.id, name: row.name, durationMinutes: Number(row.duration_minutes) }
}

/** El profesional, si es de la cuenta y está activo. */
export async function loadBookableStaff(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db
    .from('booking_staff')
    .select('id, name')
    .eq('id', staffId)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer al profesional: ${error.message}`)
  return (data as { id: string; name: string } | null) ?? null
}

/** ¿Ese profesional atiende ese servicio? (la misma relación que usa el bot) */
export async function staffServesService(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
  serviceId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('booking_staff_services')
    .select('staff_id')
    .eq('account_id', accountId)
    .eq('staff_id', staffId)
    .eq('service_id', serviceId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer qué atiende el profesional: ${error.message}`)
  return Boolean(data)
}

// ------------------------------------------------------------
// Horario, bloqueos y sillones de una franja
// ------------------------------------------------------------

export interface SlotContext {
  workBlocks: WorkBlock[]
  timeOff: { startsAt: Date; endsAt: Date }[]
  /** null si la cuenta no es clínica. */
  chairs: ChairContext | null
}

/**
 * Lo que `validatePanelBooking` necesita para [startsAt, endsAt): los bloques
 * de trabajo del profesional, sus bloqueos que tocan la franja y, en una
 * clínica, los sillones. Al mover, `ignore` es el horario actual de la propia
 * cita: se descuenta de los sillones para que no choque consigo misma. (El
 * choque con el profesional lo decide la base, que ya la excluye por id.)
 */
export async function loadSlotContext(
  db: SupabaseClient,
  args: {
    accountId: string
    staffId: string
    startsAt: Date
    endsAt: Date
    clinic: boolean
    ignore?: { startsAt: Date; endsAt: Date }
  },
): Promise<SlotContext> {
  const { accountId, staffId } = args
  const fromIso = args.startsAt.toISOString()
  const toIso = args.endsAt.toISOString()

  const blocks = await listWorkBlocks(db, accountId, [staffId])
  const workBlocks: WorkBlock[] = blocks.map((b) => ({
    weekday: b.weekday,
    startTime: b.startTime,
    endTime: b.endTime,
  }))

  const { data, error } = await db
    .from('booking_time_off')
    .select('starts_at, ends_at')
    .eq('account_id', accountId)
    .eq('staff_id', staffId)
    .lt('starts_at', toIso)
    .gt('ends_at', fromIso)
  if (error) throw new Error(`No se pudieron leer los bloqueos: ${error.message}`)
  const timeOff = ((data ?? []) as { starts_at: string; ends_at: string }[]).map((row) => ({
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
  }))

  if (!args.clinic) return { workBlocks, timeOff, chairs: null }

  const chairs = await loadChairContext(db, accountId, fromIso, toIso)
  if (args.ignore) {
    const { startsAt, endsAt } = args.ignore
    const own = chairs.active.findIndex(
      (a) => a.startsAt.getTime() === startsAt.getTime() && a.endsAt.getTime() === endsAt.getTime(),
    )
    // Se quita una sola: si otra cita tiene exactamente la misma franja, sigue contando.
    if (own >= 0) chairs.active.splice(own, 1)
  }
  return { workBlocks, timeOff, chairs }
}

// ------------------------------------------------------------
// Contacto, conversación y paciente
// ------------------------------------------------------------

export interface PanelContact {
  id: string
  name: string | null
}

export async function loadPanelContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<PanelContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select('id, name')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer el contacto: ${error.message}`)
  return (data as PanelContact | null) ?? null
}

/**
 * La conversación del contacto (la más antigua), o una vacía de WhatsApp si
 * aún no tiene ninguna — sin enviar nada, igual que cuando el CRM escribe a un
 * contacto nuevo. Mismos campos que `resolveConversationByPhone`; si otra
 * petición la crea al mismo tiempo (único de 036), se usa la ganadora.
 */
export async function ensureConversation(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; userId: string },
): Promise<string> {
  const find = async (): Promise<string | null> => {
    const { data, error } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw new Error(`No se pudo leer la conversación: ${error.message}`)
    return ((data ?? []) as { id: string }[])[0]?.id ?? null
  }

  const existing = await find()
  if (existing) return existing

  const { data: created, error } = await db
    .from('conversations')
    .insert({ account_id: args.accountId, user_id: args.userId, contact_id: args.contactId })
    .select('id')
    .single()
  if (created && !error) return (created as { id: string }).id
  if (isUniqueViolation(error)) {
    const raced = await find()
    if (raced) return raced
  }
  throw new Error(`No se pudo crear la conversación: ${error?.message ?? 'sin respuesta'}`)
}

export type PatientRejection = 'patient_not_found' | 'patient_required'

export const PATIENT_MESSAGES: Record<PatientRejection, string> = {
  patient_not_found: 'Ese paciente no es de este contacto. Elige otro o escribe uno nuevo.',
  patient_required:
    'Elige el paciente de la cita, o escribe su nombre y apellido si es nuevo.',
}

/**
 * Paciente de la cita (solo clínicas):
 *   - `patientId`: debe ser de ese contacto.
 *   - `newPatientName`: se registra uno nuevo.
 *   - ninguno: si el contacto no tiene pacientes se crea uno con su propio
 *     nombre (la persona que llama es quien va); si ya tiene, hay que elegir.
 */
export async function resolvePatient(
  db: SupabaseClient,
  args: {
    accountId: string
    contact: PanelContact
    patientId: string | null
    newPatientName: string | null
  },
): Promise<{ ok: true; patientId: string } | { ok: false; code: PatientRejection }> {
  const { accountId, contact } = args
  const patients = await listPatients(db, { accountId, contactId: contact.id })

  if (args.patientId) {
    return patients.some((p) => p.id === args.patientId)
      ? { ok: true, patientId: args.patientId }
      : { ok: false, code: 'patient_not_found' }
  }

  const name = args.newPatientName ?? (patients.length === 0 ? usableContactName(contact.name) : null)
  if (!name) return { ok: false, code: 'patient_required' }
  const created = await insertPatient(db, { accountId, contactId: contact.id, fullName: name })
  return { ok: true, patientId: created.id }
}

/**
 * El nombre del contacto sirve de nombre del paciente solo si parece un
 * nombre: con alguna letra y dentro del tope. Un contacto sin nombre guarda su
 * teléfono en `name` y eso no es un paciente.
 */
function usableContactName(raw: string | null): string | null {
  const name = (raw ?? '').replace(/\s+/gu, ' ').trim()
  if (!name || [...name].length > PATIENT_NAME_MAX || !/\p{L}/u.test(name)) return null
  return name
}

// ------------------------------------------------------------
// Autorización de datos hecha en recepción
// ------------------------------------------------------------

export type ReceptionConsentOutcome = 'recorded' | 'not_declared' | 'already_decided'

/**
 * Si la clínica declaró que obtiene el permiso en recepción, deja la
 * autorización de datos sensibles del contacto con origen `recepcion` y el
 * texto vigente — pero solo si el contacto aún no tiene ninguna decisión: un
 * "no" (o una revocación) nunca se vuelve "sí" por una cita agendada a mano.
 *
 * `admin` es el service role: el registro no tiene política de escritura para
 * el navegador. Lanza si algo falla; quien llama decide (la cita ya está
 * guardada y el bot pedirá la autorización si falta).
 */
export async function recordReceptionConsent(
  db: SupabaseClient,
  admin: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    consentText: string
    consentVersion: number
    nowIso: string
  },
): Promise<ReceptionConsentOutcome> {
  const { data: settings, error: settingsError } = await db
    .from('clinic_settings')
    .select('reception_consent_declared_at')
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (settingsError) throw new Error(`No se pudo leer la declaración: ${settingsError.message}`)
  const declared = (settings as { reception_consent_declared_at: string | null } | null)
    ?.reception_consent_declared_at
  if (!declared) return 'not_declared'

  const { data: previous, error: previousError } = await db
    .from('clinic_consents')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('kind', 'datos_sensibles')
    .limit(1)
  if (previousError) throw new Error(`No se pudo leer la autorización: ${previousError.message}`)
  if (((previous ?? []) as unknown[]).length > 0) return 'already_decided'

  await recordConsent(admin, {
    accountId: args.accountId,
    contactId: args.contactId,
    kind: 'datos_sensibles',
    granted: true,
    textVersion: args.consentVersion,
    textSnapshot: args.consentText,
    source: 'recepcion',
    createdAtIso: args.nowIso,
  })
  return 'recorded'
}

// ------------------------------------------------------------
// Editar una cita existente
// ------------------------------------------------------------

export interface EditableAppointment {
  id: string
  status: string
  startsAt: Date
  endsAt: Date
  staffId: string | null
  serviceId: string | null
  /** Tal cual la devuelve la base: se usa para el bloqueo optimista. */
  updatedAt: string
}

export async function loadEditableAppointment(
  db: SupabaseClient,
  accountId: string,
  appointmentId: string,
): Promise<EditableAppointment | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, status, starts_at, ends_at, staff_id, service_id, updated_at')
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la cita: ${error.message}`)
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    status: row.status as string,
    startsAt: new Date(row.starts_at as string),
    endsAt: new Date(row.ends_at as string),
    staffId: (row.staff_id as string | null) ?? null,
    serviceId: (row.service_id as string | null) ?? null,
    updatedAt: row.updated_at as string,
  }
}

export type MoveWriteResult =
  | { kind: 'ok'; appointment: { id: string; status: string; starts_at: string; ends_at: string; staff_id: string | null } }
  | { kind: 'stale' }
  | { kind: 'slot_taken' }

/**
 * Mueve la cita en su misma fila (el id y el evento de Google se conservan).
 * Solo escribe si nadie la tocó desde que se leyó (`updated_at`) y sigue
 * activa; si no, `stale`. Borra las marcas de recordatorio y de confirmación
 * del paciente: para la hora nueva vuelven a salir y a pedirse.
 */
export async function writeMove(
  db: SupabaseClient,
  args: {
    accountId: string
    appointment: EditableAppointment
    startsAt: Date
    endsAt: Date
    staffId: string
  },
): Promise<MoveWriteResult> {
  const { data, error } = await db
    .from('booking_appointments')
    .update({
      starts_at: args.startsAt.toISOString(),
      ends_at: args.endsAt.toISOString(),
      staff_id: args.staffId,
      reminder_sent_at: null,
      reminder_2h_sent_at: null,
      attendance_confirmed_at: null,
    })
    .eq('id', args.appointment.id)
    .eq('account_id', args.accountId)
    .eq('updated_at', args.appointment.updatedAt)
    .in('status', ['pending', 'confirmed'])
    .select('id, status, starts_at, ends_at, staff_id')
    .maybeSingle()
  // El EXCLUDE anti-doble-reserva de 047: el profesional ya tiene otra cita.
  if (error?.code === '23P01') return { kind: 'slot_taken' }
  if (error) throw new Error(`No se pudo mover la cita: ${error.message}`)
  if (!data) return { kind: 'stale' }
  return { kind: 'ok', appointment: data as Extract<MoveWriteResult, { kind: 'ok' }>['appointment'] }
}

/**
 * Cancela la cita con el motivo. Solo pisa el estado que se leyó: si alguien
 * más la cambió entre tanto devuelve null (`stale`).
 */
export async function writeCancel(
  db: SupabaseClient,
  args: {
    accountId: string
    appointment: EditableAppointment
    reason: string
    nowIso: string
  },
): Promise<{ id: string; status: string } | null> {
  const { data, error } = await db
    .from('booking_appointments')
    .update({ status: 'cancelled', cancelled_at: args.nowIso, cancel_reason: args.reason })
    .eq('id', args.appointment.id)
    .eq('account_id', args.accountId)
    .eq('status', args.appointment.status)
    .select('id, status')
    .maybeSingle()
  if (error) throw new Error(`No se pudo cancelar la cita: ${error.message}`)
  return (data as { id: string; status: string } | null) ?? null
}
