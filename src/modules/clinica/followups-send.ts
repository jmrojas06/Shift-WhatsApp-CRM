// ============================================================
// Envío real de los seguimientos — pegamento de producción.
//
// Mismo patrón que agent/reminders-send.ts: el runner (followups.ts) decide QUÉ
// enviar y llama a `sendClinicFollowup`, que aquí resuelve el CÓMO:
//   - ventana de 24 h abierta → mensaje libre (texto para los cuidados, botones
//     para "¿cómo sigues?" y la calificación) con los senders del motor de flujos;
//   - ventana cerrada → plantilla aprobada en Meta con `sendTemplateMessage`,
//     reintento por variantes de teléfono y persistencia del saliente.
//
// Regla de fase: este archivo NO toca el núcleo; solo consume sus helpers públicos.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadAccountMetaCredentials, MessagePersistAfterSendError } from '@/lib/flows/meta-send'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { createAgendaSender } from '@/verticals/agenda/agent/index'

import {
  FOLLOWUP_TEMPLATES,
  buildFollowupBody,
  buildFollowupTemplateParams,
  followupButtons,
  followupQuickReplyPayloads,
  type FollowupDelivery,
} from './followups'

/**
 * Envía el seguimiento por el canal que decidió el runner.
 *
 * Lanza SOLO si el mensaje no llegó a Meta: el runner revierte el reclamo y lo
 * reintenta en la próxima corrida. Si Meta ya lo aceptó y lo que falla es guardarlo
 * en `messages`, se registra el error y NO se lanza: revertir reenviaría un mensaje
 * que el paciente ya recibió.
 */
export async function sendClinicFollowup(delivery: FollowupDelivery): Promise<void> {
  if (delivery.channel === 'template') {
    await sendFollowupTemplate(delivery)
    return
  }

  const sender = createAgendaSender({
    accountId: delivery.accountId,
    conversationId: delivery.conversationId,
    contactId: delivery.contactId,
    configOwnerUserId: delivery.ownerUserId,
  })
  const bodyText = buildFollowupBody(delivery)
  try {
    if (delivery.kind === 'cuidados') {
      await sender.sendText({ text: bodyText })
    } else {
      await sender.sendButtons({
        bodyText,
        buttons: followupButtons(delivery.kind, delivery.followupId),
      })
    }
  } catch (err) {
    if (!(err instanceof MessagePersistAfterSendError)) throw err
    logDeliveredButNotLogged(delivery, err.whatsappMessageId, err.message)
  }
}

// El registro lleva el id del seguimiento y el mensaje de la base (solo nombra
// columnas): nunca el nombre ni el teléfono del paciente.
function logDeliveredButNotLogged(
  delivery: FollowupDelivery,
  waMessageId: string,
  reason: string,
): void {
  console.error(
    `[clinica followups] seguimiento ${delivery.followupId}: enviado (${waMessageId}) pero no se pudo registrar en messages — no se reenvía:`,
    reason,
  )
}

/**
 * Fuera de la ventana de 24 h: plantilla aprobada con dos variables (paciente y
 * negocio) y un payload por botón (`fu:<acción>:<seguimiento>` o
 * `rt:<valor>:<seguimiento>`), en el orden de los botones aprobados. Las
 * instrucciones de cuidado nunca van aquí: la plantilla solo invita a verlas.
 */
async function sendFollowupTemplate(delivery: FollowupDelivery): Promise<void> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', delivery.contactId)
    .eq('account_id', delivery.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('Seguimiento: contacto no encontrado en la cuenta')
  }

  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error('Seguimiento: el contacto no tiene número de WhatsApp')
  }
  const sanitized = sendTarget.target

  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
    db,
    delivery.accountId,
  )

  const template = FOLLOWUP_TEMPLATES[delivery.kind]
  const params = buildFollowupTemplateParams(delivery)
  const quickReplyPayloads = followupQuickReplyPayloads(delivery.kind, delivery.followupId)
  const sendTo = (phone: string) =>
    sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      templateName: template.name,
      language: template.language,
      params,
      quickReplyPayloads,
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
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persistencia del saliente: el texto equivalente al cuerpo de la plantilla, para
  // que la bandeja muestre el contenido (sin las instrucciones de cuidado).
  const contentText = buildFollowupBody({ ...delivery, aftercare: null })
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: delivery.conversationId,
    sender_type: 'bot',
    content_type: 'template',
    content_text: contentText,
    template_name: template.name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // El paciente ya lo recibió: lanzar haría que el runner revierta el reclamo y lo
    // mande otra vez en la próxima corrida.
    logDeliveredButNotLogged(delivery, waMessageId, msgErr.message)
    return
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
