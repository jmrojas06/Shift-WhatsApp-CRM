// ============================================================
// Webhook de la llamada de confirmación (diseño §6.2): lo que pasa cada vez
// que Telnyx pide instrucciones de una llamada saliente, ya con el token y la
// firma verificados por la ruta.
//
//   1. Carga la llamada (por el `call` de la URL) y la cuenta.
//   2. Si la llamada ya tiene resultado, repite la despedida (un reintento no
//      repite nada).
//   3. Si la cita ya no está activa, lo dice y cuelga.
//   4. Corre la máquina de pasos (`outbound-flow.ts`) con el paso, la vuelta y
//      el camino que vienen en la query, y la tecla del formulario.
//   5. Guarda la tecla y aplica el efecto (`effects.ts`).
//
// El estado del menú viaja en la query (`step`, `loop`, `path`), nunca en
// memoria: cada pedido es independiente y se puede reintentar.
//
// Lo lento del efecto (WhatsApp, Google) vuelve en `deferred` para que la ruta
// lo corra con `after()`. Ni el nombre ni el teléfono del paciente van a logs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isWithinOfficeHours } from '@/lib/voice/hours'
import { voiceUrl } from '@/lib/voice/tokens'
import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'
import { loadClinicReminderInfo } from '@/modules/clinica/reminder-info'

import { loadStaffName } from '../agent/db'
import { CALL_NOTICES } from './call-notices'
import {
  isActiveAppointment,
  loadCallAppointment,
  loadCallRow,
  readMenuPath,
  updateCall,
  type CallAppointment,
  type CallRow,
} from './calls-repo'
import { applyOutboundEffect, type EffectDeps } from './effects'
import {
  failureXml,
  hangupOnlyXml,
  inactiveXml,
  MAX_LOOPS,
  outboundFlow,
  replayXml,
  type OutboundFlowContext,
  type OutboundGreeting,
  type OutboundStep,
} from './outbound-flow'
import { DIAL_RESULT_PATH, OUTBOUND_WEBHOOK_PATH } from './paths'
import { spokenStaff, spokenWhen } from './scripts'
import { loadCallSettings, resolveVoice, type CallSettings } from './settings'

/** Datos de ejemplo de la llamada de prueba: no es la cita de nadie. */
const SAMPLE_DAY = 'mañana'
const SAMPLE_TIME = 'a las 3 de la tarde'

export interface OutboundWebhookArgs {
  /** Service role. */
  db: SupabaseClient
  /** El `call` de la URL (ya verificado con su token). */
  callId: string
  query: URLSearchParams
  /** El formulario del cuerpo: `CallSid`, `Digits`. */
  form: Record<string, string>
  now: Date
  deps: EffectDeps
}

export interface OutboundWebhookResult {
  xml: string
  /** Para correr con `after()` después de responder. */
  deferred: (() => Promise<void>)[]
}

// ------------------------------------------------------------
// Lectura de la query
// ------------------------------------------------------------

function readStep(value: string | null): OutboundStep {
  return value === 'cancel' ? 'cancel' : 'menu'
}

/** La vuelta, de 1 a `MAX_LOOPS + 1` (una más es "ya se rindió"). */
function readLoop(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 1
  return Math.min(parsed, MAX_LOOPS + 1)
}

// ------------------------------------------------------------
// Lecturas de la cuenta
// ------------------------------------------------------------

async function loadAccountFacts(db: SupabaseClient, accountId: string): Promise<{ name: string; clinic: boolean }> {
  const [{ data, error }, modules] = await Promise.all([
    db.from('accounts').select('name').eq('id', accountId).maybeSingle(),
    readAccountModules(db, accountId),
  ])
  if (error) throw new Error(`No se pudo leer la cuenta de la llamada: ${error.message}`)
  if (modules.error) throw new Error(`No se pudo leer los módulos de la cuenta: ${modules.error.message}`)
  return {
    name: String((data as { name?: string | null } | null)?.name ?? ''),
    clinic: hasModule(modules.account, 'clinica'),
  }
}

/**
 * El saludo. Los nombres son un extra: si no se pueden leer, el saludo sale
 * sin ellos ("tu cita") en vez de tumbar la llamada.
 */
async function buildGreeting(
  db: SupabaseClient,
  call: CallRow,
  appointment: CallAppointment | null,
  now: Date,
): Promise<OutboundGreeting> {
  const account = await loadAccountFacts(db, call.accountId)
  if (!appointment) {
    return { business: account.name, patient: null, day: SAMPLE_DAY, time: SAMPLE_TIME, staff: null }
  }

  const [staffName, patient] = await Promise.all([
    appointment.staffId ? loadStaffName(db, call.accountId, appointment.staffId).catch(() => null) : null,
    // Solo una clínica nombra al paciente; las demás dicen "tu cita".
    account.clinic
      ? loadClinicReminderInfo(db, {
          accountId: call.accountId,
          appointmentId: appointment.id,
          contactId: appointment.contactId,
        })
          .then((info) => info.patientName)
          .catch(() => null)
      : null,
  ])
  const when = spokenWhen(appointment.startsAt, now)
  return {
    business: account.name,
    patient,
    day: when.day,
    time: when.time,
    staff: spokenStaff(staffName) || null,
  }
}

/** A quién pasar la llamada con la tecla 3: solo en horario de atención y con asesores. */
function pickAdvisors(
  settings: CallSettings,
  call: CallRow,
  test: boolean,
  now: Date,
): OutboundFlowContext['advisors'] {
  if (test || settings.advisorPhones.length === 0) return null
  if (!isWithinOfficeHours(settings.officeHours, now)) return null
  const callerId = settings.callerId ?? settings.inboundNumber ?? call.fromNumber
  return callerId ? { phones: settings.advisorPhones, callerId } : null
}

// ------------------------------------------------------------
// Escrituras de la llamada
// ------------------------------------------------------------

/** Primer pedido de la llamada: guarda el CallSid y la marca en curso. Solo escribe lo que falta. */
async function touchCall(db: SupabaseClient, call: CallRow, callSid: string | undefined): Promise<void> {
  if (callSid && !call.providerCallSid) {
    await db.from('booking_calls').update({ provider_call_sid: callSid.slice(0, 100) }).eq('id', call.id).is('provider_call_sid', null)
  }
  if (call.status === 'queued' || call.status === 'calling') {
    await db.from('booking_calls').update({ status: 'in_progress' }).eq('id', call.id).in('status', ['queued', 'calling'])
  }
}

async function noteInactive(db: SupabaseClient, call: CallRow): Promise<void> {
  try {
    await db
      .from('booking_calls')
      .update({ error: CALL_NOTICES.appointmentInactive })
      .eq('id', call.id)
      .is('error', null)
  } catch {
    // Es una nota para la recepción; la respuesta al paciente no depende de ella.
  }
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------

export async function handleOutboundWebhook(args: OutboundWebhookArgs): Promise<OutboundWebhookResult> {
  const { db, query, form, now, deps } = args

  const call = await loadCallRow(db, args.callId)
  if (!call || call.direction !== 'outbound') return { xml: hangupOnlyXml(), deferred: [] }

  await touchCall(db, call, form.CallSid)

  const settings = await loadCallSettings(db, call.accountId)
  const voice = resolveVoice(settings)

  // Ya tiene resultado: un reintento recibe la misma despedida, sin efectos.
  if (call.outcome) return { xml: replayXml(call.outcome, voice), deferred: [] }

  // Una llamada de prueba no tiene cita; el resto necesita una activa.
  const test = call.appointmentId === null
  let appointment: CallAppointment | null = null
  if (call.appointmentId) {
    appointment = await loadCallAppointment(db, call.accountId, call.appointmentId)
    if (!appointment || !isActiveAppointment(appointment, now)) {
      await noteInactive(db, call)
      return { xml: inactiveXml(voice), deferred: [] }
    }
  }

  const step = readStep(query.get('step'))
  const loop = readLoop(query.get('loop'))
  const path = readMenuPath(query.get('path'))
  const digits = form.Digits?.trim() || null

  // El saludo completo solo se dice en la primera vuelta del menú.
  const greeting =
    step === 'menu' && loop === 1 && digits === null ? await buildGreeting(db, call, appointment, now) : null

  const flow = outboundFlow(
    { step, loop, digits, path },
    {
      voice,
      greeting,
      test,
      advisors: pickAdvisors(settings, call, test, now),
      urls: {
        step: (nextStep, nextLoop, nextPath) =>
          voiceUrl(OUTBOUND_WEBHOOK_PATH, {
            call: call.id,
            step: nextStep,
            loop: nextLoop,
            path: nextPath === '' ? undefined : nextPath,
          }),
        dialResult: voiceUrl(DIAL_RESULT_PATH, { call: call.id }),
      },
    },
  )

  // Se escribe el valor (no se agrega a lo anterior): repetirlo da lo mismo.
  if (flow.digits !== null) {
    await updateCall(db, call.id, { digits: flow.digits, menu_path: flow.path === '' ? null : flow.path })
  }

  if (!flow.effect) return { xml: flow.xml, deferred: [] }

  const result = await applyOutboundEffect(flow.effect, { db, now, call, appointment, deps })
  return { xml: result.failed ? failureXml(voice) : flow.xml, deferred: result.deferred }
}
