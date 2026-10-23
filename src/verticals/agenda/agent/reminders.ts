// ============================================================
// Recordatorios de citas — Fase 3 del vertical de la agenda.
//
// Dos señales por cita, idempotentes por construcción:
//   - 24 h antes (siempre; `reminder_sent_at`),
//   - 2 h antes (opcional por cuenta; `reminder_2h_sent_at`).
//
// Si la cita se crea a menos de 2 h, sale UNA sola señal: la de 2 h
// marca también la de 24 h. Nunca dos mensajes seguidos.
//
// Canal (decisión determinista, no de la IA):
//   - dentro de la ventana de 24 h de WhatsApp (el cliente escribió
//     en las últimas 24 h) → mensaje libre con botones;
//   - fuera de la ventana → plantilla aprobada en Meta.
//
// El runner reclama cada señal con un UPDATE condicional ANTES de
// enviar: dos corridas simultáneas no mandan dos veces. Si el envío
// falla, la marca se revierte (mejor esfuerzo) y la próxima corrida
// reintenta.
//
// La decisión pura (`pickDueReminder`) y los builders no tocan red
// ni base: el runner recibe el envío inyectado y los tests corren
// con un fake.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUndefinedColumnError } from '@/lib/modules/undefined-column'
import { hasModule, type AccountModulesSource } from '@/lib/verticals/registry'
import { AGENDA_VERTICAL_KEYS } from '@/lib/verticals/types'

import { DEFAULT_LABELS, readLabels, type AgendaLabels } from '../labels'
import { AGENDA_AGENT_TEXTS, buildAgentTexts } from '../texts'
import { findContactConversationId, loadServiceName, loadStaffName } from './db'
import { formatLongDate, formatTimeLabel } from './format'
import { remId, type ReminderAction } from './state'
import { zonedParts } from './time'

export const H24_MS = 24 * 60 * 60 * 1000
export const H2_MS = 2 * 60 * 60 * 1000

/** Por corrida, para acotar tiempo de ejecución del cron. */
const DEFAULT_LIMIT = 50

/**
 * Plantilla aprobada en Meta para el recordatorio fuera de la
 * ventana de 24 h. El nombre y el idioma deben coincidir EXACTAMENTE
 * con los de la plantilla creada en WhatsApp Manager
 * (ver docs/agenda-recordatorios.md).
 */
export const AGENDA_REMINDER_TEMPLATE = {
  name: 'recordatorio_cita',
  language: 'es',
} as const

export type ReminderKind = 'h24' | 'h2'

// ------------------------------------------------------------
// Decisión pura
// ------------------------------------------------------------

export interface ReminderDecisionInput {
  startsAtMs: number
  nowMs: number
  /** `reminder_sent_at` en ms, o null si no hay señal previa. */
  reminderSentAtMs: number | null
  /** `reminder_2h_sent_at` en ms, o null si no hay 2.ª señal. */
  reminder2hSentAtMs: number | null
  twoHourEnabled: boolean
}

/** ¿Toca enviar ahora? Devuelve la señal vencida (o null). */
export function pickDueReminder(
  input: ReminderDecisionInput,
): ReminderKind | null {
  const {
    startsAtMs,
    nowMs,
    reminderSentAtMs,
    reminder2hSentAtMs,
    twoHourEnabled,
  } = input

  // Cita ya iniciada: nada que recordar.
  if (startsAtMs <= nowMs) return null

  if (twoHourEnabled) {
    const finalWindowMs = startsAtMs - H2_MS
    const secondPending = reminder2hSentAtMs === null
    if (secondPending && nowMs >= finalWindowMs) {
      // La 2.ª señal solo aplica si la 1.ª salió antes de que
      // abriera esta ventana; así una cita creada a <2 h recibe UNA
      // señal (esta) y no dos seguidas.
      if (reminderSentAtMs === null || reminderSentAtMs < finalWindowMs) {
        return 'h2'
      }
      return null
    }
  }

  if (reminderSentAtMs === null && nowMs >= startsAtMs - H24_MS) return 'h24'
  return null
}

// ------------------------------------------------------------
// Mensaje y plantilla (builders puros)
// ------------------------------------------------------------

export interface ReminderDelivery {
  appointmentId: string
  accountId: string
  contactId: string
  conversationId: string
  /** Dueño de la cuenta: columnas de auditoría de los senders. */
  ownerUserId: string
  kind: ReminderKind
  channel: 'text' | 'template'
  businessName: string
  serviceName: string | null
  staffName: string | null
  startsAtIso: string
  dateLabel: string
  timeLabel: string
  /** Palabras del negocio (cita, servicio…) para el cuerpo del mensaje libre. */
  labels: AgendaLabels
  /**
   * Pieza "reprogramar/cancelar" de la cuenta. Apagada, el mensaje libre
   * solo ofrece Confirmar (la plantilla de Meta tiene botones fijos).
   */
  allowReschedule: boolean
}

export type ReminderSender = (delivery: ReminderDelivery) => Promise<void>

/** Nombre visible del servicio, tolerante a catálogo cambiado. */
export const reminderServiceLabel = (
  name: string | null,
  texts: { serviceFallback: string } = AGENDA_AGENT_TEXTS,
): string => name ?? texts.serviceFallback

/** Nombre visible del profesional, tolerante a catálogo cambiado. */
export const reminderStaffLabel = (
  name: string | null,
  texts: { staffAnyTitle: string } = AGENDA_AGENT_TEXTS,
): string => name ?? texts.staffAnyTitle

/**
 * Botones Confirmar / Reprogramar / Cancelar (ids estáticos rem:*).
 * Con la pieza de reprogramar apagada solo queda Confirmar.
 */
export function reminderButtons(
  allowReschedule = true,
): { id: string; title: string }[] {
  const actions: { action: ReminderAction; title: string }[] = [
    { action: 'confirm', title: AGENDA_AGENT_TEXTS.reminderConfirm },
    ...(allowReschedule
      ? [
          { action: 'reschedule' as const, title: AGENDA_AGENT_TEXTS.reminderReschedule },
          { action: 'cancel' as const, title: AGENDA_AGENT_TEXTS.reminderCancel },
        ]
      : []),
  ]
  return actions.map(({ action, title }) => ({ id: remId(action), title }))
}

/** Cuerpo del mensaje libre (la versión con botones del recordatorio). */
export function buildReminderBody(d: ReminderDelivery): string {
  const texts = buildAgentTexts(d.labels)
  return texts.reminderBody({
    business: d.businessName,
    service: reminderServiceLabel(d.serviceName, texts),
    staff: reminderStaffLabel(d.staffName, texts),
    date: d.dateLabel,
    time: d.timeLabel,
  })
}

/**
 * Variables del cuerpo de la plantilla, en el orden documentado:
 * {{1}} negocio · {{2}} servicio · {{3}} barbero · {{4}} fecha ·
 * {{5}} hora.
 */
export function buildReminderTemplateParams(d: ReminderDelivery): string[] {
  const texts = buildAgentTexts(d.labels)
  return [
    d.businessName,
    reminderServiceLabel(d.serviceName, texts),
    reminderStaffLabel(d.staffName, texts),
    d.dateLabel,
    d.timeLabel,
  ]
}

// ------------------------------------------------------------
// Claim / reversa (UPDATE condicional, service role)
// ------------------------------------------------------------

export interface ClaimReminderArgs {
  id: string
  accountId: string
  kind: ReminderKind
  claimedAtIso: string
  /** Valor previo de `reminder_sent_at` (para la reversa). */
  previousReminderSentAt: string | null
}

/**
 * Reclama la señal con una condición sobre la propia columna: solo
 * gana quien la encuentre sin marcar. Devuelve true si esta corrida
 * se quedó con el envío.
 */
export async function claimReminder(
  db: SupabaseClient,
  args: ClaimReminderArgs,
): Promise<boolean> {
  const guard = {
    status: ['pending', 'confirmed'],
  } as const

  const query =
    args.kind === 'h24'
      ? db
          .from('booking_appointments')
          .update({
            reminder_sent_at: args.claimedAtIso,
            updated_at: args.claimedAtIso,
          })
          .eq('id', args.id)
          .eq('account_id', args.accountId)
          .in('status', [...guard.status])
          .gt('starts_at', args.claimedAtIso)
          .is('reminder_sent_at', null)
      : db
          .from('booking_appointments')
          .update({
            reminder_2h_sent_at: args.claimedAtIso,
            // La 2.ª señal cumple también la 1.ª cuando llegó primero.
            reminder_sent_at: args.previousReminderSentAt ?? args.claimedAtIso,
            updated_at: args.claimedAtIso,
          })
          .eq('id', args.id)
          .eq('account_id', args.accountId)
          .in('status', [...guard.status])
          .gt('starts_at', args.claimedAtIso)
          .is('reminder_2h_sent_at', null)

  const { data } = await query.select('id')
  return ((data ?? []) as unknown[]).length > 0
}

/** Devuelve la marca a su valor previo tras un envío fallido. */
async function revertReminder(
  db: SupabaseClient,
  args: ClaimReminderArgs,
): Promise<void> {
  try {
    if (args.kind === 'h24') {
      await db
        .from('booking_appointments')
        .update({ reminder_sent_at: args.previousReminderSentAt })
        .eq('id', args.id)
        .eq('account_id', args.accountId)
        .eq('reminder_sent_at', args.claimedAtIso)
      return
    }
    await db
      .from('booking_appointments')
      .update({
        reminder_2h_sent_at: null,
        reminder_sent_at: args.previousReminderSentAt,
      })
      .eq('id', args.id)
      .eq('account_id', args.accountId)
      .eq('reminder_2h_sent_at', args.claimedAtIso)
  } catch {
    // Mejor esfuerzo: si la reversa falla, la señal queda marcada
    // (se pierde el recordatorio antes que duplicarlo).
  }
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

/**
 * ¿El cliente escribió en las últimas 24 h? (ventana de WhatsApp). Exportada
 * para los avisos de Ventas, que usan la misma regla de canal.
 */
export async function hasRecentCustomerMessage(
  db: SupabaseClient,
  conversationId: string,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - H24_MS).toISOString()
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gt('created_at', since)
    .limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Cuentas con el módulo agenda. La base trae un superconjunto simple
 * (`modules` contiene 'agenda', o `vertical_key` es 'agenda' / 'barberia')
 * y la regla exacta la pone `hasModule` en código, la misma de
 * `getAccountModules`: `modules` decide cuando trae algo y `vertical_key`
 * solo cuenta con `modules` vacío. Así una cuenta 'barberia' con
 * `modules = {ventas}` llega de la base pero se descarta aquí.
 *
 * Si la columna `modules` no existe todavía (migración 053 sin aplicar)
 * repite con `vertical_key`, para que el cron siga recordando.
 */
async function readAgendaAccounts(db: SupabaseClient) {
  const result = await db
    .from('accounts')
    .select('id, name, owner_user_id, modules, vertical_key')
    .or(`modules.cs.{agenda},vertical_key.in.(${AGENDA_VERTICAL_KEYS.join(',')})`)
  const fallback = isUndefinedColumnError(result.error)
    ? await db
        .from('accounts')
        .select('id, name, owner_user_id, vertical_key')
        .in('vertical_key', [...AGENDA_VERTICAL_KEYS])
    : result
  if (fallback.error) return { data: null, error: fallback.error }
  const rows = (fallback.data ?? []) as (AccountRow &
    AccountModulesSource)[]
  return {
    data: rows.filter((row) => hasModule(row, 'agenda')),
    error: null,
  }
}

export interface ReminderRunSummary {
  /** Cuentas de la agenda (módulo `agenda`, o `vertical_key` 'agenda' / alias 'barberia'). */
  accounts: number
  /** Citas activas con alguna señal pendiente (24 h o 2 h). */
  due: number
  sent: number
  failed: number
  skipped: number
  byChannel: { text: number; template: number }
  byKind: { h24: number; h2: number }
  errors: string[]
}

export interface RunAgendaRemindersArgs {
  db: SupabaseClient
  send: ReminderSender
  now?: Date
  limit?: number
}

interface DueAppointmentRow {
  id: string
  account_id: string
  contact_id: string
  conversation_id: string | null
  service_id: string | null
  staff_id: string | null
  starts_at: string
  status: string
  reminder_sent_at: string | null
  reminder_2h_sent_at: string | null
}

interface AccountRow {
  id: string
  name: string
  owner_user_id: string
}

const DUE_COLUMNS =
  'id, account_id, contact_id, conversation_id, service_id, staff_id, starts_at, status, reminder_sent_at, reminder_2h_sent_at'

/**
 * Citas con alguna señal PENDIENTE, nunca las ya recordadas: si no,
 * con más de `limit` citas en las próximas 24 h (sumando todas las
 * barberías) las ya recordadas ocupaban todo el cupo y las demás
 * esperaban hasta que las primeras pasaran.
 *
 * Dos consultas, cada una sobre su índice parcial (047 / 048):
 *   - 24 h: `reminder_sent_at IS NULL` dentro de las próximas 24 h;
 *   - 2 h: solo cuentas con la 2.ª señal activa,
 *     `reminder_2h_sent_at IS NULL` dentro de las próximas 2 h.
 */
async function loadPendingAppointments(
  db: SupabaseClient,
  args: {
    accountIds: string[]
    twoHourAccountIds: string[]
    nowIso: string
    horizonIso: string
    h2HorizonIso: string
    limit: number
  },
): Promise<DueAppointmentRow[]> {
  const { data: firstRows, error: firstError } = await db
    .from('booking_appointments')
    .select(DUE_COLUMNS)
    .in('account_id', args.accountIds)
    .in('status', ['pending', 'confirmed'])
    .is('reminder_sent_at', null)
    .gt('starts_at', args.nowIso)
    .lte('starts_at', args.horizonIso)
    .order('starts_at', { ascending: true })
    .limit(args.limit)
  if (firstError) {
    throw new Error(`no se pudieron leer las citas: ${firstError.message}`)
  }

  let secondRows: unknown[] = []
  if (args.twoHourAccountIds.length) {
    const { data, error } = await db
      .from('booking_appointments')
      .select(DUE_COLUMNS)
      .in('account_id', args.twoHourAccountIds)
      .in('status', ['pending', 'confirmed'])
      .is('reminder_2h_sent_at', null)
      .gt('starts_at', args.nowIso)
      .lte('starts_at', args.h2HorizonIso)
      .order('starts_at', { ascending: true })
      .limit(args.limit)
    if (error) {
      throw new Error(`no se pudieron leer las citas (2 h): ${error.message}`)
    }
    secondRows = data ?? []
  }

  const byId = new Map<string, DueAppointmentRow>()
  for (const row of [
    ...((firstRows ?? []) as DueAppointmentRow[]),
    ...(secondRows as DueAppointmentRow[]),
  ]) {
    byId.set(row.id, row)
  }
  return [...byId.values()].sort((a, b) =>
    a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0,
  )
}

/**
 * Una pasada del runner: busca citas activas que empiecen dentro de
 * 24 h, decide la señal vencida, reclama y envía. Pensado para
 * ejecutarse cada 10–15 min desde el cron.
 */
export async function runAgendaReminders(
  args: RunAgendaRemindersArgs,
): Promise<ReminderRunSummary> {
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()
  const horizonIso = new Date(now.getTime() + H24_MS).toISOString()
  const summary: ReminderRunSummary = {
    accounts: 0,
    due: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    byChannel: { text: 0, template: 0 },
    byKind: { h24: 0, h2: 0 },
    errors: [],
  }

  // Un fallo de lectura LANZA: devolver "0 citas" hacía que el runner
  // dejara de recordar sin que la ruta alertara (responde 500 + alerta).
  const { data: accountRows, error: accountsError } = await readAgendaAccounts(
    args.db,
  )
  if (accountsError) {
    throw new Error(`no se pudieron leer las cuentas: ${accountsError.message}`)
  }
  const accounts = (accountRows ?? []) as AccountRow[]
  summary.accounts = accounts.length
  if (!accounts.length) return summary
  const accountsById = new Map(accounts.map((a) => [a.id, a]))

  // Piezas y palabras por cuenta. Fila ausente: 2.ª señal desactivada,
  // recordatorios prendidos y palabras por defecto.
  const { data: settingsRows, error: settingsError } = await args.db
    .from('booking_settings')
    .select('account_id, reminders_2h_enabled, reminders_enabled, allow_reschedule, labels')
    .in('account_id', [...accountsById.keys()])
  if (settingsError) {
    throw new Error(
      `no se pudo leer la configuración de recordatorios: ${settingsError.message}`,
    )
  }
  const twoHourByAccount = new Map<string, boolean>()
  const labelsByAccount = new Map<string, AgendaLabels>()
  const disabledAccounts = new Set<string>()
  const noChangesAccounts = new Set<string>()
  for (const row of (settingsRows ?? []) as Record<string, unknown>[]) {
    const id = row.account_id as string
    twoHourByAccount.set(id, row.reminders_2h_enabled === true)
    labelsByAccount.set(id, readLabels(row.labels))
    if (row.reminders_enabled === false) disabledAccounts.add(id)
    if (row.allow_reschedule === false) noChangesAccounts.add(id)
  }

  const activeAccountIds = [...accountsById.keys()].filter(
    (id) => !disabledAccounts.has(id),
  )
  if (!activeAccountIds.length) return summary

  const due = await loadPendingAppointments(args.db, {
    accountIds: activeAccountIds,
    twoHourAccountIds: activeAccountIds.filter(
      (id) => twoHourByAccount.get(id) === true,
    ),
    nowIso,
    horizonIso,
    h2HorizonIso: new Date(now.getTime() + H2_MS).toISOString(),
    limit: args.limit ?? DEFAULT_LIMIT,
  })
  summary.due = due.length

  for (const appt of due) {
    const account = accountsById.get(appt.account_id)
    if (!account) {
      summary.skipped++
      continue
    }

    const startsAtMs = new Date(appt.starts_at).getTime()
    const kind = pickDueReminder({
      startsAtMs,
      nowMs: now.getTime(),
      reminderSentAtMs: appt.reminder_sent_at
        ? new Date(appt.reminder_sent_at).getTime()
        : null,
      reminder2hSentAtMs: appt.reminder_2h_sent_at
        ? new Date(appt.reminder_2h_sent_at).getTime()
        : null,
      twoHourEnabled: twoHourByAccount.get(appt.account_id) === true,
    })
    if (!kind) {
      summary.skipped++
      continue
    }

    const conversationId =
      appt.conversation_id ??
      (await findContactConversationId(args.db, appt.account_id, appt.contact_id))
    if (!conversationId) {
      summary.skipped++
      summary.errors.push(`cita ${appt.id}: sin conversación`)
      continue
    }

    const channel = (await hasRecentCustomerMessage(
      args.db,
      conversationId,
      now,
    ))
      ? 'text'
      : 'template'

    const serviceName = appt.service_id
      ? await loadServiceName(args.db, appt.account_id, appt.service_id)
      : null
    const staffName = appt.staff_id
      ? await loadStaffName(args.db, appt.account_id, appt.staff_id)
      : null
    const parts = zonedParts(new Date(startsAtMs))

    const delivery: ReminderDelivery = {
      appointmentId: appt.id,
      accountId: appt.account_id,
      contactId: appt.contact_id,
      conversationId,
      ownerUserId: account.owner_user_id,
      kind,
      channel,
      businessName: account.name,
      serviceName,
      staffName,
      startsAtIso: appt.starts_at,
      dateLabel: formatLongDate(parts.dateKey),
      timeLabel: formatTimeLabel(parts),
      labels: labelsByAccount.get(appt.account_id) ?? DEFAULT_LABELS,
      allowReschedule: !noChangesAccounts.has(appt.account_id),
    }

    const claim = await claimReminder(args.db, {
      id: appt.id,
      accountId: appt.account_id,
      kind,
      claimedAtIso: nowIso,
      previousReminderSentAt: appt.reminder_sent_at,
    })
    if (!claim) {
      // Otra corrida ganó el reclamo (o la cita cambió de estado).
      summary.skipped++
      continue
    }

    try {
      await args.send(delivery)
      summary.sent++
      summary.byChannel[channel]++
      summary.byKind[kind]++
    } catch (err) {
      summary.failed++
      summary.errors.push(
        `cita ${appt.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      await revertReminder(args.db, {
        id: appt.id,
        accountId: appt.account_id,
        kind,
        claimedAtIso: nowIso,
        previousReminderSentAt: appt.reminder_sent_at,
      })
    }
  }

  return summary
}
