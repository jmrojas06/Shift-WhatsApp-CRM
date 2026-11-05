// ============================================================
// Avisos al paciente por WhatsApp (T5).
//
// Dos usos, un mismo envío:
//   - `notifyPatient`: la recepción agenda, mueve o cancela una cita desde el
//     panel y se le avisa al paciente (lo llama `panel-notify`).
//   - `sendBookingLink`: el robot de llamadas le manda al paciente un botón
//     "Agendar" por WhatsApp (opción 1 del menú entrante).
//
// Canal, por regla y no por criterio:
//   - el paciente escribió en las últimas 24 h → mensaje libre (sin costo
//     dentro de los 1.000 del mes);
//   - si no → plantilla aprobada en Meta (ver `notify-texts.ts`).
// Los avisos de cancelación y el enlace llevan un botón `book:again` que el
// bot lee como "Agendar" (ver `BOOK_AGAIN_ID`).
//
// Contrato: NUNCA lanza. Un fallo vuelve como `{ sent: false, error }` y el
// texto del error lo muestra la pantalla tal cual, así que no lleva datos del
// paciente (ni nombre ni teléfono): son frases fijas o, a lo sumo, el código
// de error de Meta. Una clínica nunca nombra el procedimiento.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAccountMetaCredentials, MessagePersistAfterSendError } from '@/lib/flows/meta-send'
import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { loadClinicReminderInfo, type ClinicReminderInfo } from '@/modules/clinica/reminder-info'
import { buildClinicTexts } from '@/modules/clinica/texts'

import { createAgendaSender } from './agent/index'
import { findContactConversationId, loadBotSettings, loadServiceName, loadStaffName } from './agent/db'
import { formatLongDate, formatTimeLabel } from './agent/format'
import { hasRecentCustomerMessage, reminderServiceLabel, reminderStaffLabel } from './agent/reminders'
import { zonedParts } from './agent/time'
import type { AgendaLabels } from './labels'
import {
  NOTIFY_TEMPLATES,
  NOTIFY_TEXTS,
  renderMovedText,
  renderNotifyTemplate,
  type NotifyTemplate,
  type NotifyTemplateName,
} from './notify-texts'
import { buildAgentTexts } from './texts'

export type NotifyPatientKind = 'booked' | 'moved' | 'cancelled'

export interface NotifyPatientArgs {
  /** Service role: el envío escribe en `messages` y lee la conexión de WhatsApp. */
  db: SupabaseClient
  accountId: string
  appointmentId: string
  kind: NotifyPatientKind
  now: Date
}

export interface BookingLinkArgs {
  db: SupabaseClient
  accountId: string
  contactId: string
  conversationId: string
  now: Date
}

export type NotifyPatientResult =
  | { sent: true; channel: 'text' | 'template' }
  | { sent: false; error: string }

/** El envío de WhatsApp, inyectable para las pruebas (por defecto, el real). */
export interface NotifyPatientDeps {
  createSender: typeof createAgendaSender
  loadCredentials: typeof loadAccountMetaCredentials
  sendTemplate: typeof sendTemplateMessage
}

const DEFAULT_DEPS: NotifyPatientDeps = {
  createSender: createAgendaSender,
  loadCredentials: loadAccountMetaCredentials,
  sendTemplate: sendTemplateMessage,
}

// ------------------------------------------------------------
// Errores
// ------------------------------------------------------------

/** Un motivo conocido, con un texto que se puede mostrar tal cual. */
class NotifyFailure extends Error {}

/**
 * Del error de Meta (o de lo que sea) a una frase para el panel. Nunca se
 * muestra el mensaje crudo: podría traer el número o el nombre del paciente.
 */
function describeError(err: unknown, template: string | null): string {
  if (err instanceof NotifyFailure) return err.message
  const raw = err instanceof Error ? err.message : String(err)
  if (template && /132001|does not exist/i.test(raw)) return NOTIFY_TEXTS.templateMissing(template)
  if (template && /132000|132005|132012|localizable_params/i.test(raw)) {
    return NOTIFY_TEXTS.templateMismatch(template)
  }
  if (/131030|not in (the )?allowed list/i.test(raw)) return NOTIFY_TEXTS.notAllowed
  if (/131026|undeliverable/i.test(raw)) return NOTIFY_TEXTS.undeliverable
  if (/131047|re-engagement/i.test(raw)) return NOTIFY_TEXTS.windowClosed
  const code = /\(#(\d{3,7})\)/.exec(raw)?.[1]
  return code ? NOTIFY_TEXTS.failedWithCode(code) : NOTIFY_TEXTS.failed
}

function fail(err: unknown, context: string): NotifyPatientResult {
  const error = describeError(err, null)
  // Sin el mensaje de la excepción: podría traer datos del paciente.
  console.error(`[agenda notify] ${context}: ${error}`)
  return { sent: false, error }
}

// ------------------------------------------------------------
// Lecturas
// ------------------------------------------------------------

/** Una sola línea y sin espacios de más: Meta rechaza una variable con saltos de línea. */
const oneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim()

interface AccountFacts {
  name: string
  ownerUserId: string | null
  clinic: boolean
  labels: AgendaLabels
}

async function loadAccountFacts(db: SupabaseClient, accountId: string): Promise<AccountFacts> {
  const { data, error } = await db
    .from('accounts')
    .select('name, owner_user_id')
    .eq('id', accountId)
    .maybeSingle()
  if (error) throw new NotifyFailure(NOTIFY_TEXTS.unreadable)
  if (!data) throw new NotifyFailure(NOTIFY_TEXTS.accountMissing)
  const modules = await readAccountModules(db, accountId)
  if (modules.error) throw new NotifyFailure(NOTIFY_TEXTS.unreadable)
  const row = data as { name?: string | null; owner_user_id?: string | null }
  return {
    name: oneLine(row.name ?? ''),
    ownerUserId: row.owner_user_id ?? null,
    clinic: hasModule(modules.account, 'clinica'),
    labels: (await loadBotSettings(db, accountId)).labels,
  }
}

interface AppointmentFacts {
  contactId: string
  conversationId: string | null
  serviceId: string | null
  staffId: string | null
  startsAt: Date
}

async function loadAppointmentFacts(
  db: SupabaseClient,
  accountId: string,
  appointmentId: string,
): Promise<AppointmentFacts> {
  const { data, error } = await db
    .from('booking_appointments')
    .select('id, contact_id, conversation_id, service_id, staff_id, starts_at')
    .eq('id', appointmentId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new NotifyFailure(NOTIFY_TEXTS.unreadable)
  if (!data) throw new NotifyFailure(NOTIFY_TEXTS.appointmentMissing)
  const row = data as Record<string, unknown>
  return {
    contactId: row.contact_id as string,
    conversationId: (row.conversation_id as string | null) ?? null,
    serviceId: (row.service_id as string | null) ?? null,
    staffId: (row.staff_id as string | null) ?? null,
    startsAt: new Date(row.starts_at as string),
  }
}

// ------------------------------------------------------------
// El mensaje
// ------------------------------------------------------------

interface Outgoing {
  template: NotifyTemplate
  /** Valores de las variables de la plantilla, en su orden. */
  params: string[]
  /** Mensaje libre (ventana abierta). */
  text: string
  /** Lo que queda en `messages` cuando sale la plantilla: su cuerpo con los valores. */
  templateText: string
}

function outgoing(args: {
  name: NotifyTemplateName
  params: string[]
  labels: AgendaLabels
  /** Texto libre propio, si no es el cuerpo de la plantilla. */
  text?: string
}): Outgoing {
  const params = args.params.map(oneLine)
  const templateText = renderNotifyTemplate(args.name, params, args.labels)
  return {
    template: NOTIFY_TEMPLATES[args.name],
    params,
    text: args.text ?? templateText,
    templateText,
  }
}

function buildAppointmentMessage(args: {
  kind: NotifyPatientKind
  business: string
  labels: AgendaLabels
  startsAt: Date
  serviceName: string | null
  staffName: string | null
  clinic: ClinicReminderInfo | null
}): Outgoing {
  const { kind, business, labels, clinic } = args
  const parts = zonedParts(args.startsAt)
  const date = formatLongDate(parts.dateKey)
  const time = formatTimeLabel(parts)

  if (clinic) {
    if (kind === 'cancelled') {
      return outgoing({
        name: 'cita_cancelada_clinica',
        params: [clinic.patientName, business, date, time],
        labels,
      })
    }
    const params = [
      clinic.patientName,
      business,
      clinic.locationName,
      args.staffName ?? buildClinicTexts(labels).reminderStaffFallback,
      date,
      time,
    ]
    return outgoing({
      name: 'cita_agendada_clinica',
      params,
      labels,
      ...(kind === 'moved' ? { text: renderMovedText(true, params.map(oneLine), labels) } : {}),
    })
  }

  if (kind === 'cancelled') {
    return outgoing({ name: 'cita_cancelada', params: [business, date, time], labels })
  }
  const texts = buildAgentTexts(labels)
  const params = [
    business,
    reminderServiceLabel(args.serviceName, texts),
    reminderStaffLabel(args.staffName, texts),
    date,
    time,
  ]
  return outgoing({
    name: 'cita_agendada',
    params,
    labels,
    ...(kind === 'moved' ? { text: renderMovedText(false, params.map(oneLine), labels) } : {}),
  })
}

// ------------------------------------------------------------
// Envío
// ------------------------------------------------------------

interface DeliveryContext {
  db: SupabaseClient
  accountId: string
  ownerUserId: string | null
  contactId: string
  conversationId: string
  now: Date
  deps: NotifyPatientDeps
}

/**
 * Ventana abierta → mensaje libre; cerrada → plantilla. Lanza `NotifyFailure`
 * con un motivo conocido, o el error del envío; quien llama lo convierte.
 */
async function deliver(
  ctx: DeliveryContext,
  message: Outgoing,
): Promise<{ channel: 'text' | 'template' }> {
  const { db, accountId } = ctx

  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', ctx.contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactError) throw new NotifyFailure(NOTIFY_TEXTS.unreadable)
  if (!contact) throw new NotifyFailure(NOTIFY_TEXTS.contactMissing)
  // Antes de enviar: el error del envío sin destino repite el número.
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) throw new NotifyFailure(NOTIFY_TEXTS.noWhatsApp)

  // La conversación tiene que ser de la cuenta: el mensaje se guarda ahí.
  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', ctx.conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (conversationError) throw new NotifyFailure(NOTIFY_TEXTS.unreadable)
  if (!conversation) throw new NotifyFailure(NOTIFY_TEXTS.noConversation)

  if (await hasRecentCustomerMessage(db, ctx.conversationId, ctx.now)) {
    await sendFreeText(ctx, message)
    return { channel: 'text' }
  }

  try {
    await sendAsTemplate(ctx, message, sendTarget)
  } catch (err) {
    // El error de Meta sabe de qué plantilla se trata: se explica aquí.
    throw err instanceof NotifyFailure
      ? err
      : new NotifyFailure(describeError(err, message.template.name))
  }
  return { channel: 'template' }
}

async function sendFreeText(ctx: DeliveryContext, message: Outgoing): Promise<void> {
  if (!ctx.ownerUserId) throw new NotifyFailure(NOTIFY_TEXTS.accountMissing)
  const sender = ctx.deps.createSender({
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    configOwnerUserId: ctx.ownerUserId,
  })
  try {
    if (message.template.button) {
      await sender.sendButtons({ bodyText: message.text, buttons: [message.template.button] })
    } else {
      await sender.sendText({ text: message.text })
    }
  } catch (err) {
    // Meta ya lo aceptó y solo falló guardarlo en `messages`: el paciente lo
    // recibió, así que no se cuenta como fallo (un reintento lo duplicaría).
    if (!(err instanceof MessagePersistAfterSendError)) throw err
    console.error('[agenda notify] aviso enviado pero no se pudo registrar en messages')
  }
}

/**
 * Plantilla aprobada, con las variantes de teléfono que usa el resto del CRM y
 * el texto equivalente guardado en la conversación (como los recordatorios).
 */
async function sendAsTemplate(
  ctx: DeliveryContext,
  message: Outgoing,
  sendTarget: { target: string; isPhone: boolean },
): Promise<void> {
  const { db, accountId } = ctx

  let credentials: { phoneNumberId: string; accessToken: string }
  try {
    credentials = await ctx.deps.loadCredentials(db, accountId)
  } catch {
    throw new NotifyFailure(NOTIFY_TEXTS.connection)
  }

  const quickReplyPayloads = message.template.button ? [message.template.button.id] : undefined
  const sendTo = (phone: string) =>
    ctx.deps.sendTemplate({
      phoneNumberId: credentials.phoneNumberId,
      accessToken: credentials.accessToken,
      to: phone,
      templateName: message.template.name,
      language: message.template.language,
      params: message.params,
      // Sin la clave para las plantillas sin botón: su envío no cambia ni un byte.
      ...(quickReplyPayloads ? { quickReplyPayloads } : {}),
    })

  const sanitized = sendTarget.target
  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      waMessageId = (await sendTo(variant)).messageId
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', ctx.contactId).eq('account_id', accountId)
  }

  const { error: insertError } = await db.from('messages').insert({
    conversation_id: ctx.conversationId,
    sender_type: 'bot',
    content_type: 'template',
    content_text: message.templateText,
    template_name: message.template.name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (insertError) {
    // Ya salió: lanzar haría creer que no llegó.
    console.error('[agenda notify] plantilla enviada pero no se pudo registrar en messages')
    return
  }

  const nowIso = ctx.now.toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: message.templateText, last_message_at: nowIso, updated_at: nowIso })
    .eq('id', ctx.conversationId)
    .eq('account_id', accountId)
}

// ------------------------------------------------------------
// Entradas
// ------------------------------------------------------------

/**
 * Avisa al paciente que su cita se agendó, se movió o se canceló. Lee la cita,
 * la cuenta y, en una clínica, el paciente y la sede (nunca el procedimiento).
 * Nunca lanza.
 */
export async function notifyPatient(
  args: NotifyPatientArgs,
  deps: Partial<NotifyPatientDeps> = {},
): Promise<NotifyPatientResult> {
  const context = `cita ${args.appointmentId}`
  try {
    const { db, accountId } = args
    const account = await loadAccountFacts(db, accountId)
    const appointment = await loadAppointmentFacts(db, accountId, args.appointmentId)

    const conversationId =
      appointment.conversationId ??
      (await findContactConversationId(db, accountId, appointment.contactId))
    if (!conversationId) throw new NotifyFailure(NOTIFY_TEXTS.noConversation)

    // El procedimiento de una clínica ni siquiera se lee: así no hay por dónde se cuele.
    let clinic: ClinicReminderInfo | null = null
    if (account.clinic) {
      try {
        clinic = await loadClinicReminderInfo(db, {
          accountId,
          appointmentId: args.appointmentId,
          contactId: appointment.contactId,
        })
      } catch {
        // El error de lectura repite lo que la base dijo de la fila: no se muestra.
        throw new NotifyFailure(NOTIFY_TEXTS.unreadable)
      }
    }
    const [serviceName, staffName] = await Promise.all([
      !account.clinic && appointment.serviceId
        ? loadServiceName(db, accountId, appointment.serviceId)
        : null,
      appointment.staffId ? loadStaffName(db, accountId, appointment.staffId) : null,
    ])

    const message = buildAppointmentMessage({
      kind: args.kind,
      business: account.name,
      labels: account.labels,
      startsAt: appointment.startsAt,
      serviceName,
      staffName,
      clinic,
    })

    const { channel } = await deliver(
      {
        db,
        accountId,
        ownerUserId: account.ownerUserId,
        contactId: appointment.contactId,
        conversationId,
        now: args.now,
        deps: { ...DEFAULT_DEPS, ...deps },
      },
      message,
    )
    return { sent: true, channel }
  } catch (err) {
    return fail(err, context)
  }
}

/**
 * Le manda al paciente el botón "Agendar" por WhatsApp (el robot de llamadas,
 * opción 1 del menú entrante). Ventana abierta → texto con el botón; cerrada →
 * plantilla `agendar_por_llamada`. El contacto y la conversación ya existen
 * (los crea quien llama). Nunca lanza.
 */
export async function sendBookingLink(
  args: BookingLinkArgs,
  deps: Partial<NotifyPatientDeps> = {},
): Promise<NotifyPatientResult> {
  try {
    const { db, accountId } = args
    const account = await loadAccountFacts(db, accountId)
    const message = outgoing({
      name: 'agendar_por_llamada',
      params: [account.name],
      labels: account.labels,
    })
    const { channel } = await deliver(
      {
        db,
        accountId,
        ownerUserId: account.ownerUserId,
        contactId: args.contactId,
        conversationId: args.conversationId,
        now: args.now,
        deps: { ...DEFAULT_DEPS, ...deps },
      },
      message,
    )
    return { sent: true, channel }
  } catch (err) {
    return fail(err, 'enlace para agendar')
  }
}
