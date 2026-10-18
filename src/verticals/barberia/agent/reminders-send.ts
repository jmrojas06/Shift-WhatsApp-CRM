// ============================================================
// Envío real de recordatorios — pegamento de producción.
//
// Mismo patrón que agent/index.ts: el runner (reminders.ts) decide
// QUÉ enviar y llama a `sendBarberiaReminder`, que aquí resuelve el
// CÓMO:
//   - mensaje libre con botones (ventana 24 h abierta) → los
//     senders del motor de flujos, igual que el controlador;
//   - plantilla aprobada en Meta (ventana cerrada) → sendTemplateMessage
//     + persistencia del saliente, calcando automations/meta-send.ts
//     (variantes de teléfono incluidas).
//
// Regla de fase: este archivo NO toca el núcleo — vive en el
// vertical y solo consume sus helpers públicos.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadAccountMetaCredentials } from '@/lib/flows/meta-send'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import {
  isRecipientNotAllowedError,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'

import { createBarberiaSender } from './index'
import {
  BARBERIA_REMINDER_TEMPLATE,
  buildReminderBody,
  buildReminderTemplateParams,
  reminderButtons,
  type ReminderDelivery,
} from './reminders'

/**
 * Envía el recordatorio por el canal que decidió el runner.
 * Lanza si el envío no llegó a Meta: el runner revierte la marca y
 * lo reintenta en la próxima corrida.
 */
export async function sendBarberiaReminder(
  delivery: ReminderDelivery,
): Promise<void> {
  if (delivery.channel === 'text') {
    const sender = createBarberiaSender({
      accountId: delivery.accountId,
      conversationId: delivery.conversationId,
      contactId: delivery.contactId,
      configOwnerUserId: delivery.ownerUserId,
    })
    await sender.sendButtons({
      bodyText: buildReminderBody(delivery),
      buttons: reminderButtons(),
    })
    return
  }

  await sendReminderTemplate(delivery)
}

/**
 * Fuera de la ventana de 24 h: plantilla `recordatorio_cita` con las
 * cinco variables documentadas (negocio, servicio, barbero, fecha,
 * hora) y los quick replies Confirmar / Reprogramar / Cancelar que
 * aprobó Meta. El payload de esos quick replies es estático
 * (`rem:*`), por eso la cita se resuelve en el controlador.
 */
async function sendReminderTemplate(delivery: ReminderDelivery): Promise<void> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', delivery.contactId)
    .eq('account_id', delivery.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('Recordatorio: contacto no encontrado en la cuenta')
  }

  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error('Recordatorio: el contacto no tiene número de WhatsApp')
  }
  const sanitized = sendTarget.target

  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
    db,
    delivery.accountId,
  )

  const params = buildReminderTemplateParams(delivery)
  const sendTo = (phone: string) =>
    sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      templateName: BARBERIA_REMINDER_TEMPLATE.name,
      language: BARBERIA_REMINDER_TEMPLATE.language,
      params,
    })

  // Mismo reintento por variantes de teléfono que el resto del CRM.
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
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id)
  }

  // Persistencia del saliente: se guarda el texto equivalente al
  // cuerpo de la plantilla para que la bandeja muestre el contenido.
  const contentText = buildReminderBody(delivery)
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: delivery.conversationId,
    sender_type: 'bot',
    content_type: 'template',
    content_text: contentText,
    template_name: BARBERIA_REMINDER_TEMPLATE.name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`Recordatorio: no se pudo registrar el mensaje (${msgErr.message})`)
  }

  const nowIso = new Date().toISOString()
  await db
    .from('conversations')
    .update({
      last_message_text: contentText,
      last_message_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', delivery.conversationId)
    .eq('account_id', delivery.accountId)
}
