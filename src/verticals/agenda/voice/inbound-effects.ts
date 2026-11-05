// ============================================================
// Efectos de la llamada entrante (§6.3): lo que cambia en la base (o sale por
// WhatsApp) por la tecla que marcó quien llama.
//
// Igual que en la llamada de confirmación (`effects.ts`), cada efecto se aplica
// UNA sola vez por llamada. La llamada misma es la llave: primero se reclama su
// resultado (`claimOutcome`, un UPDATE condicional) y solo quien lo reclama
// cambia la cita, manda el WhatsApp o avisa. Un reintento del webhook pierde el
// reclamo y no repite nada. Si el cambio falla, el reclamo se suelta y la
// llamada cae al equipo (`human`) en vez de prometerle a quien llama algo que no
// pasó.
//
// La diferencia con la saliente: el menú entrante tiene resultados "de paso"
// (`REPLACEABLE_OUTCOMES`: leyó el horario, pidió un asesor fuera de horario) y
// quien llama puede seguir después. Por eso el reclamo parte también de ellos:
// leer el horario y luego confirmar la cita deja `confirmed`, no `info`.
//
// Lo lento (avisar por WhatsApp, copiar a Google) NO se hace aquí: vuelve como
// tareas en `deferred` para correrlas con `after()`. Lo que decide qué se dice
// (el WhatsApp del enlace) sí es síncrono.
//
// Nada de lo que se loguea lleva nombre ni teléfono.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { cancelAppointment, markAppointmentConfirmed } from '../agent/db'
import type { BookingLinkArgs, NotifyPatientResult } from '../notify-patient'
import { CALL_NOTICES } from './call-notices'
import {
  claimOutcome,
  releaseOutcome,
  REPLACEABLE_OUTCOMES,
  truncateError,
  updateCall,
  type CallAppointment,
  type CallOutcome,
  type CallRow,
} from './calls-repo'
import { describeCaller, notifyCallTeam, PATIENT_CALL_CANCEL_REASON, writtenWhen, type EffectDeps } from './effects'
import type { InboundEffect } from './inbound-flow'

export interface InboundDeps extends EffectDeps {
  /** Manda el botón "Agendar" por WhatsApp (`sendBookingLink`); nunca lanza. */
  sendBookingLink: (args: BookingLinkArgs) => Promise<NotifyPatientResult>
  /** El contacto de ese número (lo crea si no existe, con el número como nombre) y su conversación. */
  ensureCaller: (
    db: SupabaseClient,
    args: { accountId: string; phone: string },
  ) => Promise<{ contactId: string; conversationId: string }>
  /** El contacto que ya existe con ese número, o null (nunca crea). */
  findContact: (db: SupabaseClient, accountId: string, phone: string) => Promise<{ id: string } | null>
}

export interface InboundEffectContext {
  /** Service role. */
  db: SupabaseClient
  now: Date
  call: CallRow
  /** La cita de los pasos confirmar y cancelar, ya leída y activa. */
  appointment: CallAppointment | null
  deps: InboundDeps
}

export interface InboundEffectResult {
  /** El cambio no se pudo hacer: la llamada cayó al equipo (o el envío falló). */
  failed: boolean
  /** Tareas para después de responder. */
  deferred: (() => Promise<void>)[]
}

const OK: InboundEffectResult = { failed: false, deferred: [] }
const FAILED: InboundEffectResult = { failed: true, deferred: [] }

/** Desde dónde se puede reclamar un resultado: ninguno, o uno "de paso". */
const CLAIM_FROM: readonly (CallOutcome | null)[] = [null, ...REPLACEABLE_OUTCOMES]

const claim = (ctx: InboundEffectContext, outcome: CallOutcome, extra?: Record<string, unknown>): Promise<boolean> =>
  claimOutcome(ctx.db, ctx.call.id, outcome, { from: CLAIM_FROM, ...(extra ? { extra } : {}) })

const errorText = (err: unknown): string => (err instanceof Error ? err.message : 'error desconocido')

/** Quién llama, para el texto de un aviso en la app: el nombre, si no el número. */
const callerLabel = (ctx: InboundEffectContext): Promise<string> =>
  describeCaller(ctx.db, {
    accountId: ctx.call.accountId,
    contactId: ctx.call.contactId,
    fallbackNumber: ctx.call.fromNumber,
  })

// ------------------------------------------------------------
// Agendar por WhatsApp
// ------------------------------------------------------------

async function sendLink(ctx: InboundEffectContext): Promise<InboundEffectResult> {
  const { db, call, now, deps } = ctx
  if (!call.fromNumber) {
    // Llamada privada: no hay a quién escribirle.
    await updateCall(db, call.id, { error: truncateError(CALL_NOTICES.bookingLinkNoNumber) })
    return FAILED
  }
  if (!(await claim(ctx, 'booking_link_sent'))) return OK // un reintento: ya salió

  const fail = async (reason: string): Promise<InboundEffectResult> => {
    await releaseOutcome(db, call.id, 'booking_link_sent')
    try {
      await updateCall(db, call.id, { error: truncateError(CALL_NOTICES.bookingLinkNotSent(reason)) })
    } catch {
      // Es una nota para la recepción; la respuesta a quien llama no depende de ella.
    }
    return FAILED
  }

  let target: { contactId: string; conversationId: string }
  try {
    target = await deps.ensureCaller(db, { accountId: call.accountId, phone: call.fromNumber })
  } catch {
    // Sin el mensaje de la excepción: podría traer el número.
    console.error('[voice inbound] no se pudo preparar el contacto de quien llamó')
    return fail('no se pudo preparar el contacto.')
  }

  if (target.contactId !== call.contactId) {
    try {
      await updateCall(db, call.id, { contact_id: target.contactId })
    } catch {
      // La fila queda sin contacto; el WhatsApp sale igual.
    }
  }

  const result = await deps.sendBookingLink({
    db,
    accountId: call.accountId,
    contactId: target.contactId,
    conversationId: target.conversationId,
    now,
  })
  if (!result.sent) {
    console.error('[voice inbound] no se pudo mandar el enlace para agendar')
    return fail(result.error)
  }
  return OK
}

// ------------------------------------------------------------
// Confirmar o cancelar la cita de quien llama
// ------------------------------------------------------------

/** La cita tiene que ser la que se leyó y de quien llama; si no, algo no cuadra. */
function ownAppointment(ctx: InboundEffectContext, appointmentId: string): CallAppointment {
  const { appointment, call } = ctx
  if (!appointment || appointment.id !== appointmentId) throw new Error('la cita no es la que se leyó')
  if (!call.contactId || appointment.contactId !== call.contactId) throw new Error('la cita no es de quien llama')
  return appointment
}

async function confirm(ctx: InboundEffectContext, appointmentId: string): Promise<InboundEffectResult> {
  const { db, call, now } = ctx
  const appointment = ownAppointment(ctx, appointmentId)
  if (!(await claim(ctx, 'confirmed'))) return OK
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

async function cancel(ctx: InboundEffectContext, appointmentId: string): Promise<InboundEffectResult> {
  const { db, call, now, deps } = ctx
  const appointment = ownAppointment(ctx, appointmentId)
  if (!(await claim(ctx, 'cancelled'))) return OK
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
            console.error('[voice inbound] no se pudo avisar al paciente de la cancelación')
            await noteError(result.error)
          }
        } catch {
          // Sin el mensaje de la excepción: podría traer datos del paciente.
          console.error('[voice inbound] el aviso al paciente de la cancelación lanzó una excepción')
          await noteError('error inesperado')
        }
      },
      async () => {
        try {
          await deps.kickCalendar(call.accountId)
        } catch {
          console.error('[voice inbound] no se pudo avisar a Google Calendar')
        }
      },
    ],
  }
}

/** El cambio falló: la llamada cae al equipo para que alguien llame (mejor esfuerzo). */
async function fallToTeam(ctx: InboundEffectContext): Promise<void> {
  const { db, call, appointment } = ctx
  try {
    const won = await claim(ctx, 'human', { error: CALL_NOTICES.effectFailed })
    if (!won) return
    await notifyCallTeam(db, {
      accountId: call.accountId,
      contactId: call.contactId,
      title: CALL_NOTICES.failedTitle,
      body: CALL_NOTICES.inboundFailed(await callerLabel(ctx), appointment ? writtenWhen(appointment.startsAt) : null),
    })
  } catch (err) {
    console.error('[voice inbound] tampoco se pudo dejar la llamada para el equipo:', errorText(err))
  }
}

// ------------------------------------------------------------
// Avisos al equipo
// ------------------------------------------------------------

async function urgencyUnattended(ctx: InboundEffectContext): Promise<InboundEffectResult> {
  if (!(await claim(ctx, 'urgency'))) return OK
  await notifyCallTeam(ctx.db, {
    accountId: ctx.call.accountId,
    contactId: ctx.call.contactId,
    title: CALL_NOTICES.urgencyTitle,
    body: CALL_NOTICES.urgency(await callerLabel(ctx)),
  })
  return OK
}

async function advisorUnavailable(ctx: InboundEffectContext): Promise<InboundEffectResult> {
  if (!(await claim(ctx, 'advisor_missed'))) return OK
  await notifyCallTeam(ctx.db, {
    accountId: ctx.call.accountId,
    contactId: ctx.call.contactId,
    title: CALL_NOTICES.advisorMissedTitle,
    body: CALL_NOTICES.advisorMissed(await callerLabel(ctx)),
  })
  return OK
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------

/**
 * Aplica el efecto de la tecla. Nunca lanza: un fallo vuelve como
 * `failed: true`. Si el que falló es un cambio en la cita, la llamada queda para
 * el equipo.
 */
export async function applyInboundEffect(effect: InboundEffect, ctx: InboundEffectContext): Promise<InboundEffectResult> {
  try {
    switch (effect.type) {
      case 'send_link':
        return await sendLink(ctx)
      case 'confirm':
        return await confirm(ctx, effect.appointmentId)
      case 'cancel':
        return await cancel(ctx, effect.appointmentId)
      case 'urgency_unattended':
        return await urgencyUnattended(ctx)
      case 'advisor_unavailable':
        return await advisorUnavailable(ctx)
      case 'info':
        await claim(ctx, 'info')
        return OK
      case 'out_of_hours':
        await claim(ctx, 'out_of_hours')
        return OK
      case 'no_response':
        // Solo si no hay ningún resultado: nunca pisa uno que ya dice algo.
        await claimOutcome(ctx.db, ctx.call.id, 'no_response')
        return OK
      case 'dial':
        // El resultado lo pone `dial-result` cuando termina la llamada pasada.
        return OK
    }
  } catch (err) {
    console.error(`[voice inbound] no se pudo aplicar "${effect.type}":`, errorText(err))
    if (effect.type === 'confirm' || effect.type === 'cancel') await fallToTeam(ctx)
    return FAILED
  }
}
