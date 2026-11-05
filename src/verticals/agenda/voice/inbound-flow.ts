// ============================================================
// Llamada entrante, las 24 horas (diseño §6.3): la máquina de pasos.
//
// PURA: recibe en qué paso va la llamada (que viaja en la query de la URL, no
// en memoria), qué tecla marcó quien llama y los datos ya leídos, y devuelve el
// TeXML a decir y el efecto a aplicar. No toca red ni base; `inbound-effects.ts`
// aplica el efecto y `inbound-webhook.ts` junta las dos cosas.
//
// Pasos:
//   menu    9 urgencia (solo clínicas) · 1 agendar · 2 mi cita · 3 horario · 0 asesor
//   appt    1 confirma · 2 pregunta si está seguro · 0 vuelve al menú
//   cancel  1 sí, cancela · 2 no, vuelve al menú
//
// Cada pregunta se repite como mucho `MAX_REPEATS` veces (3 vueltas en total).
// Un Gather sin tecla cae al `<Redirect>` que sigue, que trae la vuelta
// siguiente; con otra tecla dice "No entendí" y repite. Pasadas las vueltas se
// despide SIN tocar nada.
//
// Un asesor solo recibe la llamada en horario de atención (`ctx.advisors` es
// null fuera de él). Nunca se nombra el procedimiento: el guion ni siquiera lo
// recibe, porque el teléfono puede ser compartido.
// ============================================================

import type { OfficeHours } from '@/lib/voice/hours'
import { dial, gather, hangup, redirect, response, say, type SayNode } from '@/lib/voice/texml'

import type { CallOutcome } from './calls-repo'
import { appendMenuPath } from './calls-repo'
import * as scripts from './scripts'

export type InboundStep = 'menu' | 'appt' | 'cancel'

/** Cuántas veces se repite una pregunta sin respuesta (o con tecla mala). */
export const MAX_REPEATS = 2
/** Vueltas de una pregunta: la primera vez más las repeticiones. */
export const MAX_LOOPS = MAX_REPEATS + 1

/** Segundos que espera una tecla después de decir el menú. */
const GATHER_TIMEOUT_SECONDS = 6
/** Segundos que suenan los teléfonos de los asesores, y lo máximo que dura la llamada pasada. */
const ADVISOR_RING_SECONDS = 25
const ADVISOR_TIME_LIMIT_SECONDS = 1800

const MAX_DIGITS_STORED = 10

/** Lo que hay que hacer en la base (o con WhatsApp) por la tecla marcada. */
export type InboundEffect =
  /** Mandar el botón "Agendar" por WhatsApp; el resultado cambia lo que se dice. */
  | { type: 'send_link' }
  | { type: 'confirm'; appointmentId: string }
  | { type: 'cancel'; appointmentId: string }
  /** Urgencia y no hay a quién pasar la llamada: aviso prioritario al equipo. */
  | { type: 'urgency_unattended' }
  /** Pidió un asesor en horario y no hay teléfonos configurados: aviso al equipo. */
  | { type: 'advisor_unavailable' }
  /** La llamada pasa a un teléfono; el resultado lo pone `dial-result`. */
  | { type: 'dial' }
  | { type: 'info' }
  | { type: 'out_of_hours' }
  /** Nadie marcó nada (o solo teclas malas). */
  | { type: 'no_response' }

export interface InboundFlowInput {
  step: InboundStep
  /** Vuelta de esta pregunta (desde 1). */
  loop: number
  /** Lo que marcó (`Digits`), o null si no marcó nada. */
  digits: string | null
  /** Teclas válidas marcadas antes, separadas por `>`. */
  path: string
  /** Primer pedido de la llamada: saluda y dice el menú. */
  first: boolean
  /** La cita de los pasos `appt` y `cancel`. */
  appointmentId: string | null
  /** Pasaron los 10 minutos del robot: la llamada pasa al asesor o se corta. */
  expired: boolean
}

/** La próxima cita de quien llama, ya con lo que hace falta para decirla. */
export interface InboundNextAppointment {
  id: string
  speech: scripts.AppointmentSpeech & { patient: string | null }
}

export interface InboundFlowContext {
  voice: string
  business: string
  clinic: boolean
  /** ¿Es horario de atención ahora? (festivo = cerrado). */
  officeOpen: boolean
  /** A quién pasar la llamada ahora; null si es fuera de horario o no hay teléfonos. */
  advisors: { phones: readonly string[]; callerId: string } | null
  officeHours: OfficeHours
  /** Texto de horario y dirección que lee la opción 3. */
  infoText: string
  /** Solo se usa en la urgencia (clínicas). */
  urgency: {
    alarmText: string | null
    /** El teléfono de turno de la sede, ya en E.164; null si no hay. */
    onCall: { phone: string; callerId: string } | null
  }
  /**
   * La próxima cita activa de quien llama, solo cuando acaba de marcar 2 en el
   * menú. null = no tiene; undefined = no se leyó (se trata como que no tiene).
   */
  nextAppointment: InboundNextAppointment | null | undefined
  urls: {
    /** URL (ya firmada) de un paso del menú. */
    step: (step: InboundStep, loop: number, path: string, appointmentId: string | null) => string
    /** URL (ya firmada) que recibe el resultado del `Dial`. */
    dialResult: string
  }
}

export interface InboundFlowResult {
  xml: string
  /** Lo que se dice si el efecto falla (solo `send_link`); sin él se usa el de `xml`. */
  failureXml?: string
  effect: InboundEffect | null
  /** Lo marcado, para la columna `digits` (como mucho 10 caracteres); null si no marcó. */
  digits: string | null
  /** El camino de teclas para `menu_path`. */
  path: string
}

// ------------------------------------------------------------
// Armado de las respuestas
// ------------------------------------------------------------

export function inboundFlow(input: InboundFlowInput, ctx: InboundFlowContext): InboundFlowResult {
  const speak = (text: string): SayNode => say(text, ctx.voice)
  const loop = Math.max(1, Math.floor(input.loop) || 1)
  // El primer pedido todavía no tiene menú que reciba una tecla.
  const pressed = input.first ? '' : (input.digits ?? '').trim()
  const key = pressed === '' ? null : pressed
  const digits = key === null ? null : key.slice(0, MAX_DIGITS_STORED)

  /** Termina la llamada diciendo estas frases. */
  const finish = (phrases: string[], effect: InboundEffect | null, path = input.path): InboundFlowResult => ({
    xml: response([...phrases.map(speak), hangup()]),
    effect,
    digits,
    path,
  })

  /**
   * Pregunta con un Gather. Lo de `intro` se dice antes, fuera del Gather, para
   * que una tecla no lo corte. Sin tecla, el Redirect sigue en la vuelta
   * siguiente.
   */
  const ask = (
    step: InboundStep,
    askLoop: number,
    path: string,
    phrase: string,
    options: { intro?: string[]; appointmentId?: string | null } = {},
  ): InboundFlowResult => {
    const appointmentId = options.appointmentId ?? null
    return {
      xml: response([
        ...(options.intro ?? []).map(speak),
        gather(
          { action: ctx.urls.step(step, askLoop, path, appointmentId), numDigits: 1, timeout: GATHER_TIMEOUT_SECONDS },
          [speak(phrase)],
        ),
        redirect(ctx.urls.step(step, askLoop + 1, path, appointmentId)),
      ]),
      effect: null,
      digits,
      path,
    }
  }

  /** Pasa la llamada a estos teléfonos (después de decir `intro`). */
  const passTo = (intro: string[], phones: readonly string[], callerId: string, path: string): InboundFlowResult => ({
    xml: response([
      ...intro.map(speak),
      dial(
        {
          action: ctx.urls.dialResult,
          timeout: ADVISOR_RING_SECONDS,
          timeLimit: ADVISOR_TIME_LIMIT_SECONDS,
          callerId,
        },
        phones,
      ),
    ]),
    effect: { type: 'dial' },
    digits,
    path,
  })

  const menuQuestion = scripts.inboundMenu({ clinic: ctx.clinic })
  const questionOf = (step: InboundStep): string =>
    step === 'menu' ? menuQuestion : step === 'appt' ? scripts.inboundApptReprompt() : scripts.cancelConfirmAsk()

  // Primer pedido: saludo (fuera del Gather) y menú.
  if (input.first) {
    return ask('menu', 1, '', menuQuestion, { intro: [scripts.inboundGreeting({ business: ctx.business })] })
  }

  // Pasaron los 10 minutos: se pasa al asesor si hay, y si no se despide.
  if (input.expired) {
    if (ctx.advisors && ctx.advisors.phones.length > 0 && ctx.advisors.callerId) {
      return passTo([scripts.advisorConnecting()], ctx.advisors.phones, ctx.advisors.callerId, input.path)
    }
    return finish([scripts.thanksGoodbye()], { type: 'no_response' })
  }

  // Sin tecla: la pregunta de esta vuelta, o rendirse si ya fueron todas.
  if (key === null) {
    if (loop > MAX_LOOPS) return finish([scripts.thanksGoodbye()], { type: 'no_response' })
    return ask(input.step, loop, input.path, questionOf(input.step), { appointmentId: input.appointmentId })
  }

  // Una tecla que no es del paso: "No entendí" y se repite, o se rinde en la última vuelta.
  const invalid = (): InboundFlowResult => {
    if (loop >= MAX_LOOPS) return finish([scripts.notUnderstood(), scripts.thanksGoodbye()], { type: 'no_response' })
    return ask(input.step, loop + 1, input.path, questionOf(input.step), {
      intro: [scripts.notUnderstood()],
      appointmentId: input.appointmentId,
    })
  }

  const path = appendMenuPath(input.path, key)

  // ---- Paso `appt`: 1 confirma · 2 cancela (con doble confirmación) · 0 vuelve ----
  if (input.step === 'appt') {
    if (!input.appointmentId) return invalid()
    switch (key) {
      case '1':
        return finish([scripts.appointmentConfirmed()], { type: 'confirm', appointmentId: input.appointmentId }, path)
      case '2':
        return ask('cancel', 1, path, scripts.cancelConfirmAsk(), { appointmentId: input.appointmentId })
      case '0':
        return ask('menu', 1, path, menuQuestion)
      default:
        return invalid()
    }
  }

  // ---- Paso `cancel`: 1 = sí, 2 = no ----
  if (input.step === 'cancel') {
    if (!input.appointmentId) return invalid()
    switch (key) {
      case '1':
        return finish([scripts.appointmentCancelled()], { type: 'cancel', appointmentId: input.appointmentId }, path)
      case '2':
        return ask('menu', 1, path, menuQuestion)
      default:
        return invalid()
    }
  }

  // ---- Paso `menu` ----
  switch (key) {
    case '9': {
      if (!ctx.clinic) return invalid()
      const alarm = scripts.urgencyAlarm({ alarmText: ctx.urgency.alarmText })
      // En horario, los asesores; si no hay (o es fuera de horario), el teléfono de turno.
      if (ctx.advisors && ctx.advisors.phones.length > 0 && ctx.advisors.callerId) {
        return passTo([alarm, scripts.advisorConnecting()], ctx.advisors.phones, ctx.advisors.callerId, path)
      }
      if (ctx.urgency.onCall) {
        return passTo([alarm, scripts.urgencyOnCall()], [ctx.urgency.onCall.phone], ctx.urgency.onCall.callerId, path)
      }
      return finish([alarm, scripts.urgencyNoOne()], { type: 'urgency_unattended' }, path)
    }

    case '1': {
      return {
        ...finish([scripts.bookingLinkSent(), scripts.goodbye()], { type: 'send_link' }, path),
        failureXml: response([speak(scripts.bookingLinkFailed()), speak(scripts.goodbye()), hangup()]),
      }
    }

    case '2': {
      const next = ctx.nextAppointment
      if (!next) return ask('menu', 1, path, scripts.noAppointments())
      return ask('appt', 1, path, scripts.myAppointment(next.speech), { appointmentId: next.id })
    }

    case '3': {
      const info = scripts.officeInfo({ infoText: ctx.infoText, officeHours: ctx.officeHours })
      return { ...ask('menu', 1, path, menuQuestion, { intro: [info] }), effect: { type: 'info' } }
    }

    case '0': {
      if (ctx.advisors && ctx.advisors.phones.length > 0 && ctx.advisors.callerId) {
        return passTo([scripts.advisorConnecting()], ctx.advisors.phones, ctx.advisors.callerId, path)
      }
      if (ctx.officeOpen) return finish([scripts.advisorMissed()], { type: 'advisor_unavailable' }, path)
      return {
        ...ask('menu', 1, path, menuQuestion, { intro: [scripts.outOfHours({ officeHours: ctx.officeHours })] }),
        effect: { type: 'out_of_hours' },
      }
    }

    default:
      return invalid()
  }
}

// ------------------------------------------------------------
// Respuestas fijas
// ------------------------------------------------------------

/** No hay cuenta para este número, o la atención entrante está apagada. */
export function unavailableXml(voice: string): string {
  return response([say(scripts.numberUnavailable(), voice), hangup()])
}

/** Algo falló por dentro: no se promete lo que no se hizo (ni que alguien llamará). */
export function inboundFailureXml(voice: string): string {
  return response([say(scripts.temporaryFailure(), voice), hangup()])
}

/**
 * La despedida de una llamada que YA tiene un resultado final: un reintento del
 * webhook recibe la misma respuesta sin repetir ningún efecto.
 */
export function inboundReplayXml(outcome: CallOutcome, voice: string): string {
  const phrases: string[] =
    outcome === 'confirmed'
      ? [scripts.appointmentConfirmed()]
      : outcome === 'cancelled'
        ? [scripts.appointmentCancelled()]
        : outcome === 'booking_link_sent'
          ? [scripts.bookingLinkSent(), scripts.goodbye()]
          : outcome === 'urgency'
            ? [scripts.urgencyNoOne()]
            : outcome === 'human'
              ? [scripts.humanFollowUp()]
              : outcome === 'advisor_missed'
                ? [scripts.advisorMissed()]
                : []
  return response([...phrases.map((phrase) => say(phrase, voice)), hangup()])
}
