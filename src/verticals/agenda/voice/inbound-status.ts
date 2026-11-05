// ============================================================
// Fin de una llamada ENTRANTE (§6.3).
//
// Telnyx avisa que la llamada terminó a la URL fija de la app de TeXML
// (`StatusCallback`, evento `completed`): como esa URL es la misma para todas
// las llamadas, no trae el id de nuestra fila y la llamada se encuentra por su
// `CallSid` (que se guardó en el primer pedido).
//
//   1. Cierra la fila con lo de siempre (`handleStatusCallback`): estado final,
//      duración y hora; sin resultado, `no_response`.
//   2. Si quien llamó es un contacto, deja en su ficha la nota interna
//      "Llamó: {resultado}" (`contact_notes`, la que muestra la bandeja). No se
//      le manda nada al paciente.
//
// Es idempotente: solo anota al cerrar una llamada que seguía abierta, así que
// un reintento del aviso no repite la nota. La nota es un extra: si no se puede
// guardar, la llamada igual queda cerrada. Ni el nombre ni el teléfono de quien
// llamó van a logs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveAuditUserId } from '@/lib/api/v1/contacts'

import { handleStatusCallback, mapCallStatus } from './call-events'
import { IN_FLIGHT_STATUSES, loadCallRow, type CallOutcome } from './calls-repo'
import { findCallBySid } from './inbound-repo'

// ------------------------------------------------------------
// La nota
// ------------------------------------------------------------

/** Qué pasó en la llamada, dicho para leerlo después de "Llamó: ". */
const OUTCOME_NOTES: Record<CallOutcome, string> = {
  confirmed: 'confirmó su cita',
  cancelled: 'canceló su cita',
  human: 'pidió hablar con el equipo',
  no_response: 'colgó sin elegir una opción',
  wrong_number: 'número equivocado',
  booking_link_sent: 'pidió agendar y se le envió el enlace por WhatsApp',
  advisor_connected: 'habló con un asesor',
  advisor_missed: 'pidió un asesor y nadie contestó',
  out_of_hours: 'pidió un asesor fuera del horario de atención',
  info: 'pidió el horario y la dirección',
  urgency: 'urgencia, y no había a quién pasar la llamada',
}

/** El texto de la nota interna de una llamada con ese resultado. */
export function inboundCallNote(outcome: CallOutcome): string {
  return `Llamó: ${OUTCOME_NOTES[outcome]}`
}

/** Mejor esfuerzo: nunca lanza y nunca loguea nada de quien llamó. */
async function noteContact(db: SupabaseClient, args: { accountId: string; contactId: string; text: string }) {
  try {
    const userId = await resolveAuditUserId(db, args.accountId)
    const { error } = await db.from('contact_notes').insert({
      contact_id: args.contactId,
      account_id: args.accountId,
      user_id: userId,
      note_text: args.text,
    })
    if (error) console.error('[voice inbound] no se pudo dejar la nota de la llamada')
  } catch {
    console.error('[voice inbound] no se pudo dejar la nota de la llamada')
  }
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------

export interface InboundStatusArgs {
  /** Service role. */
  db: SupabaseClient
  /** `CallSid`, `CallStatus`, `CallDuration`. */
  form: Record<string, string>
  now: Date
}

export async function handleInboundStatus(args: InboundStatusArgs): Promise<void> {
  const { db, form, now } = args
  const sid = form.CallSid?.trim()
  if (!sid) return
  const call = await findCallBySid(db, sid)
  if (!call) return

  const wasOpen = IN_FLIGHT_STATUSES.includes(call.status)
  await handleStatusCallback({ db, callId: call.id, form, now })

  // Solo al cerrar una llamada que seguía abierta (un reintento no repite la nota).
  const status = mapCallStatus(form.CallStatus)
  if (!wasOpen || !status || status === 'in_progress') return

  const closed = await loadCallRow(db, call.id)
  if (!closed?.contactId || !closed.outcome) return
  await noteContact(db, {
    accountId: closed.accountId,
    contactId: closed.contactId,
    text: inboundCallNote(closed.outcome),
  })
}
