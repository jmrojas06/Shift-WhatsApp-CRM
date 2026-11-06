// ============================================================
// Llamada de confirmación (diseño §6.2): la máquina de pasos.
//
// PURA: recibe en qué paso va la llamada (que viaja en la query de la URL, no
// en memoria), qué tecla marcó el paciente y los datos ya leídos, y devuelve el
// TeXML a decir y el efecto a aplicar. No toca red ni base; `effects.ts` aplica
// el efecto y la ruta del webhook junta las dos cosas.
//
// Pasos:
//   menu    1 confirma · 2 pregunta si está seguro · 3 un asesor o el equipo
//   cancel  1 sí, cancela · 2 no, vuelve al menú
//
// Cada pregunta se hace como mucho `MAX_LOOPS` veces ("vueltas"). Un Gather sin
// tecla cae al `<Redirect>` que sigue, que trae la vuelta siguiente. Con otra
// tecla dice "No entendí" y repite. Pasadas las vueltas cuelga SIN tocar la
// cita (el resultado es no_response).
//
// Nunca se nombra el procedimiento: el guion (`scripts.ts`) ni siquiera lo
// recibe, porque el teléfono puede ser compartido.
// ============================================================

import { dial, gather, hangup, redirect, response, say, type SayNode } from '@/lib/voice/texml'

import type { CallOutcome } from './calls-repo'
import { appendMenuPath } from './calls-repo'
import * as scripts from './scripts'

export type OutboundStep = 'menu' | 'cancel'

/** Cuántas veces se hace cada pregunta antes de rendirse. */
export const MAX_LOOPS = 2

/** Segundos que espera una tecla después de decir el menú. */
const GATHER_TIMEOUT_SECONDS = 6
/** Segundos que suenan los teléfonos de los asesores, y lo máximo que dura la llamada pasada. */
const ADVISOR_RING_SECONDS = 25
const ADVISOR_TIME_LIMIT_SECONDS = 1800

/** Lo que hay que hacer en la base por la tecla marcada. */
export type OutboundEffect =
  | { type: 'confirm' }
  | { type: 'cancel' }
  /** Pidió hablar con alguien y no hay a quién pasar la llamada. */
  | { type: 'human' }
  /** La llamada pasa a los asesores; el resultado lo pone `dial-result`. */
  | { type: 'dial' }
  /** Nadie marcó nada (o solo teclas malas): sin tocar la cita. */
  | { type: 'no_response' }

export interface OutboundFlowInput {
  step: OutboundStep
  /** Vuelta de esta pregunta (desde 1). */
  loop: number
  /** Lo que marcó (`Digits`), o null si no marcó nada. */
  digits: string | null
  /** Teclas válidas marcadas antes, separadas por `>`. */
  path: string
}

/** El saludo; solo hace falta en la primera vuelta del menú. */
export interface OutboundGreeting {
  business: string
  patient: string | null
  /** De `spokenWhen`: "el martes 10 de noviembre". */
  day: string
  /** De `spokenWhen`: "a las 3 y media de la tarde". */
  time: string
  staff: string | null
}

export interface OutboundFlowContext {
  voice: string
  greeting: OutboundGreeting | null
  /** Llamada de prueba: abre diciéndolo. */
  test: boolean
  /** A quién pasar la llamada con la tecla 3; null si ahora no hay nadie. */
  advisors: { phones: readonly string[]; callerId: string } | null
  urls: {
    /** URL (ya firmada) de un paso del menú. */
    step: (step: OutboundStep, loop: number, path: string) => string
    /** URL (ya firmada) que recibe el resultado del `Dial`. */
    dialResult: string
  }
}

export interface OutboundFlowResult {
  xml: string
  effect: OutboundEffect | null
  /** Lo marcado, para la columna `digits` (como mucho 10 caracteres); null si no marcó. */
  digits: string | null
  /** El camino de teclas para `menu_path`. */
  path: string
}

// ------------------------------------------------------------
// Armado de las respuestas
// ------------------------------------------------------------

const MAX_DIGITS_STORED = 10

export function outboundFlow(input: OutboundFlowInput, ctx: OutboundFlowContext): OutboundFlowResult {
  const speak = (text: string): SayNode => say(text, ctx.voice)
  const loop = Math.max(1, Math.floor(input.loop) || 1)
  const pressed = (input.digits ?? '').trim()
  const key = pressed === '' ? null : pressed
  const digits = key === null ? null : key.slice(0, MAX_DIGITS_STORED)

  /** Termina la llamada diciendo estas frases. */
  const finish = (phrases: string[], effect: OutboundEffect | null, path = input.path): OutboundFlowResult => ({
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
    step: OutboundStep,
    askLoop: number,
    path: string,
    phrase: string,
    intro: string[] = [],
  ): OutboundFlowResult => ({
    xml: response([
      ...intro.map(speak),
      gather(
        { action: ctx.urls.step(step, askLoop, path), numDigits: 1, timeout: GATHER_TIMEOUT_SECONDS },
        [speak(phrase)],
      ),
      redirect(ctx.urls.step(step, askLoop + 1, path)),
    ]),
    effect: null,
    digits,
    path,
  })

  const questionOf = (step: OutboundStep): string =>
    step === 'menu' ? scripts.outboundReprompt() : scripts.cancelConfirmAsk()

  // Sin tecla: la pregunta de esta vuelta, o rendirse si ya fueron todas.
  if (key === null) {
    if (loop > MAX_LOOPS) return finish([scripts.noResponse()], { type: 'no_response' })
    if (input.step === 'menu' && loop === 1 && ctx.greeting) {
      const menu = scripts.outboundMenu({ ...ctx.greeting })
      return ask('menu', 1, input.path, menu, ctx.test ? [scripts.testCallIntro()] : [])
    }
    return ask(input.step, loop, input.path, questionOf(input.step))
  }

  // Una tecla que no es del paso: "No entendí" y se repite, o se rinde en la última vuelta.
  const invalid = (): OutboundFlowResult => {
    if (loop >= MAX_LOOPS) return finish([scripts.notUnderstood(), scripts.goodbye()], { type: 'no_response' })
    return ask(input.step, loop + 1, input.path, questionOf(input.step), [scripts.notUnderstood()])
  }

  if (input.step === 'menu') {
    switch (key) {
      case '1':
        return finish([scripts.appointmentConfirmed()], { type: 'confirm' }, appendMenuPath(input.path, '1'))
      case '2':
        return ask('cancel', 1, appendMenuPath(input.path, '2'), scripts.cancelConfirmAsk())
      case '3': {
        const path = appendMenuPath(input.path, '3')
        if (!ctx.advisors || ctx.advisors.phones.length === 0 || !ctx.advisors.callerId) {
          return finish([scripts.humanFollowUp()], { type: 'human' }, path)
        }
        return {
          xml: response([
            speak(scripts.advisorConnecting()),
            dial(
              {
                action: ctx.urls.dialResult,
                timeout: ADVISOR_RING_SECONDS,
                timeLimit: ADVISOR_TIME_LIMIT_SECONDS,
                callerId: ctx.advisors.callerId,
              },
              ctx.advisors.phones,
            ),
          ]),
          effect: { type: 'dial' },
          digits,
          path,
        }
      }
      default:
        return invalid()
    }
  }

  // Paso `cancel`: 1 = sí, 2 = no.
  switch (key) {
    case '1':
      return finish([scripts.appointmentCancelled()], { type: 'cancel' }, appendMenuPath(input.path, '1'))
    case '2':
      return ask('menu', 1, appendMenuPath(input.path, '2'), scripts.outboundReprompt())
    default:
      return invalid()
  }
}

// ------------------------------------------------------------
// Respuestas fijas
// ------------------------------------------------------------

/** No hay llamada que atender (el id no existe o es de otra clase): colgar sin decir nada. */
export function hangupOnlyXml(): string {
  return response([hangup()])
}

/** La cita ya no está activa (se canceló o pasó antes de que contestaran). */
export function inactiveXml(voice: string): string {
  return response([say(scripts.appointmentInactive(), voice), hangup()])
}

/** Algo falló por dentro: no se promete lo que no se hizo, se dice que alguien lo contactará. */
export function failureXml(voice: string): string {
  return response([say(scripts.humanFollowUp(), voice), hangup()])
}

/**
 * La despedida de una llamada que YA tiene resultado: un reintento del webhook
 * recibe la misma respuesta sin repetir ningún efecto.
 */
export function replayXml(outcome: CallOutcome, voice: string): string {
  const phrase: string | null =
    outcome === 'confirmed'
      ? scripts.appointmentConfirmed()
      : outcome === 'cancelled'
        ? scripts.appointmentCancelled()
        : outcome === 'human'
          ? scripts.humanFollowUp()
          : outcome === 'no_response'
            ? scripts.noResponse()
            : outcome === 'advisor_missed'
              ? scripts.advisorMissed()
              : null
  return response([...(phrase ? [say(phrase, voice)] : []), hangup()])
}
