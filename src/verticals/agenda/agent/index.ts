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
  VerticalDispatchResult,
  VerticalInboundContext,
  VerticalInboundHandler,
} from '@/lib/verticals/types'
import { consentRevocation } from '@/modules/clinica/revocation'
import { loadClinicContext } from '@/modules/clinica/settings'
import { DEFAULT_URGENCY_WORDS } from '@/modules/clinica/texts'

import { withBotLock } from './bot-lock'
import { handleAgendaInbound, type AgendaSender } from './controller'
import { loadActiveSession, loadHumanOwned, loadInboundMessage } from './db'
import { actId, detectsUrgency, parseReminderTap } from './state'

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
 * El error de la base puede repetir la fila que no pudo guardar, con el
 * teléfono o el identificador de WhatsApp del paciente. La alerta sale a un
 * canal de operaciones: se quitan los números largos, con o sin separadores.
 */
function scrubDigits(text: string): string {
  return text.replace(/\+?\d(?:[\s().-]?\d){5,}/g, '#').replace(/\d{4,}/g, '#')
}

/**
 * Si el controlador lanza, el dispatcher lo registra y devuelve
 * `consumed: false`, y entonces la IA ve el mensaje. Con el módulo clínica
 * eso no puede pasar: sería la conversación de un paciente, quizá sin su
 * autorización. Por eso, solo en esas cuentas, el error se registra, se avisa
 * al equipo técnico y el mensaje se da por consumido. Las demás cuentas
 * siguen igual: el error sube.
 */
async function failClosed(
  ctx: VerticalInboundContext,
  err: unknown,
): Promise<VerticalDispatchResult> {
  if (ctx.modules?.includes('clinica') !== true) throw err
  console.error('[clinica] el bot falló con un mensaje; no se pasa a la IA:', err)
  const reason = err instanceof Error ? err.message : String(err)
  await notifyAlert(
    `Clínica: el bot falló con un mensaje y no se lo pasó a la IA (cuenta ${ctx.accountId}, conversación ${ctx.conversationId}). ` +
      `El paciente puede haberse quedado sin respuesta; hay que revisar el chat. Error: ${scrubDigits(reason).slice(0, ALERT_ERROR_MAX)}`,
  )
  return { consumed: true }
}

/**
 * ¿Este mensaje no puede esperar ni perderse aunque el candado esté ocupado?
 *   - Una urgencia: el toque de "Tengo una urgencia" o "Sí, tengo alguno", o un
 *     texto con una palabra de la clínica o del piso fijo (`detectsUrgency`). Si
 *     la configuración no se puede leer valen las palabras de siempre: un fallo
 *     de lectura nunca esconde una urgencia.
 *   - "No acepto", o revocar escribiendo ("ya no autorizo el uso de mis datos"):
 *     retirar la autorización es una decisión de la persona y queda en un
 *     registro; no puede descartarse.
 *   - El toque de un recordatorio (`rem:*`): es la respuesta a un mensaje que mandó
 *     el sistema, con la hora de una cita de por medio.
 * Un mensaje que no se encuentra no cuenta; uno que no se puede leer lanza.
 */
async function mustNotBeDropped(ctx: VerticalInboundContext): Promise<boolean> {
  if (!ctx.inboundMessageId) return false
  const inbound = await loadInboundMessage(ctx.db, ctx.conversationId, ctx.inboundMessageId, {
    strict: true,
  })
  if (!inbound) return false
  if (inbound.replyId !== null) {
    return (
      inbound.replyId === actId('urgent') ||
      inbound.replyId === actId('alarm_yes') ||
      inbound.replyId === actId('consent_no') ||
      parseReminderTap(inbound.replyId) !== null
    )
  }
  if (consentRevocation(inbound.text)) return true
  const clinic = await loadClinicContext(ctx.db, ctx.accountId).catch(() => null)
  const words = clinic?.status === 'ok' ? clinic.clinic.urgencyWords : DEFAULT_URGENCY_WORDS
  return detectsUrgency(inbound.text, words)
}

/**
 * Punto de entrada del seam: el webhook ya validó la firma, guardó
 * el mensaje entrante y resolvió cuenta/contacto/conversación. Aquí
 * solo se construye el sender y se delega en el controlador. Todo lo que
 * pueda lanzar va dentro del `try` (ver `failClosed`), también el candado.
 *
 * Con el módulo clínica, el mensaje se atiende con el candado de la
 * conversación (ver `withBotLock`), y lo que pudo cambiar mientras se esperaba
 * se lee de nuevo: la sesión y quién lleva el hilo. Si el candado no se
 * consigue, el mensaje se consume sin responder y se avisa al equipo técnico,
 * salvo una urgencia, un "No acepto" o el toque de un recordatorio, que se
 * procesan igual. Las demás cuentas siguen igual que siempre.
 */
export const agendaInboundHandler: VerticalInboundHandler = async (ctx) => {
  const run = (session: VerticalInboundContext['session'], humanOwned: boolean) =>
    handleAgendaInbound({
      db: ctx.db,
      sender: createAgendaSender(ctx),
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      inboundMessageId: ctx.inboundMessageId,
      session,
      humanOwned,
      modules: ctx.modules,
    })

  try {
    if (ctx.modules?.includes('clinica') !== true) return await run(ctx.session, ctx.humanOwned ?? false)
    return await withBotLock(
      ctx.db,
      { accountId: ctx.accountId, conversationId: ctx.conversationId },
      async () => {
        // La sesión y el dueño del hilo que trajo el dispatcher pudieron quedar
        // viejos mientras se esperaba: el mensaje de antes pudo cerrar la sesión o
        // pasar el hilo a una persona. Si el dispatcher ya lo veía de una persona,
        // se respeta.
        const [session, humanNow] = await Promise.all([
          loadActiveSession(ctx.db, {
            accountId: ctx.accountId,
            contactId: ctx.contactId,
            nowIso: new Date().toISOString(),
          }),
          loadHumanOwned(ctx.db, ctx.accountId, ctx.conversationId).catch(() => false),
        ])
        const result = await run(session, (ctx.humanOwned ?? false) || humanNow)
        // El dispatcher trajo una sesión que ya no existe (otro mensaje la cerró mientras
        // este esperaba). Si el mensaje no se consumió, hay que decir que se soltó: si no,
        // el dispatcher lo reclamaría por la sesión vieja y nadie lo contestaría.
        return !result.consumed && ctx.session && !session ? { ...result, released: true } : result
      },
      {
        runWithoutLockWhen: () => mustNotBeDropped(ctx),
        // Cualquier otro mensaje que se descarta: que alguien mire ese chat. Sin el
        // texto del paciente, solo dónde mirar.
        onDropped: () =>
          notifyAlert(
            `Clínica: un mensaje de un paciente se descartó porque la conversación estaba ocupada y no se lo pasó a la IA (cuenta ${ctx.accountId}, conversación ${ctx.conversationId}). ` +
              'El paciente puede haberse quedado sin respuesta; hay que revisar el chat.',
          ),
      },
    )
  } catch (err) {
    return failClosed(ctx, err)
  }
}
