// ============================================================
// Handler del vertical agenda — pegamento de producción.
//
// Une el controlador (controller.ts, lógica y copy) con:
//   - el envío real por WhatsApp (engineSend* de flows/meta-send,
//     los mismos senders que usan flujos y automatizaciones: el
//     mensaje queda persistido como saliente del bot), y
//   - el contrato del dispatcher (VerticalInboundHandler).
//
// Este archivo es la única parte del vertical que toca el runtime
// de mensajería; el controlador recibe un `AgendaSender` inyectado
// y por eso es testeable sin red ni Meta.
// ============================================================

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendText,
} from '@/lib/flows/meta-send'
import { notifyAlert } from '@/lib/ops/alert'
import type {
  VerticalInboundContext,
  VerticalInboundHandler,
} from '@/lib/verticals/types'

import { handleAgendaInbound, type AgendaSender } from './controller'

/** Sender real: cada método delega en el sender del motor de flujos. */
export function createAgendaSender(
  ctx: Pick<
    VerticalInboundContext,
    'accountId' | 'conversationId' | 'contactId' | 'configOwnerUserId'
  >,
): AgendaSender {
  const base = {
    accountId: ctx.accountId,
    userId: ctx.configOwnerUserId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
  } as const

  return {
    sendText: async ({ text }) => {
      await engineSendText({ ...base, text })
    },
    sendButtons: async ({ bodyText, buttons, headerText, footerText }) => {
      await engineSendInteractiveButtons({
        ...base,
        bodyText,
        buttons,
        headerText,
        footerText,
      })
    },
    sendList: async ({
      bodyText,
      buttonLabel,
      sections,
      headerText,
      footerText,
    }) => {
      await engineSendInteractiveList({
        ...base,
        bodyText,
        buttonLabel,
        sections,
        headerText,
        footerText,
      })
    },
  }
}

/** Cuánto del error cabe en la alerta: sirve para ubicarlo, no para volcar datos. */
const ALERT_ERROR_MAX = 300

/**
 * Punto de entrada del seam: el webhook ya validó la firma, guardó
 * el mensaje entrante y resolvió cuenta/contacto/conversación. Aquí
 * solo se construye el sender y se delega en el controlador.
 *
 * Si el controlador lanza, el dispatcher lo registra y devuelve
 * `consumed: false`, y entonces la IA ve el mensaje. Con el módulo clínica
 * eso no puede pasar: sería la conversación de un paciente, quizá sin su
 * autorización. Por eso, solo en esas cuentas, el error se registra, se avisa
 * al equipo técnico y el mensaje se da por consumido. Las demás cuentas
 * siguen igual: el error sube.
 */
export const agendaInboundHandler: VerticalInboundHandler = async (ctx) => {
  try {
    return await handleAgendaInbound({
      db: ctx.db,
      sender: createAgendaSender(ctx),
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      inboundMessageId: ctx.inboundMessageId,
      session: ctx.session,
      humanOwned: ctx.humanOwned ?? false,
      modules: ctx.modules,
    })
  } catch (err) {
    if (ctx.modules?.includes('clinica') !== true) throw err
    console.error('[clinica] el bot falló con un mensaje; no se pasa a la IA:', err)
    const reason = err instanceof Error ? err.message : String(err)
    await notifyAlert(
      `Clínica: el bot falló con un mensaje y no se lo pasó a la IA (cuenta ${ctx.accountId}, conversación ${ctx.conversationId}). ` +
        `El paciente puede haberse quedado sin respuesta; hay que revisar el chat. Error: ${reason.slice(0, ALERT_ERROR_MAX)}`,
    )
    return { consumed: true }
  }
}
