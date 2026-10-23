// ============================================================
// Avisos de estado al cliente (diseño §3.5).
//
// `sendOrderNotice` es la costura que usan las rutas de /api/modules/ventas
// para avisar por WhatsApp cuando un pedido se paga, se envía o se
// entrega. Contrato (el que las rutas y la pantalla ya respetan):
//
//   - Nunca lanza: devuelve el resultado del intento.
//       'sent'    el mensaje salió (texto libre o plantilla).
//       'failed'  no salió (sin conversación, sin WhatsApp, plantilla no
//                 aprobada, error de Meta…).
//   - 'skipped' NO lo devuelve esta función: lo produce la ruta cuando
//     el interruptor de ese aviso está apagado en los ajustes (el
//     cliente no pidió aviso). La pantalla debe leer:
//         'sent'    → "Aviso enviado"
//         'skipped' → "Avisos de este tipo desactivados"
//         'failed'  → "No se pudo avisar al cliente"
//   - Un fallo de envío jamás deshace el cambio de estado del pedido.
//
// Canal (misma regla que los recordatorios de la agenda):
//   - el cliente escribió en las últimas 24 h → texto libre
//     (`buildNoticeText`) por el sender del motor de flujos, el mismo
//     que usa el bot;
//   - ventana cerrada → plantilla aprobada en Meta (`pedido_pagado`,
//     `pedido_enviado`, `pedido_entregado`, idioma `es`) con
//     `sendTemplateMessage`, guardando el saliente en `messages` como
//     hace agenda/agent/reminders-send.ts.
//
// Registro: el resultado queda en el pedido (`last_notice` = el aviso
// intentado; `last_notice_error` = null si salió, o un motivo corto en
// español si no). Esa escritura va con el cliente service-role que
// recibe la función, filtrada por `account_id`: ambas columnas son
// editables (no las congela el guarda de 054).
//
// WHATSAPP_TEMPLATES_DRY_RUN: en este código solo gobierna el ENVÍO DE
// PLANTILLAS A REVISIÓN (rutas /api/whatsapp/templates/*, la API de
// administración de Meta); ningún envío de mensajes (flujos, recordatorios
// de la agenda) lo mira. Los avisos tampoco, para comportarse igual que
// el resto de los envíos.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  MessagePersistAfterSendError,
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget, type WaSendTarget } from '@/lib/whatsapp/wa-identity'
import { hasRecentCustomerMessage } from '@/verticals/agenda/agent/reminders'

import type { NoticeKind } from './orders'
import type { OrderRow } from './repo'
import {
  buildNoticeTemplate,
  buildNoticeText,
  renderNoticeTemplateBody,
  type NoticeContext,
} from './texts'

export type NoticeOutcome = 'sent' | 'skipped' | 'failed'

/** Idioma de las tres plantillas en WhatsApp Manager. */
export const NOTICE_TEMPLATE_LANGUAGE = 'es'

/**
 * Motivos (cortos, en español) que quedan en `orders.last_notice_error`
 * y que la pantalla muestra tal cual.
 */
export const NOTICE_ERRORS = {
  noConversation: 'No hay una conversación con el cliente',
  noWhatsApp: 'El cliente no tiene WhatsApp vinculado',
  notConfigured: 'WhatsApp no está conectado en esta cuenta',
  templateNotApproved: 'Plantilla no aprobada en Meta',
  templateParams: 'Las variables no coinciden con la plantilla de Meta',
  notAllowed: 'El número del cliente no está autorizado en la cuenta de pruebas de Meta',
  undeliverable: 'WhatsApp no pudo entregar el mensaje al cliente',
  windowClosed: 'Pasaron más de 24 horas desde el último mensaje del cliente',
  generic: 'No se pudo mandar el mensaje por WhatsApp',
  whatsapp: (code: number | string) => `Error de WhatsApp: ${code}`,
} as const

/** Costuras de red, inyectables en los tests (sin Meta ni claves reales). */
export interface NoticeDeps {
  now?: () => Date
  sendText?: typeof engineSendText
  sendTemplate?: typeof sendTemplateMessage
  loadCredentials?: typeof loadAccountMetaCredentials
}

type Attempt = { ok: true } | { ok: false; reason: string }

const FAIL = (reason: string): Attempt => ({ ok: false, reason })

/** Error de Meta: se intentó un mensaje libre fuera de la ventana de 24 h. */
const META_OUTSIDE_WINDOW = 131047

/** Códigos de error de WhatsApp Cloud API → motivo legible. */
function reasonFromError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (isRecipientNotAllowedError(message) || code === 131030) return NOTICE_ERRORS.notAllowed
  if (typeof code === 'number') {
    switch (code) {
      case 132001: // la plantilla no existe en ese idioma
      case 132015: // pausada
      case 132016: // deshabilitada
        return NOTICE_ERRORS.templateNotApproved
      case 132000: // número de variables distinto
      case 132005: // texto traducido demasiado largo
      case 132007: // contenido contra la política
      case 132012: // formato de variable inválido
        return NOTICE_ERRORS.templateParams
      case 131026: // no entregable (no usa WhatsApp / no aceptó términos)
        return NOTICE_ERRORS.undeliverable
      case META_OUTSIDE_WINDOW:
        return NOTICE_ERRORS.windowClosed
      default:
        return NOTICE_ERRORS.whatsapp(code)
    }
  }
  return NOTICE_ERRORS.generic
}

interface NoticeTarget {
  conversationId: string
  contactId: string
}

/** Conversación del pedido; si no hay, la más reciente del contacto en la cuenta. */
async function resolveTarget(db: SupabaseClient, order: OrderRow): Promise<NoticeTarget | null> {
  if (order.conversation_id) {
    const { data } = await db
      .from('conversations')
      .select('id, contact_id')
      .eq('id', order.conversation_id)
      .eq('account_id', order.account_id)
      .maybeSingle()
    const row = data as { id: string; contact_id: string | null } | null
    const contactId = row?.contact_id ?? order.contact_id
    if (row && contactId) return { conversationId: row.id, contactId }
  }

  if (!order.contact_id) return null
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', order.account_id)
    .eq('contact_id', order.contact_id)
    // Las conversaciones sin mensajes (last_message_at nulo) van al final.
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
  const latest = ((data ?? []) as { id: string }[])[0]
  return latest ? { conversationId: latest.id, contactId: order.contact_id } : null
}

interface ContactRow {
  id: string
  phone: string | null
  wa_user_id: string | null
}

async function attemptNotice(
  db: SupabaseClient,
  order: OrderRow,
  kind: NoticeKind,
  deps: Required<NoticeDeps>,
): Promise<Attempt> {
  const target = await resolveTarget(db, order)
  if (!target) return FAIL(NOTICE_ERRORS.noConversation)

  const { data: contactData } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', target.contactId)
    .eq('account_id', order.account_id)
    .maybeSingle()
  const contact = contactData as ContactRow | null
  if (!contact) return FAIL(NOTICE_ERRORS.noConversation)

  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) return FAIL(NOTICE_ERRORS.noWhatsApp)

  // Credenciales una sola vez para los dos canales: si no se pueden leer
  // (cuenta sin WhatsApp conectado o token ilegible) el motivo es el mismo.
  let credentials: { phoneNumberId: string; accessToken: string }
  try {
    credentials = await deps.loadCredentials(db, order.account_id)
  } catch (err) {
    console.error(`[ventas notice] pedido ${order.number}: no se pudieron leer las credenciales`, err)
    return FAIL(NOTICE_ERRORS.notConfigured)
  }

  const { data: accountData } = await db
    .from('accounts')
    .select('name, owner_user_id')
    .eq('id', order.account_id)
    .maybeSingle()
  const account = accountData as { name: string | null; owner_user_id: string | null } | null

  const ctx: NoticeContext = {
    number: order.number,
    businessName: account?.name ?? null,
    carrier: order.carrier,
    trackingNumber: order.tracking_number,
  }

  const windowOpen = await hasRecentCustomerMessage(db, target.conversationId, deps.now())

  if (windowOpen) {
    let fallThrough = false
    try {
      await deps.sendText({
        accountId: order.account_id,
        userId: account?.owner_user_id ?? order.created_by ?? '',
        conversationId: target.conversationId,
        contactId: target.contactId,
        text: buildNoticeText(kind, ctx),
      })
    } catch (err) {
      // Meta ya lo aceptó y lo que falló fue guardarlo en `messages`:
      // el cliente lo recibió, así que cuenta como enviado.
      if (err instanceof MessagePersistAfterSendError) {
        console.error(
          `[ventas notice] pedido ${order.number}: aviso enviado (${err.whatsappMessageId}) pero no se pudo registrar en messages:`,
          err.message,
        )
      } else if ((err as { code?: unknown } | null)?.code === META_OUTSIDE_WINDOW) {
        // Mi reloj decía "ventana abierta" pero Meta ya la cerró: el mismo
        // aviso sale por plantilla, que sí vale fuera de las 24 h.
        console.warn(`[ventas notice] pedido ${order.number}: Meta cerró la ventana, se manda la plantilla`)
        fallThrough = true
      } else {
        return FAIL(reasonFromError(err))
      }
    }
    if (!fallThrough) return { ok: true }
  }

  return sendTemplateNotice(db, order, kind, ctx, target, contact, sendTarget, credentials, deps)
}

/**
 * Fuera de la ventana de 24 h: plantilla del aviso. Misma mecánica que
 * `sendReminderTemplate` de la agenda: reintento por variantes de
 * teléfono, y el saliente queda en `messages` con el texto equivalente
 * al cuerpo de la plantilla para que la bandeja muestre el contenido.
 */
async function sendTemplateNotice(
  db: SupabaseClient,
  order: OrderRow,
  kind: NoticeKind,
  ctx: NoticeContext,
  target: NoticeTarget,
  contact: ContactRow,
  sendTarget: WaSendTarget,
  credentials: { phoneNumberId: string; accessToken: string },
  deps: Required<NoticeDeps>,
): Promise<Attempt> {
  const sanitized = sendTarget.target
  const template = buildNoticeTemplate(kind, ctx)
  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const variant of variants) {
    try {
      const sent = await deps.sendTemplate({
        phoneNumberId: credentials.phoneNumberId,
        accessToken: credentials.accessToken,
        to: variant,
        templateName: template.name,
        language: NOTICE_TEMPLATE_LANGUAGE,
        params: template.params,
      })
      waMessageId = sent.messageId
      workingPhone = variant
      lastError = null
      break
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) break
    }
  }
  if (lastError) return FAIL(reasonFromError(lastError))

  // Desde aquí Meta ya lo aceptó: nada de lo que sigue puede volverlo "failed".
  try {
    if (sendTarget.isPhone && workingPhone !== sanitized) {
      await db
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id)
        .eq('account_id', order.account_id)
    }

    // Lo que el cliente recibió: el cuerpo de la plantilla con sus variables.
    const contentText = renderNoticeTemplateBody(kind, template.params)
    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: target.conversationId,
      sender_type: 'bot',
      content_type: 'template',
      content_text: contentText,
      template_name: template.name,
      message_id: waMessageId,
      status: 'sent',
    })
    if (msgErr) {
      console.error(
        `[ventas notice] pedido ${order.number}: aviso enviado (${waMessageId}) pero no se pudo registrar en messages:`,
        msgErr.message,
      )
      return { ok: true }
    }

    const nowIso = deps.now().toISOString()
    await db
      .from('conversations')
      .update({ last_message_text: contentText, last_message_at: nowIso, updated_at: nowIso })
      .eq('id', target.conversationId)
      .eq('account_id', order.account_id)
  } catch (err) {
    console.error(`[ventas notice] pedido ${order.number}: aviso enviado (${waMessageId}) pero falló el registro`, err)
  }
  return { ok: true }
}

/**
 * Guarda el resultado en el pedido (`error` null = salió bien). Nunca
 * lanza: solo registra el fallo. También la usa deliverNotice cuando ni
 * siquiera se llegó a intentar el envío.
 */
export async function recordNotice(
  db: SupabaseClient,
  order: OrderRow,
  kind: NoticeKind,
  error: string | null,
): Promise<void> {
  try {
    const { error: updateErr } = await db
      .from('orders')
      .update({ last_notice: kind, last_notice_error: error })
      .eq('id', order.id)
      .eq('account_id', order.account_id)
    if (updateErr) {
      console.error(`[ventas notice] pedido ${order.number}: no se pudo guardar el resultado del aviso`, updateErr)
    }
  } catch (err) {
    console.error(`[ventas notice] pedido ${order.number}: no se pudo guardar el resultado del aviso`, err)
  }
}

/**
 * Manda el aviso `kind` del pedido y guarda el resultado en el pedido.
 * `db` debe ser el cliente service-role. Nunca lanza.
 */
export async function sendOrderNotice(
  db: SupabaseClient,
  order: OrderRow,
  kind: NoticeKind,
  deps: NoticeDeps = {},
): Promise<NoticeOutcome> {
  const resolved: Required<NoticeDeps> = {
    now: deps.now ?? (() => new Date()),
    sendText: deps.sendText ?? engineSendText,
    sendTemplate: deps.sendTemplate ?? sendTemplateMessage,
    loadCredentials: deps.loadCredentials ?? loadAccountMetaCredentials,
  }

  let attempt: Attempt
  try {
    attempt = await attemptNotice(db, order, kind, resolved)
  } catch (err) {
    console.error(`[ventas notice] pedido ${order.number}: falló el aviso "${kind}"`, err)
    attempt = FAIL(NOTICE_ERRORS.generic)
  }

  if (!attempt.ok) {
    console.warn(`[ventas notice] pedido ${order.number}: aviso "${kind}" no enviado: ${attempt.reason}`)
  }
  await recordNotice(db, order, kind, attempt.ok ? null : attempt.reason)
  return attempt.ok ? 'sent' : 'failed'
}
