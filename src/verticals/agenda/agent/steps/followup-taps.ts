// ============================================================
// Respuestas del bot a los botones de los seguimientos de después de la cita
// (§7.4 del diseño de las Fases 2 y 3). Solo clínicas.
//
//   fu:cuidados:<id>   manda las instrucciones de cuidado del servicio de esa visita
//   fu:bien:<id>       "¡Qué bueno!" y guarda la respuesta
//   fu:molestias:<id>  guarda la respuesta, avisa al equipo con prioridad y el hilo
//   fu:ayuda:<id>      pasa a una persona (el mismo pase de "Hablar con una persona"),
//                      con los signos de alarma de la clínica
//   rt:<valor>:<id>    guarda la calificación UNA vez por seguimiento, agradece a todos
//                      (con el enlace de Google si la sede lo tiene) y, si fue Regular
//                      o Mal, avisa al dueño para que alguien llame
//
// Son la respuesta a un mensaje del sistema: el controlador las atiende antes del
// candado y del hilo de una persona, como los toques `rem:*`. Este archivo no toca
// la sesión: devuelve un resultado y el controlador aplica el pase.
//
// El id del seguimiento amarra el toque a una visita. Si no es de la cuenta y del
// contacto que escribe, ni del tipo que dice el botón, se IGNORA en silencio: ni
// respuesta ni escritura. Un botón viejo o ajeno no le dice nada a nadie.
//
// Un paciente es un dato personal: su nombre no va a los logs ni a las alertas.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { notifyAlert } from '@/lib/ops/alert'
import type { FollowupKind, FollowupResponse, RatingValue } from '@/modules/clinica/followups'
import type { ClinicTexts } from '@/modules/clinica/texts'

import type { AgendaSender } from '../controller'
import {
  hasRecentNotification,
  insertNotification,
  loadAccount,
  loadContact,
  loadConversationAssignee,
} from '../db'
import type { FollowupTap } from '../state'
import type { ClinicHandoff } from './clinic-steps'

export interface FollowupTapCtx {
  db: SupabaseClient
  sender: AgendaSender
  clinicTexts: ClinicTexts
  accountId: string
  contactId: string
  conversationId: string
  now: Date
  nowIso: string
  /** Una persona lleva el hilo (agente asignado o bot en pausa). */
  humanOwned: boolean
  /** Los signos de alarma de la clínica; sin su configuración, los de siempre. */
  alarmText: string
}

/**
 * `done`: el paso ya respondió (o ignoró el toque). `handoff`: falta pasar el hilo a
 * una persona, que lo hace el controlador con su camino de siempre.
 */
export type FollowupTapOutcome = { kind: 'done' } | ClinicHandoff

/** Cada cuánto se repite el aviso de molestias de un mismo hilo que lleva una persona. */
const TROUBLE_NOTICE_EVERY_MINUTES = 10

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** De menos a más grave: la respuesta guardada nunca baja. */
const RESPONSE_RANK: Readonly<Record<FollowupResponse, number>> = { bien: 0, molestias: 1, ayuda: 2 }

const isResponse = (value: unknown): value is FollowupResponse =>
  typeof value === 'string' && Object.hasOwn(RESPONSE_RANK, value)

/** Solo una dirección web: "pendiente" o "N/A" no son un enlace que se le mande a un paciente. */
const isWebUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value)

interface OwnFollowup {
  id: string
  appointment_id: string
  kind: FollowupKind
  response: FollowupResponse | null
}

export async function handleFollowupTap(
  ctx: FollowupTapCtx,
  tap: FollowupTap,
): Promise<FollowupTapOutcome> {
  const followup = await loadOwnFollowup(ctx, tap)
  if (!followup) return { kind: 'done' }

  if (tap.type === 'rt') {
    await answerRating(ctx, followup, tap.value)
    return { kind: 'done' }
  }

  switch (tap.action) {
    case 'cuidados':
      await ctx.sender.sendText({ text: await careReply(ctx, followup) })
      return { kind: 'done' }
    case 'bien':
      await saveResponse(ctx, followup, 'bien')
      await ctx.sender.sendText({ text: ctx.clinicTexts.followupWellReply })
      return { kind: 'done' }
    case 'molestias':
    case 'ayuda':
      return answerTrouble(ctx, followup, tap.action)
  }
}

// ------------------------------------------------------------
// Verificar que el seguimiento es de este paciente
// ------------------------------------------------------------

/** El tipo de seguimiento al que pertenece cada botón. */
function expectedKind(tap: FollowupTap): FollowupKind {
  if (tap.type === 'rt') return 'calificacion'
  return tap.action === 'cuidados' ? 'cuidados' : 'como_sigues'
}

/**
 * El seguimiento, solo si es de esta cuenta y de este contacto y del tipo que dice
 * el botón; si no, null (se ignora). Un id que no es un uuid ni se consulta: la base
 * lo rechazaría con un error, que no es lo mismo que "no es suyo". Una lectura que
 * falla LANZA por la misma razón: callar un "necesito ayuda" no es una opción.
 */
async function loadOwnFollowup(ctx: FollowupTapCtx, tap: FollowupTap): Promise<OwnFollowup | null> {
  if (!UUID.test(tap.followupId)) return null
  const { data, error } = await ctx.db
    .from('clinic_followups')
    .select('id, appointment_id, kind, response')
    .eq('id', tap.followupId)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer el seguimiento: ${error.message}`)
  if (!data) return null
  const row = data as Record<string, unknown>
  if (row.kind !== expectedKind(tap)) return null
  return {
    id: row.id as string,
    appointment_id: row.appointment_id as string,
    kind: row.kind as FollowupKind,
    response: isResponse(row.response) ? row.response : null,
  }
}

/** El servicio y la sede de la visita del seguimiento. Lanza si la lectura falla. */
async function loadVisit(
  ctx: FollowupTapCtx,
  appointmentId: string,
): Promise<{ serviceId: string | null; locationId: string | null } | null> {
  const { data, error } = await ctx.db
    .from('booking_appointments')
    .select('service_id, location_id')
    .eq('id', appointmentId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la visita: ${error.message}`)
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    serviceId: (row.service_id as string | null) ?? null,
    locationId: (row.location_id as string | null) ?? null,
  }
}

// ------------------------------------------------------------
// fu:cuidados
// ------------------------------------------------------------

async function careReply(ctx: FollowupTapCtx, followup: OwnFollowup): Promise<string> {
  const visit = await loadVisit(ctx, followup.appointment_id)
  const instructions = visit?.serviceId ? await loadAftercare(ctx, visit.serviceId) : null
  return instructions
    ? ctx.clinicTexts.followupCareReply(instructions)
    : ctx.clinicTexts.followupCareNone
}

/** Las instrucciones tal como están hoy en el servicio (pudieron cambiar desde el envío). */
async function loadAftercare(ctx: FollowupTapCtx, serviceId: string): Promise<string | null> {
  const { data, error } = await ctx.db
    .from('booking_services')
    .select('aftercare_instructions')
    .eq('id', serviceId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudieron leer los cuidados del servicio: ${error.message}`)
  const text = (data as { aftercare_instructions?: string | null } | null)?.aftercare_instructions
  return text?.trim() ? text : null
}

// ------------------------------------------------------------
// fu:bien / fu:molestias / fu:ayuda
// ------------------------------------------------------------

/**
 * Guarda la respuesta de "¿cómo sigues?". Solo sube: "molestias" no se vuelve "bien"
 * porque el paciente toque otro botón, y la calificación se omite a quien tuvo
 * molestias. Es auxiliar: si no se puede guardar, el paciente y el equipo se enteran
 * igual, así que el fallo se registra y no detiene nada.
 */
async function saveResponse(
  ctx: FollowupTapCtx,
  followup: OwnFollowup,
  response: FollowupResponse,
): Promise<void> {
  if (followup.response !== null && RESPONSE_RANK[followup.response] >= RESPONSE_RANK[response]) return
  try {
    const { error } = await ctx.db
      .from('clinic_followups')
      .update({ response, responded_at: ctx.nowIso })
      .eq('id', followup.id)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error('[clinica] no se pudo guardar la respuesta del seguimiento:', err)
  }
}

/**
 * Molestias o ayuda: el equipo tiene que enterarse ya. El paciente recibe que se
 * avisó y los signos de alarma de la clínica (nada de diagnóstico).
 *
 * Con el bot a cargo, es el pase de siempre (el controlador lo aplica: pausa el
 * bot, etiqueta, avisa con prioridad al dueño y al agente de pase). Si una persona
 * ya lleva el hilo, NO se le quita: se avisa a quien lo lleva y al dueño, y se
 * contesta al paciente.
 */
async function answerTrouble(
  ctx: FollowupTapCtx,
  followup: OwnFollowup,
  response: 'molestias' | 'ayuda',
): Promise<FollowupTapOutcome> {
  await saveResponse(ctx, followup, response)
  const { clinicTexts: texts } = ctx
  const message = texts.followupTroubleReply(ctx.alarmText)

  if (!ctx.humanOwned) {
    return {
      kind: 'handoff',
      message,
      note: texts.followupTroubleNote,
      notification: {
        title: texts.followupTroubleNotificationTitle,
        body: texts.followupTroubleNotificationBody,
      },
    }
  }

  await warnTeamInHumanThread(ctx)
  await ctx.sender.sendText({ text: message })
  return { kind: 'done' }
}

/**
 * Aviso prioritario en un hilo que lleva una persona: a ella y al dueño. Un solo
 * aviso por conversación cada 10 minutos (quien insiste recibe su respuesta, pero no
 * llena la bandeja). Si no se pudo avisar a nadie, se alerta al equipo técnico, sin
 * datos del paciente, y el paciente recibe su respuesta igual.
 */
async function warnTeamInHumanThread(ctx: FollowupTapCtx): Promise<void> {
  let problem: string | null = null
  try {
    const [account, assignee] = await Promise.all([
      loadAccount(ctx.db, ctx.accountId).catch(() => null),
      loadConversationAssignee(ctx.db, ctx.accountId, ctx.conversationId).catch(() => null),
    ])
    const recipients = new Set<string>()
    if (account?.ownerUserId) recipients.add(account.ownerUserId)
    if (assignee) recipients.add(assignee)

    if (recipients.size === 0) {
      problem = 'avisar al equipo en la app: no hay a quién'
    } else if (
      !(await hasRecentNotification(ctx.db, {
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        title: ctx.clinicTexts.followupTroubleNotificationTitle,
        sinceIso: new Date(ctx.now.getTime() - TROUBLE_NOTICE_EVERY_MINUTES * 60_000).toISOString(),
      }))
    ) {
      const who = await contactLabel(ctx)
      for (const userId of recipients) {
        try {
          await insertNotification(ctx.db, {
            accountId: ctx.accountId,
            userId,
            conversationId: ctx.conversationId,
            contactId: ctx.contactId,
            title: ctx.clinicTexts.followupTroubleNotificationTitle,
            body: ctx.clinicTexts.followupTroubleNotificationBody(who),
            // La hora del bot: así el siguiente aviso de este chat ve este.
            createdAtIso: ctx.nowIso,
          })
        } catch (err) {
          console.error('[clinica] el aviso de molestias al equipo falló:', err)
          problem = 'avisar al equipo en la app'
        }
      }
    }
  } catch (err) {
    console.error('[clinica] el aviso de molestias al equipo falló:', err)
    problem = 'avisar al equipo en la app'
  }

  if (problem) {
    await notifyAlert(
      `Seguimiento: no se pudo ${problem} (cuenta ${ctx.accountId}, conversación ${ctx.conversationId}). ` +
        'Un paciente dijo que tiene molestias; revisa ese chat ya.',
    ).catch(() => undefined)
  }
}

// ------------------------------------------------------------
// rt:<valor>
// ------------------------------------------------------------

/**
 * Guarda la calificación una sola vez por seguimiento (la base lo impone con un
 * único por `followup_id`: tocar de nuevo no repite ni cambia la primera) y le
 * agradece a todos. Si no se pudo guardar, LANZA: no se agradece ni se avisa lo que
 * no quedó, y el paciente puede tocar de nuevo.
 */
async function answerRating(
  ctx: FollowupTapCtx,
  followup: OwnFollowup,
  value: RatingValue,
): Promise<void> {
  const visit = await loadVisit(ctx, followup.appointment_id)
  const { data, error } = await ctx.db
    .from('clinic_ratings')
    .upsert(
      {
        id: crypto.randomUUID(),
        account_id: ctx.accountId,
        appointment_id: followup.appointment_id,
        contact_id: ctx.contactId,
        location_id: visit?.locationId ?? null,
        value,
        followup_id: followup.id,
        created_at: ctx.nowIso,
      },
      { onConflict: 'followup_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) throw new Error(`No se pudo guardar la calificación: ${error.message}`)
  // Con `ignoreDuplicates` la base devuelve solo lo que insertó: vacío = ya había una.
  const stored = ((data ?? []) as unknown[]).length > 0

  if (stored) {
    await markResponded(ctx, followup.id)
    if (value === 'regular' || value === 'mal') await warnOwnerOfLowRating(ctx, value)
  }

  const reviewUrl = await loadReviewUrl(ctx, visit?.locationId ?? null)
  await ctx.sender.sendText({ text: ctx.clinicTexts.followupRatingThanks(reviewUrl) })
}

async function markResponded(ctx: FollowupTapCtx, followupId: string): Promise<void> {
  try {
    const { error } = await ctx.db
      .from('clinic_followups')
      .update({ responded_at: ctx.nowIso })
      .eq('id', followupId)
      .eq('account_id', ctx.accountId)
    if (error) throw new Error(error.message)
  } catch (err) {
    console.error('[clinica] no se pudo marcar el seguimiento como respondido:', err)
  }
}

/**
 * Regular o Mal: el dueño recibe el aviso para que alguien llame. Es auxiliar: si
 * falla, la calificación ya quedó guardada y el paciente recibe su agradecimiento.
 */
async function warnOwnerOfLowRating(ctx: FollowupTapCtx, value: 'regular' | 'mal'): Promise<void> {
  try {
    const account = await loadAccount(ctx.db, ctx.accountId)
    if (!account?.ownerUserId) {
      console.error('[clinica] no hay a quién avisar de una calificación baja')
      return
    }
    await insertNotification(ctx.db, {
      accountId: ctx.accountId,
      userId: account.ownerUserId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      title: ctx.clinicTexts.followupLowRatingNotificationTitle(value),
      body: ctx.clinicTexts.followupLowRatingNotificationBody(await contactLabel(ctx), value),
      createdAtIso: ctx.nowIso,
    })
  } catch (err) {
    console.error('[clinica] el aviso de una calificación baja falló:', err)
  }
}

/**
 * El enlace de Google de la sede de la visita. Una visita sin sede usa la sede activa
 * de la clínica; una sede sin enlace no pide prestado el de otra. Si no se puede leer,
 * se agradece sin enlace: la calificación ya quedó guardada.
 */
async function loadReviewUrl(ctx: FollowupTapCtx, locationId: string | null): Promise<string | null> {
  const query = ctx.db
    .from('clinic_locations')
    .select('google_review_url')
    .eq('account_id', ctx.accountId)
  const { data, error } = locationId
    ? await query.eq('id', locationId).limit(1)
    : await query.eq('is_active', true).order('created_at').limit(1)
  if (error) {
    console.error('[clinica] no se pudo leer el enlace de Google de la sede:', error.message)
    return null
  }
  const url = ((data ?? []) as { google_review_url?: string | null }[])[0]?.google_review_url?.trim()
  return url && isWebUrl(url) ? url : null
}

// ------------------------------------------------------------

/** Cómo se nombra al paciente en un aviso a la app: su nombre, o su número. */
async function contactLabel(ctx: FollowupTapCtx): Promise<string> {
  const contact = await loadContact(ctx.db, ctx.accountId, ctx.contactId).catch(() => null)
  return contact?.name?.trim() || contact?.phone || 'Un paciente'
}
