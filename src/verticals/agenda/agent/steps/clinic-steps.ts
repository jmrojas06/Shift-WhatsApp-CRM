// ============================================================
// Pasos del bot clínico: autorización, menú, pacientes y urgencias.
//
// Este archivo no toca la sesión: cada paso devuelve un `ClinicOutcome`
// y el controlador lo aplica. Así los pasos no dependen del controlador
// y el estado sigue teniendo un solo dueño.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { recordConsent } from '@/modules/clinica/consent'
import { validatePatientName } from '@/modules/clinica/patients'
import type { ClinicContext } from '@/modules/clinica/settings'
import type { ClinicTexts } from '@/modules/clinica/texts'

import type { ClinicBackend } from '../backend'
import type { AgendaSender } from '../controller'
import {
  actId,
  containsAnyWord,
  newBookingState,
  normalizeText,
  patId,
  type BookingState,
  type BookingStep,
  type OfferedOption,
  type OptionKind,
  type ReminderAction,
} from '../state'

export interface ClinicStepCtx {
  db: SupabaseClient
  sender: AgendaSender
  backend: ClinicBackend
  clinic: ClinicContext
  texts: ClinicTexts
  accountId: string
  contactId: string
  conversationId: string
  now: Date
  nowIso: string
  inboundMessageId: string | null
  sendOptions(args: {
    bodyText: string
    buttonLabel: string
    options: (OfferedOption & { description?: string })[]
  }): Promise<void>
}

export interface ClinicHandoff {
  kind: 'handoff'
  /** Reemplaza el mensaje de pase a una persona. */
  message?: string
  /** Nota interna del hilo. */
  note?: string
  /** Reemplaza el aviso al equipo. */
  notification?: { title: string; body: (who: string) => string }
}

export type ClinicOutcome =
  /** Sigue en este paso: se muestra y se guarda. */
  | { kind: 'next'; state: BookingState }
  | ClinicHandoff
  /** Termina la conversación con el bot. */
  | { kind: 'done' }
  /** Respuesta inválida: cuenta como fallo. */
  | { kind: 'fail'; message?: string }
  /** Se eligió la cita que esperaba una acción del recordatorio. */
  | { kind: 'reminder'; action: ReminderAction; appointmentId: string }

export interface ClinicRendered {
  state: BookingState
  closed: boolean
}

const CLINIC_STEPS: readonly BookingStep[] = [
  'consent',
  'clinic_menu',
  'urgency',
  'pick_patient',
  'new_patient_name',
  'pick_appointment',
  'marketing_consent',
  'faq_open',
]

export const isClinicStep = (step: BookingStep): boolean => CLINIC_STEPS.includes(step)

const QUESTION_STARTS = [
  'cuanto',
  'cuantos',
  'cuanta',
  'donde',
  'que',
  'como',
  'cual',
  'cuales',
  'tienen',
  'hacen',
  'aceptan',
  'atienden',
  'reciben',
]

/**
 * Quien pide algo no pregunta, aunque lo escriba con signos de pregunta o
 * empiece con "qué" ("Qué pena, necesito una cita"). Sin tildes, como se
 * comparan.
 */
const REQUEST_PHRASES = ['quiero', 'quisiera', 'necesito', 'me das', 'me da', 'puedo agendar']

/**
 * Lo que parece una duda va a la IA aunque nombre una "cita".
 *
 *   1. Un verbo de pedir gana: "¿me das una cita?" abre el menú.
 *   2. Un signo de pregunta es una duda.
 *   3. Sin signo de pregunta, nombrar la cita la pide ("Tienen citas
 *      disponibles"): abre el menú, que tiene "Precios y dudas".
 *   4. Si no, empezar con "cuánto", "dónde", "cómo"... es una duda.
 *
 * `appointmentWords` son las palabras que usa la clínica para sus citas.
 */
export function looksLikeQuestion(
  text: string,
  appointmentWords: readonly string[] = ['cita', 'citas'],
): boolean {
  if (containsAnyWord(text, REQUEST_PHRASES)) return false
  if (text.includes('?') || text.includes('¿')) return true
  if (containsAnyWord(text, appointmentWords)) return false
  const plain = normalizeText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  return QUESTION_STARTS.includes(plain.split(/\s+/)[0] ?? '')
}

/** Con paciente elegido sigue la reserva; una urgencia salta al menú de horas. */
function afterPatient(state: BookingState, patientId: string): BookingState {
  return { ...state, patientId, step: state.urgent ? 'pick_slot' : 'pick_service' }
}

/**
 * Lo que escribe el cliente en el paso del nombre. Un toque de un botón viejo
 * no es un nombre. El nombre es un dato personal: no va a logs ni a avisos.
 */
export async function handlePatientName(
  ctx: ClinicStepCtx,
  state: BookingState,
  input: { text: string; replyId: string | null },
): Promise<ClinicOutcome> {
  const name = input.replyId === null ? validatePatientName(input.text) : ({ ok: false } as const)
  if (!name.ok) return { kind: 'fail', message: ctx.texts.patientNameRetry }
  try {
    const patient = await ctx.backend.createPatient({
      contactId: ctx.contactId,
      fullName: name.value,
    })
    return { kind: 'next', state: afterPatient(state, patient.id) }
  } catch (err) {
    console.error(
      '[clinica] no se pudo registrar al paciente:',
      err instanceof Error ? err.message : 'error desconocido',
    )
    return { kind: 'fail', message: ctx.texts.patientSaveError }
  }
}

export async function renderClinicStep(
  ctx: ClinicStepCtx,
  state: BookingState,
): Promise<ClinicRendered> {
  const { texts } = ctx
  switch (state.step) {
    case 'consent': {
      const options: OfferedOption[] = [
        { id: actId('consent_yes'), title: texts.consentAccept },
        { id: actId('consent_no'), title: texts.consentDecline },
      ]
      await ctx.sendOptions({
        bodyText: ctx.clinic.consentText,
        buttonLabel: texts.menuButton,
        options,
      })
      // Lo que se acaba de mostrar es lo que la respuesta va a registrar.
      return {
        state: {
          ...state,
          options,
          consentText: ctx.clinic.consentText,
          consentVersion: ctx.clinic.consentVersion,
        },
        closed: false,
      }
    }

    case 'clinic_menu': {
      const options: OfferedOption[] = [
        { id: actId('book'), title: texts.menuBook },
        { id: actId('mine'), title: texts.menuMine },
        { id: actId('faq'), title: texts.menuFaq },
        { id: actId('urgent'), title: texts.menuUrgent },
        { id: actId('human'), title: texts.menuHuman },
      ]
      await ctx.sendOptions({
        bodyText: texts.menuBody,
        buttonLabel: texts.menuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'faq_open':
      // El paso existe para que el siguiente texto salga hacia la IA: no hay
      // menú, solo se invita a preguntar.
      await ctx.sender.sendText({ text: texts.faqPrompt })
      return { state: { ...state, options: [] }, closed: false }

    case 'pick_patient': {
      const patients = await ctx.backend.findPatients({ contactId: ctx.contactId })
      // Sin pacientes registrados no hay a quién elegir: se pide el nombre.
      if (!patients.length) {
        return renderClinicStep(ctx, { ...state, step: 'new_patient_name', fails: 0 })
      }
      // Una lista admite 10 filas: 9 pacientes y "Otra persona".
      const options: OfferedOption[] = [
        ...patients.slice(0, 9).map((p) => ({ id: patId(p.id), title: p.fullName })),
        { id: patId('new'), title: texts.patientOther },
      ]
      await ctx.sendOptions({
        bodyText: texts.patientMenuBody,
        buttonLabel: texts.patientMenuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'new_patient_name': {
      // Se espera un texto, no un toque: sin opciones, lo que llegue lo lee
      // `handlePatientName`.
      await ctx.sender.sendText({ text: texts.patientNamePrompt })
      return { state: { ...state, options: [] }, closed: false }
    }

    default:
      return { state, closed: true }
  }
}

export async function handleClinicChoice(
  ctx: ClinicStepCtx,
  state: BookingState,
  parsed: { kind: OptionKind; value: string } | null,
): Promise<ClinicOutcome> {
  const { texts } = ctx
  switch (state.step) {
    case 'consent': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      if (parsed.value !== 'consent_yes' && parsed.value !== 'consent_no') return { kind: 'fail' }
      // Sin el texto que se le mostró no hay qué registrar: se vuelve a mostrar.
      if (!state.consentText || !state.consentVersion) return { kind: 'fail' }
      const granted = parsed.value === 'consent_yes'
      try {
        await recordConsent(ctx.db, {
          accountId: ctx.accountId,
          contactId: ctx.contactId,
          kind: 'datos_sensibles',
          granted,
          textVersion: state.consentVersion,
          textSnapshot: state.consentText,
          source: 'whatsapp',
          messageId: ctx.inboundMessageId,
          createdAtIso: ctx.nowIso,
        })
      } catch (err) {
        console.error('[clinica] no se pudo guardar la autorización:', err)
        return { kind: 'fail', message: texts.consentError }
      }
      if (!granted) {
        return {
          kind: 'handoff',
          message: texts.consentDeclined,
          note: texts.consentDeclinedNote,
        }
      }
      return { kind: 'next', state: newBookingState('clinic_menu') }
    }

    case 'clinic_menu': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      switch (parsed.value) {
        case 'book':
          return { kind: 'next', state: newBookingState('pick_patient') }
        case 'faq':
          return { kind: 'next', state: newBookingState('faq_open') }
        case 'human':
          return { kind: 'handoff' }
        default:
          return { kind: 'fail' }
      }
    }

    case 'pick_patient': {
      if (parsed?.kind !== 'pat') return { kind: 'fail' }
      if (parsed.value === 'new') {
        return { kind: 'next', state: { ...state, step: 'new_patient_name' } }
      }
      // El menú guardado puede ser viejo: manda la base. Solo vale un paciente
      // de este contacto en esta cuenta (el backend lee con las dos).
      const patients = await ctx.backend.findPatients({ contactId: ctx.contactId })
      if (!patients.some((p) => p.id === parsed.value)) return { kind: 'fail' }
      return { kind: 'next', state: afterPatient(state, parsed.value) }
    }

    default:
      return { kind: 'fail' }
  }
}
