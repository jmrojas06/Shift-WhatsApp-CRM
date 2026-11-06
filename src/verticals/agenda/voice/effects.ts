// ============================================================
// Efectos de la llamada de confirmación (§6.2): lo que cambia en la base por
// la tecla que marcó el paciente.
//
// Cada efecto se aplica UNA sola vez por llamada. La llamada misma es la llave:
// primero se reclama su resultado (`claimOutcome`, un UPDATE condicional sobre
// `outcome IS NULL`) y solo quien lo reclama cambia la cita y avisa. Un
// reintento del webhook pierde el reclamo y no repite nada. Si el cambio falla,
// el reclamo se suelta y la llamada cae al equipo (`human`, con el error anotado
// y un aviso en la app) en vez de prometerle al paciente algo que no pasó.
//
// Lo lento (avisar por WhatsApp, copiar a Google Calendar) NO se hace aquí:
// vuelve como tareas en `deferred` para que la ruta las corra con `after()`,
// después de responderle a Telnyx. El paciente no espera en silencio.
//
// Nada de lo que se loguea lleva nombre ni teléfono del paciente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  cancelAppointment,
  findContactConversationId,
  insertNotification,
  loadAccount,
  loadContact,
  loadHandoffAgentId,
  markAppointmentConfirmed,
} from '../agent/db'
import { formatLongDate, formatTimeLabel } from '../agent/format'
import { zonedParts } from '../agent/time'
import type { NotifyPatientArgs, NotifyPatientResult } from '../notify-patient'
import { CALL_NOTICES } from './call-notices'
import {
  claimOutcome,
  releaseOutcome,
  truncateError,
  updateCall,
  type CallAppointment,
  type CallRow,
} from './calls-repo'
import type { OutboundEffect } from './outbound-flow'

/** Motivo con el que queda la cita cancelada por teléfono. */
export const PATIENT_CALL_CANCEL_REASON = 'patient_call'

export interface EffectDeps {
  /** Avisa al paciente por WhatsApp (`notifyPatient`); nunca debería lanzar. */
  notifyPatient: (args: NotifyPatientArgs) => Promise<NotifyPatientResult>
  /** Avisa a la copia de Google Calendar (`kickCalendarSync`). */
  kickCalendar: (accountId: string) => Promise<void>
}

export interface EffectContext {
  /** Service role. */
  db: SupabaseClient
  now: Date
  call: CallRow
  /** La cita de la llamada, ya leída y activa; null en la llamada de prueba. */
  appointment: CallAppointment | null
  deps: EffectDeps
}

export interface EffectResult {
  /** El cambio no se pudo guardar: la llamada cayó al equipo. */
  failed: boolean
  /** Tareas para después de responder. */
  deferred: (() => Promise<void>)[]
}

const OK: EffectResult = { failed: false, deferred: [] }

const errorText = (err: unknown): string => (err instanceof Error ? err.message : 'error desconocido')

// ------------------------------------------------------------
// Avisos al equipo
// ------------------------------------------------------------

export interface TeamNoticeArgs {
  accountId: string
  contactId: string | null
  title: string
  body: string
}

/**
 * Deja un aviso en la app: al agente al que la IA pasa los chats o, si no hay,
 * al dueño. Con el contacto, lo amarra a su conversación más reciente. NUNCA
 * lanza: el aviso es un extra y la llamada ya tiene su resultado.
 */
export async function notifyCallTeam(db: SupabaseClient, args: TeamNoticeArgs): Promise<void> {
  try {
    const handoff = await loadHandoffAgentId(db, args.accountId)
    const userId = handoff ?? (await loadAccount(db, args.accountId))?.ownerUserId ?? null
    if (!userId) {
      console.error('[voice] no hay a quién avisar en la app')
      return
    }
    const conversationId = args.contactId
      ? await findContactConversationId(db, args.accountId, args.contactId)
      : null
    await insertNotification(db, {
      accountId: args.accountId,
      userId,
      conversationId,
      contactId: args.contactId,
      title: args.title,
      body: args.body,
    })
  } catch (err) {
    console.error('[voice] no se pudo crear el aviso para el equipo:', errorText(err))
  }
}

/** Quién es, para el texto de un aviso en la app: el nombre, si no el número, si no "un paciente". */
export async function describeCaller(
  db: SupabaseClient,
  args: { accountId: string; contactId: string | null; fallbackNumber?: string | null },
): Promise<string> {
  if (args.contactId) {
    try {
      const contact = await loadContact(db, args.accountId, args.contactId)
      const label = contact?.name?.trim() || contact?.phone?.trim()
      if (label) return label
    } catch {
      // Sin el contacto, el aviso sale con lo que haya.
    }
  }
  return args.fallbackNumber?.trim() || CALL_NOTICES.someone
}

/** "jueves 5 de noviembre de 2026 a las 3:30 p. m." — para texto escrito, no para la voz. */
export function writtenWhen(startsAt: Date): string {
  const parts = zonedParts(startsAt)
  return `${formatLongDate(parts.dateKey)} a las ${formatTimeLabel(parts)}`
}

// ------------------------------------------------------------
// Efectos
// ------------------------------------------------------------

async function confirm(ctx: EffectContext): Promise<EffectResult> {
  const { db, call, appointment, now } = ctx
  if (!(await claimOutcome(db, call.id, 'confirmed'))) return OK
  if (!appointment) return OK // llamada de prueba
  try {
    await markAppointmentConfirmed(db, {
      accountId: call.accountId,
      id: appointment.id,
      confirmedAtIso: now.toISOString(),
    })
  } catch (err) {
    await releaseOutcome(db, call.id, 'confirmed')
    throw err
  }
  return OK
}

async function cancel(ctx: EffectContext): Promise<EffectResult> {
  const { db, call, appointment, now, deps } = ctx
  if (!(await claimOutcome(db, call.id, 'cancelled'))) return OK
  if (!appointment) return OK // llamada de prueba
  try {
    await cancelAppointment(db, {
      accountId: call.accountId,
      id: appointment.id,
      reason: PATIENT_CALL_CANCEL_REASON,
      cancelledAtIso: now.toISOString(),
    })
  } catch (err) {
    await releaseOutcome(db, call.id, 'cancelled')
    throw err
  }

  const noteError = async (reason: string): Promise<void> => {
    try {
      await updateCall(db, call.id, { error: truncateError(CALL_NOTICES.patientNotNotified(reason)) })
    } catch {
      // Es un extra para la recepción; la cita ya está cancelada.
    }
  }

  return {
    failed: false,
    deferred: [
      async () => {
        try {
          const result = await deps.notifyPatient({
            db,
            accountId: call.accountId,
            appointmentId: appointment.id,
            kind: 'cancelled',
            now,
          })
          if (!result.sent) {
            console.error('[voice] no se pudo avisar al paciente de la cancelación')
            await noteError(result.error)
          }
        } catch {
          // Sin el mensaje de la excepción: podría traer datos del paciente.
          console.error('[voice] el aviso al paciente de la cancelación lanzó una excepción')
          await noteError('error inesperado')
        }
      },
      async () => {
        try {
          await deps.kickCalendar(call.accountId)
        } catch {
          console.error('[voice] no se pudo avisar a Google Calendar')
        }
      },
    ],
  }
}

async function human(ctx: EffectContext): Promise<EffectResult> {
  const { db, call, appointment } = ctx
  if (!(await claimOutcome(db, call.id, 'human'))) return OK
  if (!appointment) return OK // llamada de prueba: no se avisa a nadie
  const who = await describeCaller(db, { accountId: call.accountId, contactId: call.contactId })
  await notifyCallTeam(db, {
    accountId: call.accountId,
    contactId: call.contactId,
    title: CALL_NOTICES.humanTitle,
    body: CALL_NOTICES.human(who, writtenWhen(appointment.startsAt)),
  })
  return OK
}

async function noResponse(ctx: EffectContext): Promise<EffectResult> {
  await claimOutcome(ctx.db, ctx.call.id, 'no_response')
  return OK
}

/** El cambio falló: la llamada cae al equipo para que alguien llame (mejor esfuerzo). */
async function fallToTeam(ctx: EffectContext): Promise<void> {
  const { db, call, appointment } = ctx
  try {
    const won = await claimOutcome(db, call.id, 'human', { extra: { error: CALL_NOTICES.effectFailed } })
    if (!won || !appointment) return
    const who = await describeCaller(db, { accountId: call.accountId, contactId: call.contactId })
    await notifyCallTeam(db, {
      accountId: call.accountId,
      contactId: call.contactId,
      title: CALL_NOTICES.failedTitle,
      body: CALL_NOTICES.failed(who, writtenWhen(appointment.startsAt)),
    })
  } catch (err) {
    console.error('[voice] tampoco se pudo dejar la llamada para el equipo:', errorText(err))
  }
}

/**
 * Aplica el efecto de la tecla. Nunca lanza: un fallo vuelve como
 * `failed: true` y la llamada queda para el equipo.
 */
export async function applyOutboundEffect(effect: OutboundEffect, ctx: EffectContext): Promise<EffectResult> {
  try {
    switch (effect.type) {
      case 'confirm':
        return await confirm(ctx)
      case 'cancel':
        return await cancel(ctx)
      case 'human':
        return await human(ctx)
      case 'no_response':
        return await noResponse(ctx)
      case 'dial':
        // El resultado lo pone `dial-result` cuando termina la llamada pasada.
        return OK
    }
  } catch (err) {
    console.error(`[voice] no se pudo aplicar "${effect.type}":`, errorText(err))
    await fallToTeam(ctx)
    return { failed: true, deferred: [] }
  }
}
