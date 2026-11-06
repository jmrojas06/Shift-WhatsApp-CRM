// ============================================================
// Cuando la IA de una clínica pasa un chat a una persona.
//
// La regla fija del prompt hace que la IA no conteste nada de salud (un
// síntoma sin palabra de urgencia: "me arde la encía, ¿es normal?"): pausa el
// chat y lo pasa. Sin lo de aquí, el paciente no recibía nada, nadie recibía un
// aviso y el chat quedaba en pausa en silencio.
//
// Qué se hace: (1) un aviso en la app al agente de pase, o al dueño si no hay;
// (2) un texto fijo al paciente (nada de diagnóstico): lo revisa una persona, ya
// se le avisó, y los signos de alarma de la clínica por si empeora.
// El aviso va primero, para que "ya le avisé" sea verdad.
//
// Nunca lanza: el pase ya ocurrió. Lo que falle se registra y se avisa al equipo
// técnico con `notifyAlert`, sin el texto del paciente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from '@/lib/flows/meta-send'
import { notifyAlert } from '@/lib/ops/alert'
import {
  insertNotification,
  loadAccount,
  loadBotSettings,
  loadContact,
} from '@/verticals/agenda/agent/db'

import { loadClinicContext } from './settings'
import { buildClinicTexts, DEFAULT_URGENCY_ALARM_TEXT } from './texts'

export interface AiHandoffArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** Dueño de la configuración de WhatsApp: columnas de auditoría del envío. */
  configOwnerUserId: string
  /** Agente al que la IA pasa los chats (`ai_configs.handoff_agent_id`). */
  handoffAgentId: string | null
}

export async function announceAiHandoff(db: SupabaseClient, args: AiHandoffArgs): Promise<void> {
  const failed: string[] = []
  try {
    const [settings, account, contact, clinic] = await Promise.all([
      loadBotSettings(db, args.accountId),
      loadAccount(db, args.accountId).catch(() => null),
      loadContact(db, args.accountId, args.contactId).catch(() => null),
      loadClinicContext(db, args.accountId).catch(() => null),
    ])
    const texts = buildClinicTexts(settings.labels)
    const alarmText = clinic?.status === 'ok' ? clinic.clinic.urgencyAlarmText : DEFAULT_URGENCY_ALARM_TEXT

    // 1) El aviso en la app: al agente de pase, o al dueño.
    const userId = args.handoffAgentId ?? account?.ownerUserId ?? null
    if (!userId) {
      failed.push('avisar al equipo en la app: no hay a quién')
    } else {
      try {
        await insertNotification(db, {
          accountId: args.accountId,
          userId,
          conversationId: args.conversationId,
          contactId: args.contactId,
          title: texts.aiHandoffNotificationTitle,
          body: texts.aiHandoffNotificationBody(contact?.name?.trim() || contact?.phone || 'Un paciente'),
        })
      } catch (err) {
        console.error('[clinica] no se pudo crear el aviso del pase de la IA:', err)
        failed.push('crear el aviso en la app')
      }
    }

    // 2) El texto al paciente. Sale aunque el aviso haya fallado: lo peor es el silencio.
    try {
      await engineSendText({
        accountId: args.accountId,
        userId: args.configOwnerUserId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: texts.aiHandoffNotice(alarmText),
      })
    } catch (err) {
      console.error('[clinica] no se pudo escribirle al paciente tras el pase de la IA:', err)
      failed.push('escribirle al paciente')
    }
  } catch (err) {
    console.error('[clinica] el pase de la IA falló:', err)
    failed.push('avisar del pase de la IA')
  }

  if (failed.length) {
    await notifyAlert(
      `Clínica: la IA pasó un chat a una persona y no se pudo ${[...new Set(failed)].join(', ')} ` +
        `(cuenta ${args.accountId}, conversación ${args.conversationId}). Revisa ese chat.`,
    ).catch(() => undefined)
  }
}
