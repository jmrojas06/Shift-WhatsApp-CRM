// ============================================================
// Webhook de la llamada entrante (diseño §6.3): lo que pasa cada vez que
// Telnyx pide instrucciones de una llamada que entró por el número de la cuenta,
// ya con el token y la firma verificados por la ruta.
//
//   1. Primer pedido (sin `call` en la URL): encuentra la cuenta por el `To`,
//      crea la fila de la llamada (un reintento con el mismo `CallSid` reutiliza
//      la que ya existe) y saluda. Número sin cuenta o atención entrante apagada:
//      "Este número no está disponible".
//   2. Los siguientes (con `call`): cargan la fila. Con un resultado final, un
//      reintento recibe la misma despedida sin repetir nada.
//   3. Corre la máquina de pasos (`inbound-flow.ts`) con el paso, la vuelta, el
//      camino y la cita que vienen en la query, y la tecla del formulario.
//   4. Guarda la tecla y aplica el efecto (`inbound-effects.ts`).
//
// El estado del menú viaja en la query (`step`, `loop`, `path`, `appt`), nunca
// en memoria: cada pedido es independiente y se puede reintentar.
//
// Lo lento del efecto (WhatsApp, Google) vuelve en `deferred` para que la ruta
// lo corra con `after()`. Ni el nombre ni el teléfono de quien llama van a logs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isWithinOfficeHours } from '@/lib/voice/hours'
import { voiceUrl } from '@/lib/voice/tokens'
import { loadClinicContext } from '@/modules/clinica/settings'

import { isUuid } from '../panel-booking-input'
import {
  isActiveAppointment,
  isTerminalStatus,
  loadCallAppointment,
  loadCallRow,
  readMenuPath,
  REPLACEABLE_OUTCOMES,
  updateCall,
  type CallAppointment,
  type CallRow,
} from './calls-repo'
import { applyInboundEffect, type InboundDeps } from './inbound-effects'
import {
  inboundFailureXml,
  inboundFlow,
  inboundReplayXml,
  MAX_LOOPS,
  unavailableXml,
  type InboundFlowContext,
  type InboundNextAppointment,
  type InboundStep,
} from './inbound-flow'
import {
  dialableNumber,
  findInboundAccount,
  findOrCreateInboundCall,
  loadNextAppointment,
} from './inbound-repo'
import { failureXml, hangupOnlyXml, inactiveXml } from './outbound-flow'
import { loadAccountFacts } from './outbound-webhook'
import { DIAL_RESULT_PATH, INBOUND_WEBHOOK_PATH } from './paths'
import { loadCallSettings, resolveVoice, toE164, type CallSettings } from './settings'

/** Lo máximo que dura el robot antes de pasar la llamada al asesor (o despedirse). */
export const ROBOT_MAX_MINUTES = 10

export interface InboundWebhookArgs {
  /** Service role. */
  db: SupabaseClient
  /** La query de la URL: sin `call` en el primer pedido; con `call`, `step`, `loop`, `path`, `appt` después. */
  query: URLSearchParams
  /** El formulario del cuerpo: `CallSid`, `From`, `To`, `Digits`. */
  form: Record<string, string>
  now: Date
  deps: InboundDeps
}

export interface InboundWebhookResult {
  xml: string
  /** Para correr con `after()` después de responder. */
  deferred: (() => Promise<void>)[]
}

// ------------------------------------------------------------
// Lectura de la query
// ------------------------------------------------------------

function readStep(value: string | null): InboundStep {
  return value === 'appt' || value === 'cancel' ? value : 'menu'
}

/** La vuelta, de 1 a `MAX_LOOPS + 1` (una más es "ya se rindió"). */
function readLoop(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 1
  return Math.min(parsed, MAX_LOOPS + 1)
}

// ------------------------------------------------------------
// Armado del contexto
// ------------------------------------------------------------

/** Número que verá quien conteste: el "que marca" de la cuenta o, si no hay, el de la clínica. */
function callerIdOf(settings: CallSettings, call: CallRow): string | null {
  return settings.callerId ?? settings.inboundNumber ?? call.toNumber
}

/** A quién pasar la llamada AHORA: solo en horario de atención y con asesores. */
function pickAdvisors(settings: CallSettings, call: CallRow, officeOpen: boolean): InboundFlowContext['advisors'] {
  if (!officeOpen || settings.advisorPhones.length === 0) return null
  const callerId = callerIdOf(settings, call)
  return callerId ? { phones: settings.advisorPhones, callerId } : null
}

/**
 * Lo de la urgencia (solo una clínica y solo cuando marcaron 9): los signos de
 * alarma y el teléfono de turno de la sede. Si la configuración no se puede
 * leer, la llamada de urgencia sigue igual: sin el texto, con la frase corta.
 */
async function loadUrgency(
  db: SupabaseClient,
  accountId: string,
  callerId: string | null,
): Promise<InboundFlowContext['urgency']> {
  const clinic = await loadClinicContext(db, accountId)
  if (clinic.status !== 'ok') return { alarmText: null, onCall: null }
  const phone = dialableNumber(clinic.clinic.location?.onCallPhone)
  return {
    alarmText: clinic.clinic.urgencyAlarmText,
    onCall: phone && callerId ? { phone, callerId } : null,
  }
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------

export async function handleInboundWebhook(args: InboundWebhookArgs): Promise<InboundWebhookResult> {
  const { db, query, form, now, deps } = args
  const done = (xml: string): InboundWebhookResult => ({ xml, deferred: [] })

  // ---- La cuenta y la fila de la llamada ----
  const callParam = query.get('call')
  const first = callParam === null
  let call: CallRow
  let settings: CallSettings

  if (first) {
    const to = toE164(form.To)
    const account = await findInboundAccount(db, to)
    if (!to || !account || !account.settings.inboundEnabled) {
      return done(unavailableXml(resolveVoice(account?.settings ?? { voice: null })))
    }
    settings = account.settings

    const from = toE164(form.From)
    // El contacto es un extra (enlaza avisos y notas): si no se puede leer, la llamada sigue.
    const contact = from ? await deps.findContact(db, account.accountId, from).catch(() => null) : null
    call = await findOrCreateInboundCall(db, {
      accountId: account.accountId,
      sid: form.CallSid || null,
      from,
      to,
      contactId: contact?.id ?? null,
      now,
    })
  } else {
    const loaded = await loadCallRow(db, callParam)
    if (!loaded || loaded.direction !== 'inbound') return done(hangupOnlyXml())
    call = loaded
    // Una llamada que ya terminó no revive por un pedido tardío.
    if (isTerminalStatus(call.status)) return done(hangupOnlyXml())
    settings = await loadCallSettings(db, call.accountId)
    if (!settings.inboundEnabled) return done(unavailableXml(resolveVoice(settings)))
  }

  const voice = resolveVoice(settings)

  // Con un resultado final, un reintento recibe la misma despedida, sin efectos.
  // Los resultados "de paso" (leyó el horario) no cierran el menú.
  if (call.outcome && !(REPLACEABLE_OUTCOMES as readonly string[]).includes(call.outcome)) {
    return done(inboundReplayXml(call.outcome, voice))
  }

  const step = first ? 'menu' : readStep(query.get('step'))
  const loop = first ? 1 : readLoop(query.get('loop'))
  const path = first ? '' : readMenuPath(query.get('path'))
  const digits = first ? null : form.Digits?.trim() || null
  const apptParam = query.get('appt')
  const appointmentId = isUuid(apptParam) ? apptParam : null
  const createdAt = Date.parse(call.createdAt)
  const expired = !first && Number.isFinite(createdAt) && now.getTime() - createdAt > ROBOT_MAX_MINUTES * 60_000

  const account = await loadAccountFacts(db, call.accountId)
  const officeOpen = isWithinOfficeHours(settings.officeHours, now)
  const advisors = pickAdvisors(settings, call, officeOpen)

  // La cita de los pasos confirmar y cancelar: tiene que ser de quien llama y seguir activa.
  let appointment: CallAppointment | null = null
  if (!first && !expired && (step === 'appt' || step === 'cancel')) {
    appointment = appointmentId ? await loadCallAppointment(db, call.accountId, appointmentId) : null
    if (
      !appointment ||
      !isActiveAppointment(appointment, now) ||
      !call.contactId ||
      appointment.contactId !== call.contactId
    ) {
      return done(inactiveXml(voice))
    }
  }

  // Lo que solo hace falta leer cuando marcaron esa tecla en el menú.
  const pressedAtMenu = !first && !expired && step === 'menu' ? digits : null
  let nextAppointment: InboundNextAppointment | null | undefined
  if (pressedAtMenu === '2') {
    nextAppointment = call.contactId
      ? await loadNextAppointment(db, {
          accountId: call.accountId,
          contactId: call.contactId,
          clinic: account.clinic,
          now,
        })
      : null
  }
  const urgency =
    pressedAtMenu === '9' && account.clinic
      ? await loadUrgency(db, call.accountId, callerIdOf(settings, call))
      : { alarmText: null, onCall: null }

  const flow = inboundFlow(
    { step, loop, digits, path, first, appointmentId, expired },
    {
      voice,
      business: account.name,
      clinic: account.clinic,
      officeOpen,
      advisors,
      officeHours: settings.officeHours,
      infoText: settings.infoText,
      urgency,
      nextAppointment,
      urls: {
        step: (nextStep, nextLoop, nextPath, nextAppointmentId) =>
          voiceUrl(INBOUND_WEBHOOK_PATH, {
            call: call.id,
            step: nextStep,
            loop: nextLoop,
            path: nextPath === '' ? undefined : nextPath,
            appt: nextAppointmentId ?? undefined,
          }),
        dialResult: voiceUrl(DIAL_RESULT_PATH, { call: call.id }),
      },
    },
  )

  // Se escribe el valor (no se agrega a lo anterior): repetirlo da lo mismo.
  if (flow.digits !== null) {
    await updateCall(db, call.id, { digits: flow.digits, menu_path: flow.path === '' ? null : flow.path })
  }

  if (!flow.effect) return done(flow.xml)

  const result = await applyInboundEffect(flow.effect, { db, now, call, appointment, deps })
  if (!result.failed) return { xml: flow.xml, deferred: result.deferred }

  // Solo estos tres prometen algo a quien llama; el resto (leer el horario, un aviso) no cambia lo dicho.
  switch (flow.effect.type) {
    case 'send_link':
      return done(flow.failureXml ?? inboundFailureXml(voice))
    case 'confirm':
    case 'cancel':
      return done(failureXml(voice))
    default:
      return { xml: flow.xml, deferred: result.deferred }
  }
}
