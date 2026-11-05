// ============================================================
// Lo que Telnyx avisa de una llamada DESPUÉS de las instrucciones. Los dos
// avisos sirven a las llamadas salientes (T13) y a las entrantes (T14):
//
//   - `handleDialResult`: terminó el `<Dial>` a los asesores. Si alguien
//     contestó, el resultado es `advisor_connected`; si no, `advisor_missed`, se
//     le dice al paciente y sale un aviso en la app para que el equipo lo llame.
//   - `handleStatusCallback`: terminó la llamada. Guarda el estado final, la
//     duración y la hora; si no quedó ningún resultado, queda `no_response`.
//
// Los dos son idempotentes (escrituras condicionales): un reintento de Telnyx
// no repite avisos ni revive una llamada cerrada. Ni el nombre ni el teléfono
// del paciente van a logs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { say, hangup, response } from '@/lib/voice/texml'

import { CALL_NOTICES } from './call-notices'
import {
  claimOutcome,
  IN_FLIGHT_STATUSES,
  loadCallRow,
  REPLACEABLE_OUTCOMES,
  type CallStatus,
} from './calls-repo'
import { describeCaller, notifyCallTeam } from './effects'
import { hangupOnlyXml } from './outbound-flow'
import { advisorMissed } from './scripts'
import { loadCallSettings, resolveVoice } from './settings'

// ------------------------------------------------------------
// Estado final de la llamada
// ------------------------------------------------------------

/**
 * `CallStatus` de Telnyx → nuestro `status`. null = un aviso que no usamos
 * (ringing, initiated, queued): no cambia nada.
 */
export function mapCallStatus(raw: string | null | undefined): CallStatus | null {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'completed':
      return 'completed'
    case 'busy':
      return 'busy'
    case 'no-answer':
      return 'no_answer'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'in-progress':
      return 'in_progress'
    default:
      return null
  }
}

const MAX_DURATION_SECONDS = 86_400

function readDuration(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.min(parsed, MAX_DURATION_SECONDS)
}

export interface StatusCallbackArgs {
  /** Service role. */
  db: SupabaseClient
  callId: string
  /** `CallSid`, `CallStatus`, `CallDuration`. */
  form: Record<string, string>
  now: Date
}

export async function handleStatusCallback(args: StatusCallbackArgs): Promise<void> {
  const { db, form, now } = args
  const call = await loadCallRow(db, args.callId)
  if (!call) return

  if (form.CallSid && !call.providerCallSid) {
    await db
      .from('booking_calls')
      .update({ provider_call_sid: form.CallSid.slice(0, 100) })
      .eq('id', call.id)
      .is('provider_call_sid', null)
  }

  const status = mapCallStatus(form.CallStatus)
  if (!status) return

  if (status === 'in_progress') {
    // Solo sube una llamada que aún no estaba en curso; nunca una terminada.
    await db.from('booking_calls').update({ status }).eq('id', call.id).in('status', ['queued', 'calling'])
    return
  }

  // Terminal: solo cierra una llamada que seguía abierta.
  const duration = readDuration(form.CallDuration)
  const { error } = await db
    .from('booking_calls')
    .update({
      status,
      finished_at: now.toISOString(),
      ...(duration !== null ? { duration_seconds: duration } : {}),
    })
    .eq('id', call.id)
    .in('status', [...IN_FLIGHT_STATUSES])
  if (error) throw new Error(`No se pudo cerrar la llamada: ${error.message}`)

  // Si terminó sin ningún resultado (colgó, no contestó), queda sin respuesta.
  await claimOutcome(db, call.id, 'no_response')
}

// ------------------------------------------------------------
// Resultado del <Dial>
// ------------------------------------------------------------

export interface DialResultArgs {
  /** Service role. */
  db: SupabaseClient
  callId: string
  /** `DialCallStatus`. */
  form: Record<string, string>
  now: Date
}

/** Un asesor contestó (la llamada pasada terminó bien). */
const DIAL_CONNECTED = new Set(['completed', 'answered'])

export async function handleDialResult(args: DialResultArgs): Promise<{ xml: string }> {
  const { db, form } = args
  const call = await loadCallRow(db, args.callId)
  if (!call) return { xml: hangupOnlyXml() }

  const connected = DIAL_CONNECTED.has((form.DialCallStatus ?? '').trim().toLowerCase())
  const outcome = connected ? 'advisor_connected' : 'advisor_missed'

  // La señal final puede llegar primero y dejar no_response, y en una llamada entrante
  // el menú pudo dejar un resultado "de paso" (leyó el horario): este resultado los pisa.
  const won = await claimOutcome(db, call.id, outcome, { from: [null, ...REPLACEABLE_OUTCOMES] })

  if (connected) return { xml: response([hangup()]) }

  if (won) {
    const who = await describeCaller(db, {
      accountId: call.accountId,
      contactId: call.contactId,
      // El número del paciente: en una entrante es quien llama; en una saliente, a quien se llamó.
      fallbackNumber: call.direction === 'inbound' ? call.fromNumber : call.toNumber,
    })
    await notifyCallTeam(db, {
      accountId: call.accountId,
      contactId: call.contactId,
      title: CALL_NOTICES.advisorMissedTitle,
      body: CALL_NOTICES.advisorMissed(who),
    })
  }

  const voice = resolveVoice(await loadCallSettings(db, call.accountId))
  return { xml: response([say(advisorMissed(), voice), hangup()]) }
}
