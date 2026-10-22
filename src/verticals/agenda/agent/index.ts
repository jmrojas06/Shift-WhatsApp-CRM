// ============================================================
// Handler del vertical barbería — pegamento de producción.
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

/**
 * Punto de entrada del seam: el webhook ya validó la firma, guardó
 * el mensaje entrante y resolvió cuenta/contacto/conversación. Aquí
 * solo se construye el sender y se delega en el controlador.
 */
export const agendaInboundHandler: VerticalInboundHandler = (ctx) =>
  handleAgendaInbound({
    db: ctx.db,
    sender: createAgendaSender(ctx),
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    configOwnerUserId: ctx.configOwnerUserId,
    inboundMessageId: ctx.inboundMessageId,
    session: ctx.session,
    humanOwned: ctx.humanOwned ?? false,
  })
