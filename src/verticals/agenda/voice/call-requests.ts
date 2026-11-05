// ============================================================
// Llamadas que pide una persona (no el cron):
//
//   - `requestRobotCallNow`: la recepción toca "Llamar con el robot ahora" en la
//     lista Para llamar. Es un intento más del robot a esa cita (`channel =
//     'robot'`), a nombre de quien lo pidió.
//   - `requestTestCall`: el admin escribe un número en la tarjeta de llamadas y
//     el robot le llama con el guion de ejemplo. La fila no tiene cita ni
//     contacto, así que no toca ninguna cita.
//
// Las reglas que protegen al paciente valen igual que en la llamada automática:
// solo dentro de la ventana de llamadas, nunca domingo ni festivo, ni a quien
// pidió la baja o `no-llamar`, ni en una clínica a quien revocó la autorización,
// ni pasando el tope del mes. Lo que no aplica a una persona que decide: esperar
// el recordatorio de 24 h ni `max_attempts` (queda el tope de 3 de la base).
//
// El tope del mes se mira antes de llamar y NO es atómico: dos pedidos a la vez
// (o uno de la recepción y el cron) pueden dejar pasar unas pocas llamadas de más.
// Se acepta ese pequeño exceso; el tope protege el gasto, no es un límite legal.
//
// Devuelven un resultado con el estado HTTP y un texto que la pantalla muestra
// tal cual: nunca llevan el teléfono ni el nombre del paciente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isWithinCallWindow } from '@/lib/voice/hours'
import type { VoiceProvider } from '@/lib/voice/telnyx'
import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'

import { isUuid } from '../panel-booking-input'
import { isActiveAppointment, loadCallAppointment } from './calls-repo'
import {
  contactCallBlock,
  countMonthlyCalls,
  HARD_MAX_ATTEMPTS,
  hasInFlightRobotCall,
  loadCallablePhone,
  loadHistory,
  nextRobotAttempt,
  startOutboundCall,
  type CallBlock,
  type StartOutboundCallResult,
} from './outbound-runner'
import { loadCallSettings, toE164, type CallSettings } from './settings'

export type CallRequestFailure = { ok: false; status: number; code: string; error: string }
export type RobotCallResult = { ok: true; callId: string; attempt: number } | CallRequestFailure
export type TestCallResult = { ok: true; callId: string } | CallRequestFailure

const fail = (status: number, code: string, error: string): CallRequestFailure => ({ ok: false, status, code, error })

const MSG = {
  outboundOff: 'Las llamadas salientes están apagadas en esta cuenta.',
  appointmentMissing: 'La cita no existe.',
  notActive: 'La cita ya no está activa.',
  alreadyConfirmed: 'El paciente ya confirmó esta cita.',
  noPhone: 'El contacto no tiene un teléfono válido para llamar.',
  attempts: `Ya se hicieron ${HARD_MAX_ATTEMPTS} llamadas del robot a esta cita.`,
  inFlight: 'Ya hay una llamada del robot en curso para esta cita.',
  monthlyLimit: 'Se llegó al tope de llamadas del mes.',
  noCallerId: 'Falta el número desde el que se llama. Lo configura Shift.',
  providerRejected: 'El proveedor de llamadas no aceptó la llamada. Intenta de nuevo en unos minutos.',
  invalidPhone: 'Escribe el número con el indicativo, por ejemplo +57 300 123 4567.',
  tooSoon: 'Espera un minuto antes de pedir otra llamada de prueba.',
} as const

const BLOCK_MESSAGES: Record<CallBlock, string> = {
  opt_out: 'El paciente pidió no recibir mensajes ni llamadas.',
  no_call: 'Este contacto tiene la etiqueta no-llamar.',
  consent_revoked: 'El paciente revocó la autorización de sus datos.',
}

function outsideWindowMessage(settings: CallSettings): string {
  const days = settings.callSaturday ? 'de lunes a sábado' : 'de lunes a viernes'
  return (
    `Ahora no se puede llamar: las llamadas salen ${days}, de ${settings.windowStart} a ${settings.windowEnd} ` +
    '(hora de Bogotá), y nunca en domingos ni festivos.'
  )
}

/** Resultado de `startOutboundCall` → respuesta; el 23505 es "otra llamada ganó el intento". */
function fromStart<T extends { ok: true }>(
  started: StartOutboundCallResult,
  success: (callId: string) => T,
): T | CallRequestFailure {
  if (started.kind === 'started') return success(started.callId)
  if (started.kind === 'claimed_by_other') return fail(409, 'in_flight', MSG.inFlight)
  // El detalle de Telnyx queda en la fila (`error`); a la pantalla no sube.
  return fail(502, 'provider_rejected', MSG.providerRejected)
}

// ------------------------------------------------------------
// Llamar con el robot ahora
// ------------------------------------------------------------

export interface RobotCallRequest {
  /** Service role. */
  db: SupabaseClient
  provider: VoiceProvider
  accountId: string
  /** Quien lo pidió. */
  userId: string
  appointmentId: string
  now: Date
}

export async function requestRobotCallNow(args: RobotCallRequest): Promise<RobotCallResult> {
  const { db, accountId, now } = args
  if (!isUuid(args.appointmentId)) return fail(404, 'not_found', MSG.appointmentMissing)

  const settings = await loadCallSettings(db, accountId)
  if (!settings.outboundEnabled) return fail(409, 'outbound_off', MSG.outboundOff)
  if (!isWithinCallWindow(settings, now)) return fail(409, 'outside_window', outsideWindowMessage(settings))

  const appointment = await loadCallAppointment(db, accountId, args.appointmentId)
  if (!appointment) return fail(404, 'not_found', MSG.appointmentMissing)
  if (!isActiveAppointment(appointment, now)) return fail(409, 'not_active', MSG.notActive)
  if (appointment.attendanceConfirmedAt) return fail(409, 'already_confirmed', MSG.alreadyConfirmed)

  const to = await loadCallablePhone(db, { accountId, contactId: appointment.contactId })
  if (!to) return fail(409, 'no_phone', MSG.noPhone)

  const modules = await readAccountModules(db, accountId)
  if (modules.error) throw new Error(`No se pudieron leer los módulos de la cuenta: ${modules.error.message}`)
  const block = await contactCallBlock(db, {
    accountId,
    contactId: appointment.contactId,
    clinic: hasModule(modules.account, 'clinica'),
  })
  if (block) return fail(409, block, BLOCK_MESSAGES[block])

  const history = (await loadHistory(db, accountId, [appointment.id])).get(appointment.id) ?? []
  const attempt = nextRobotAttempt(history)
  if (attempt > HARD_MAX_ATTEMPTS) return fail(409, 'attempts', MSG.attempts)
  if (hasInFlightRobotCall(history, now)) return fail(409, 'in_flight', MSG.inFlight)

  const from = settings.callerId ?? settings.inboundNumber
  if (!from) return fail(409, 'no_caller_id', MSG.noCallerId)
  if ((await countMonthlyCalls(db, accountId, now)) >= settings.monthlyLimit) {
    return fail(409, 'monthly_limit', MSG.monthlyLimit)
  }

  const started = await startOutboundCall({
    db,
    provider: args.provider,
    accountId,
    from,
    to,
    appointmentId: appointment.id,
    contactId: appointment.contactId,
    attempt,
    createdBy: args.userId,
    now,
  })
  return fromStart(started, (callId) => ({ ok: true as const, callId, attempt }))
}

// ------------------------------------------------------------
// Probar llamada
// ------------------------------------------------------------

export interface TestCallRequest {
  /** Service role. */
  db: SupabaseClient
  provider: VoiceProvider
  accountId: string
  /** El admin que la pidió. */
  userId: string
  /** Lo que escribió: se valida aquí. */
  phone: unknown
  now: Date
}

/** Entre dos pruebas de la misma cuenta tiene que pasar este tiempo. */
const TEST_COOLDOWN_MS = 60_000

/**
 * Reserva el minuto de espera de las pruebas de la cuenta ANTES de llamar, con un solo UPDATE
 * condicional sobre `booking_call_settings.last_test_call_at`: gana el pedido que lo pone en
 * "ahora" mientras estaba vacío o tenía más de un minuto, y el otro (un doble clic, otra
 * pestaña) no encuentra fila y recibe 429. Así dos pruebas a la vez no pagan dos llamadas.
 *
 * La fila de configuración existe siempre que se llega aquí: el número que marca
 * (`caller_id` o `inbound_number`) sale de ella, y sin número ya se respondió 409.
 */
async function claimTestCooldown(db: SupabaseClient, accountId: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - TEST_COOLDOWN_MS).toISOString()
  const { data, error } = await db
    .from('booking_call_settings')
    .update({ last_test_call_at: now.toISOString() })
    .eq('account_id', accountId)
    .or(`last_test_call_at.is.null,last_test_call_at.lt.${cutoff}`)
    .select('account_id')
  if (error) throw new Error(`No se pudo reservar la llamada de prueba: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

export async function requestTestCall(args: TestCallRequest): Promise<TestCallResult> {
  const { db, accountId, now } = args
  const to = toE164(args.phone)
  if (!to) return fail(400, 'invalid_phone', MSG.invalidPhone)

  const settings = await loadCallSettings(db, accountId)
  const from = settings.callerId ?? settings.inboundNumber
  if (!from) return fail(409, 'no_caller_id', MSG.noCallerId)

  // Una prueba cuenta para el tope del mes (que se mira primero: una prueba que no sale no gasta el minuto)...
  if ((await countMonthlyCalls(db, accountId, now)) >= settings.monthlyLimit) {
    return fail(409, 'monthly_limit', MSG.monthlyLimit)
  }

  // ...y cuesta como cualquier llamada: no se repite en el mismo minuto. El minuto se reserva con un
  // UPDATE condicional ANTES de llamar a Telnyx, para que un doble clic no pague dos llamadas. Si
  // Telnyx la rechaza el minuto ya se gastó (espera como cualquier prueba).
  if (!(await claimTestCooldown(db, accountId, now))) return fail(429, 'too_soon', MSG.tooSoon)

  const started = await startOutboundCall({
    db,
    provider: args.provider,
    accountId,
    from,
    to,
    appointmentId: null,
    contactId: null,
    attempt: null,
    createdBy: args.userId,
    now,
  })
  return fromStart(started, (callId) => ({ ok: true as const, callId }))
}
