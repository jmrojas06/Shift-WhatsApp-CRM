// ============================================================
// Acceso a datos del controlador de reservas — service role.
//
// Todas las consultas van SIEMPRE acotadas por `account_id` (o
// por `conversation_id` ya validado aguas arriba): el fake de los
// tests aplica los filtros como PostgREST, así que una consulta
// sin cuenta lee filas de más y el test lo nota.
//
// Los ids de filas nuevas se generan aquí con randomUUID (mimo
// patrón que el instalador): no se depende del round-trip del
// default de Postgres.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { sanitizeBotTexts, type BotTextOverrides } from '../bot-texts'
import type { WorkBlock } from './availability'

export interface AccountInfo {
  id: string
  defaultCurrency: string | null
  ownerUserId: string | null
}

export interface ServiceInfo {
  id: string
  name: string
  description: string | null
  durationMinutes: number
  price: number
}

export interface StaffInfo {
  id: string
  name: string
}

export interface WorkBlockRow extends WorkBlock {
  staffId: string
}

export interface BusyRow {
  staffId: string
  startsAt: Date
  endsAt: Date
}

export interface AppointmentInfo {
  id: string
  contactId: string
  serviceId: string | null
  staffId: string | null
  startsAt: Date
  endsAt: Date
  status: string
}

export async function loadAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountInfo | null> {
  const { data } = await db
    .from('accounts')
    .select('id, default_currency, owner_user_id')
    .eq('id', accountId)
    .maybeSingle()
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: row.id as string,
    defaultCurrency: (row.default_currency as string | null) ?? null,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
  }
}

export async function loadInboundMessage(
  db: SupabaseClient,
  conversationId: string,
  messageId: string,
): Promise<{ text: string; replyId: string | null } | null> {
  const { data } = await db
    .from('messages')
    .select('content_text, interactive_reply_id')
    .eq('conversation_id', conversationId)
    .eq('message_id', messageId)
    .maybeSingle()
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    text: (row.content_text as string | null) ?? '',
    replyId: (row.interactive_reply_id as string | null) ?? null,
  }
}

export async function loadContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ name: string | null; phone: string | null } | null> {
  const { data } = await db
    .from('contacts')
    .select('name, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    name: (row.name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
  }
}

// ------------------------------------------------------------
// Sesiones
// ------------------------------------------------------------

/** Marca como expiradas las sesiones activas vencidas del contacto. */
export async function expireStaleSessions(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  nowIso: string,
): Promise<void> {
  const { error } = await db
    .from('booking_sessions')
    .update({ status: 'expired', updated_at: nowIso })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .lte('expires_at', nowIso)
  // Si falla, createSession choca con el índice único y ESA lanza.
  if (error) logWriteError('expirar sesiones vencidas', error)
}

/**
 * Escrituras que ocurren DESPUÉS de mandarle el menú al cliente
 * (refrescar / cerrar la sesión): lanzar ya no deshace el mensaje y
 * solo haría que la IA o las automatizaciones respondieran encima.
 * Se registran para que no fallen en silencio.
 */
function logWriteError(label: string, error: { message?: string }): void {
  console.error(`[barberia] no se pudo ${label}:`, error.message ?? error)
}

/**
 * Crea la sesión activa del contacto. Lanza si la base la rechaza
 * (p. ej. el índice único de sesión activa de 047): sin fila, el
 * siguiente tap del cliente no tendría a qué engancharse.
 */
export async function createSession(
  db: SupabaseClient,
  args: {
    id: string
    accountId: string
    contactId: string
    state: Record<string, unknown>
    expiresAtIso: string
  },
): Promise<void> {
  const { error } = await db.from('booking_sessions').insert({
    id: args.id,
    account_id: args.accountId,
    contact_id: args.contactId,
    state: args.state,
    status: 'active',
    expires_at: args.expiresAtIso,
  })
  if (error) {
    throw new Error(`No se pudo crear la sesión de reservas: ${error.message}`)
  }
}

export async function updateSession(
  db: SupabaseClient,
  args: {
    id: string
    accountId: string
    state: Record<string, unknown>
    updatedAtIso: string
    expiresAtIso: string
  },
): Promise<void> {
  const { error } = await db
    .from('booking_sessions')
    .update({
      state: args.state,
      expires_at: args.expiresAtIso,
      updated_at: args.updatedAtIso,
    })
    .eq('id', args.id)
    .eq('account_id', args.accountId)
  if (error) logWriteError('guardar el paso de la sesión', error)
}

/**
 * Reclama la sesión para confirmar: UPDATE condicional active →
 * completed. Solo un proceso gana; si dos taps de "Confirmar" llegan
 * a la vez, el perdedor recibe false y no agenda nada (sin esto, con
 * "Cualquiera" el segundo agendaba con otro barbero).
 */
export async function claimSession(
  db: SupabaseClient,
  args: { id: string; accountId: string; updatedAtIso: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('booking_sessions')
    .update({ status: 'completed', updated_at: args.updatedAtIso })
    .eq('id', args.id)
    .eq('account_id', args.accountId)
    .eq('status', 'active')
    .select('id')
  if (error) {
    throw new Error(`No se pudo reclamar la sesión de reservas: ${error.message}`)
  }
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Devuelve a 'active' una sesión reclamada cuando la cita no se pudo
 * crear (hora ganada por otro, error de base): el cliente sigue en el
 * flujo y su siguiente tap la encuentra.
 */
export async function releaseSession(
  db: SupabaseClient,
  args: { id: string; accountId: string; updatedAtIso: string },
): Promise<void> {
  const { error } = await db
    .from('booking_sessions')
    .update({ status: 'active', updated_at: args.updatedAtIso })
    .eq('id', args.id)
    .eq('account_id', args.accountId)
    .eq('status', 'completed')
  if (error) {
    console.error('[barberia] no se pudo reabrir la sesión:', error.message)
  }
}

export async function closeSession(
  db: SupabaseClient,
  args: {
    id: string
    accountId: string
    status: 'completed' | 'cancelled'
    updatedAtIso: string
  },
): Promise<void> {
  const { error } = await db
    .from('booking_sessions')
    .update({ status: args.status, updated_at: args.updatedAtIso })
    .eq('id', args.id)
    .eq('account_id', args.accountId)
  if (error) logWriteError('cerrar la sesión', error)
}

// ------------------------------------------------------------
// Catálogo y equipo
// ------------------------------------------------------------

export async function listServices(
  db: SupabaseClient,
  accountId: string,
): Promise<ServiceInfo[]> {
  const { data } = await db
    .from('booking_services')
    .select('id, name, description, duration_minutes, price')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position')
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    durationMinutes: Number(row.duration_minutes),
    price: Number(row.price),
  }))
}

/** Barberos activos que atienden un servicio, en orden de posición. */
export async function listEligibleStaff(
  db: SupabaseClient,
  accountId: string,
  serviceId: string,
): Promise<StaffInfo[]> {
  const { data: links } = await db
    .from('booking_staff_services')
    .select('staff_id')
    .eq('account_id', accountId)
    .eq('service_id', serviceId)
  const staffIds = ((links ?? []) as Record<string, unknown>[]).map(
    (row) => row.staff_id as string,
  )
  if (!staffIds.length) return []

  const { data } = await db
    .from('booking_staff')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .in('id', staffIds)
    .order('position')
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: row.name as string,
  }))
}

export async function loadStaffName(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
): Promise<string | null> {
  const { data } = await db
    .from('booking_staff')
    .select('name')
    .eq('id', staffId)
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data as Record<string, unknown> | null)?.name as string | null) ?? null
}

/** Nombre del servicio (recordatorios); null si el catálogo cambió. */
export async function loadServiceName(
  db: SupabaseClient,
  accountId: string,
  serviceId: string,
): Promise<string | null> {
  const { data } = await db
    .from('booking_services')
    .select('name')
    .eq('id', serviceId)
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data as Record<string, unknown> | null)?.name as string | null) ?? null
}

/**
 * Conversación más reciente del contacto: fallback para citas sin
 * `conversation_id` (p. ej. creadas a mano desde la agenda).
 */
export async function findContactConversationId(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return ((data as { id?: string } | null)?.id as string | null) ?? null
}

export async function listWorkBlocks(
  db: SupabaseClient,
  accountId: string,
  staffIds: string[],
): Promise<WorkBlockRow[]> {
  if (!staffIds.length) return []
  const { data } = await db
    .from('booking_working_hours')
    .select('staff_id, weekday, start_time, end_time')
    .eq('account_id', accountId)
    .in('staff_id', staffIds)
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    staffId: row.staff_id as string,
    weekday: Number(row.weekday),
    startTime: row.start_time as string,
    endTime: row.end_time as string,
  }))
}

/**
 * Citas activas + bloqueos de time off de los barberos, en una
 * ventana [fromIso, toIso). Los intervalos se devuelven crudos: el
 * cálculo de solapes vive en availability.ts.
 */
export async function listBusy(
  db: SupabaseClient,
  accountId: string,
  staffIds: string[],
  fromIso: string,
  toIso: string,
): Promise<BusyRow[]> {
  if (!staffIds.length) return []
  const out: BusyRow[] = []

  const { data: appts } = await db
    .from('booking_appointments')
    .select('staff_id, starts_at, ends_at')
    .eq('account_id', accountId)
    .in('staff_id', staffIds)
    .in('status', ['pending', 'confirmed'])
    .lt('starts_at', toIso)
    .gt('ends_at', fromIso)
  for (const row of (appts ?? []) as Record<string, unknown>[]) {
    out.push({
      staffId: row.staff_id as string,
      startsAt: new Date(row.starts_at as string),
      endsAt: new Date(row.ends_at as string),
    })
  }

  const { data: offs } = await db
    .from('booking_time_off')
    .select('staff_id, starts_at, ends_at')
    .eq('account_id', accountId)
    .in('staff_id', staffIds)
    .lt('starts_at', toIso)
    .gt('ends_at', fromIso)
  for (const row of (offs ?? []) as Record<string, unknown>[]) {
    out.push({
      staffId: row.staff_id as string,
      startsAt: new Date(row.starts_at as string),
      endsAt: new Date(row.ends_at as string),
    })
  }

  return out
}

/** ¿El barbero está libre en [startIso, endIso)? (citas + time off) */
export async function isStaffFree(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
  startIso: string,
  endIso: string,
): Promise<boolean> {
  const busy = await listBusy(db, accountId, [staffId], startIso, endIso)
  const start = new Date(startIso)
  const end = new Date(endIso)
  return !busy.some((b) => b.startsAt < end && b.endsAt > start)
}

// ------------------------------------------------------------
// Citas
// ------------------------------------------------------------

const APPOINTMENT_COLS =
  'id, contact_id, service_id, staff_id, starts_at, ends_at, status'

function mapAppointment(row: Record<string, unknown>): AppointmentInfo {
  return {
    id: row.id as string,
    contactId: row.contact_id as string,
    serviceId: (row.service_id as string | null) ?? null,
    staffId: (row.staff_id as string | null) ?? null,
    startsAt: new Date(row.starts_at as string),
    endsAt: new Date(row.ends_at as string),
    status: row.status as string,
  }
}

/** Próxima cita activa del contacto (pending/confirmed), si existe. */
export async function findNextAppointment(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  nowIso: string,
): Promise<AppointmentInfo | null> {
  const { data } = await db
    .from('booking_appointments')
    .select(APPOINTMENT_COLS)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .in('status', ['pending', 'confirmed'])
    .gt('starts_at', nowIso)
    .order('starts_at')
    .limit(1)
  const row = ((data ?? []) as Record<string, unknown>[])[0]
  return row ? mapAppointment(row) : null
}

export async function loadAppointment(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  appointmentId: string,
): Promise<AppointmentInfo | null> {
  const { data } = await db
    .from('booking_appointments')
    .select(APPOINTMENT_COLS)
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  return data ? mapAppointment(data as Record<string, unknown>) : null
}

/**
 * Inserta la cita. El error se devuelve tal cual: el controlador
 * distingue la violación del EXCLUDE anti-doble-reserva (23P01)
 * para reconducir al cliente al menú de horas.
 */
export async function insertAppointment(
  db: SupabaseClient,
  args: {
    id: string
    accountId: string
    contactId: string
    conversationId: string
    serviceId: string
    staffId: string
    startsAtIso: string
    endsAtIso: string
    status: 'confirmed'
    createdVia: 'bot'
    confirmedAtIso: string
    rescheduledFrom?: string | null
  },
): Promise<{ error: { code?: string | null; message?: string } | null }> {
  const { error } = await db.from('booking_appointments').insert({
    id: args.id,
    account_id: args.accountId,
    contact_id: args.contactId,
    conversation_id: args.conversationId,
    service_id: args.serviceId,
    staff_id: args.staffId,
    starts_at: args.startsAtIso,
    ends_at: args.endsAtIso,
    status: args.status,
    created_via: args.createdVia,
    confirmed_at: args.confirmedAtIso,
    ...(args.rescheduledFrom
      ? { rescheduled_from: args.rescheduledFrom }
      : {}),
  })
  return { error }
}

export async function cancelAppointment(
  db: SupabaseClient,
  args: {
    accountId: string
    id: string
    reason: string
    cancelledAtIso: string
  },
): Promise<void> {
  const { error } = await db
    .from('booking_appointments')
    .update({
      status: 'cancelled',
      cancel_reason: args.reason,
      cancelled_at: args.cancelledAtIso,
      updated_at: args.cancelledAtIso,
    })
    .eq('id', args.id)
    .eq('account_id', args.accountId)
  // Crítica: el bot no puede decir "cancelada" si la cita sigue viva.
  if (error) throw new Error(`No se pudo cancelar la cita: ${error.message}`)
}

/**
 * Confirmación de una cita existente (botón Confirmar del
 * recordatorio). Idempotente: una cita ya confirmada solo refresca
 * `confirmed_at`. El trigger de 047 registra el cambio de estado.
 */
export async function markAppointmentConfirmed(
  db: SupabaseClient,
  args: {
    accountId: string
    id: string
    confirmedAtIso: string
  },
): Promise<void> {
  const { error } = await db
    .from('booking_appointments')
    .update({
      status: 'confirmed',
      confirmed_at: args.confirmedAtIso,
      updated_at: args.confirmedAtIso,
    })
    .eq('id', args.id)
    .eq('account_id', args.accountId)
  if (error) throw new Error(`No se pudo confirmar la cita: ${error.message}`)
}

// ------------------------------------------------------------
// CRM: etiquetas, negocios y eventos
// ------------------------------------------------------------

/** Etiqueta el contacto, creando la etiqueta si aún no existe. */
export async function applyContactTag(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    tagName: string
    userId: string
  },
): Promise<void> {
  const { data: tag } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', args.tagName)
    .maybeSingle()
  let tagId = (tag as { id?: string } | null)?.id
  if (!tagId) {
    tagId = crypto.randomUUID()
    await db
      .from('tags')
      .insert({
        id: tagId,
        account_id: args.accountId,
        user_id: args.userId,
        name: args.tagName,
      })
  }
  await db
    .from('contact_tags')
    .upsert(
      { contact_id: args.contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )
}

/**
 * Crea o actualiza el negocio del contacto en el pipeline
 * "Barbería" (etapa "Cita agendada"). Si la instalación no corrió
 * (no hay pipeline/etapa), no hace nada: agendar nunca depende del
 * CRM comercial.
 */
export async function upsertBarberiaDeal(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    contactId: string
    conversationId: string
    title: string
    value: number
    currency: string
    nowIso: string
  },
): Promise<boolean> {
  const { data: pipelines } = await db
    .from('pipelines')
    .select('id, name')
    .eq('account_id', args.accountId)
  const pipeline = ((pipelines ?? []) as Record<string, unknown>[]).find(
    (row) => String(row.name).trim().toLowerCase() === 'barbería',
  )
  if (!pipeline) return false

  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', pipeline.id)
  const stage = ((stages ?? []) as Record<string, unknown>[]).find(
    (row) => String(row.name).trim().toLowerCase() === 'cita agendada',
  )
  if (!stage) return false

  const { data: existing } = await db
    .from('deals')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('pipeline_id', pipeline.id)
    .eq('status', 'open')
    .maybeSingle()

  if (existing) {
    await db
      .from('deals')
      .update({
        stage_id: stage.id,
        value: args.value,
        currency: args.currency,
        conversation_id: args.conversationId,
        updated_at: args.nowIso,
      })
      .eq('id', (existing as { id: string }).id)
      .eq('account_id', args.accountId)
    return true
  }

  await db.from('deals').insert({
    id: crypto.randomUUID(),
    account_id: args.accountId,
    user_id: args.userId,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
    contact_id: args.contactId,
    conversation_id: args.conversationId,
    title: args.title,
    value: args.value,
    currency: args.currency,
    status: 'open',
  })
  return true
}

/**
 * Evento explícito del bot en `booking_events`.
 *
 * En producción el trigger de la migración 047 ya registra
 * created/cancelled/rescheduled; estos eventos agregan el contexto
 * del controlador (actor `bot`, payload con el porqué). No son la
 * fuente de verdad del historial.
 */
export async function insertBookingEvent(
  db: SupabaseClient,
  args: {
    accountId: string
    appointmentId: string
    event: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  await db.from('booking_events').insert({
    id: crypto.randomUUID(),
    account_id: args.accountId,
    appointment_id: args.appointmentId,
    event: args.event,
    actor: 'bot',
    payload: args.payload,
  })
}

// ------------------------------------------------------------
// Handoff
// ------------------------------------------------------------

export async function loadHandoffAgentId(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from('ai_configs')
    .select('handoff_agent_id')
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data as Record<string, unknown> | null)?.handoff_agent_id as
    | string
    | null) ?? null
}

/**
 * Pausa la IA en la conversación y, si hay agente de handoff
 * configurado, le asigna el hilo (el trigger de conversaciones
 * avisa a ese agente).
 */
export async function markConversationHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    note: string
    agentId: string | null
  },
): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({
      ai_autoreply_disabled: true,
      ai_handoff_summary: args.note,
      ...(args.agentId ? { assigned_agent_id: args.agentId } : {}),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
  // Crítica: sin la pausa, prometerle un humano al cliente sería falso
  // (el bot y la IA seguirían respondiendo).
  if (error) throw new Error(`No se pudo pausar el bot: ${error.message}`)
}

export async function insertNotification(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    title: string
    body: string
  },
): Promise<void> {
  await db.from('notifications').insert({
    id: crypto.randomUUID(),
    account_id: args.accountId,
    user_id: args.userId,
    type: 'conversation_assigned',
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    actor_user_id: null,
    title: args.title,
    body: args.body,
  })
}

/**
 * Overrides de copy del bot configurados desde la UI (Fase 4).
 *
 * Tolera todo: fila ausente, columna vacía o jsonb con basura — ante
 * la duda devuelve `{}` y el controlador usa el copy por defecto. Un
 * error de configuración NUNCA puede tumbar la conversación.
 */
export async function loadBotTexts(
  db: SupabaseClient,
  accountId: string,
): Promise<BotTextOverrides> {
  const { data } = await db
    .from('booking_settings')
    .select('bot_texts')
    .eq('account_id', accountId)
    .maybeSingle()
  const raw = (data as { bot_texts?: unknown } | null)?.bot_texts
  const clean = sanitizeBotTexts(raw ?? {})
  return clean.ok ? clean.value : {}
}
