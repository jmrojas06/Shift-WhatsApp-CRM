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
import { CLINIC_HUMAN_WORDS, type ClinicTexts } from '@/modules/clinica/texts'

import type { ClinicBackend } from '../backend'
import type { AgendaSender } from '../controller'
import {
  actId,
  containsAnyWord,
  indexOfAnyWord,
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
  /** ¿La IA va a contestar las dudas? Se lee una vez por mensaje. */
  aiAutoReplyOn(): Promise<boolean>
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

/** Adónde va un texto libre en una clínica. */
export type ClinicRoute = 'book' | 'greeting' | 'human' | 'ai'

/** Palabras de cita. Las de la clínica ("turno", "sesión") se suman al llamar. */
const BOOK_WORDS = ['cita', 'citas', 'agendar', 'agenda', 'agendo', 'reservar', 'turno']

/** Quien las usa pide algo. */
const ASKING_WORDS = [
  'quiero',
  'quisiera',
  'necesito',
  'me das',
  'me da',
  'me dan',
  'me pueden',
  'me agendan',
  'puedo',
  'tienen',
  'hay',
  'sacar',
  'pedir',
]

const GREETINGS = ['hola', 'buenas', 'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches']

/** Una de estas antes de la palabra la anula: "no tengo ninguna queja", "gracias por la receta". */
const NEGATIONS_AND_THANKS = [
  'no',
  'ni',
  'nunca',
  'jamas',
  'tampoco',
  'sin',
  'ningun',
  'ninguna',
  'ninguno',
  'nada',
  'gracias',
  'agradezco',
  'agradecido',
  'agradecida',
]

/**
 * Una sola regla para el texto libre de una clínica, en este orden. Lo que no
 * encaja en nada es para la IA: es el valor por defecto, y equivocarse hacia
 * ahí cuesta menos que mandar a alguien al menú o a una persona sin motivo.
 *
 *   1. book: nombra una cita Y la pide (un verbo de pedir), o es un mensaje de
 *      tres palabras o menos ("cita", "una cita hoy").
 *   2. human: trae una palabra de queja, pago o documento sin una negación ni un
 *      agradecimiento antes, y no es una pregunta.
 *   3. greeting: arranca con un saludo y no pasa de cuatro palabras.
 *   4. ai: todo lo demás.
 *
 * La urgencia y la palabra de pase a una persona se miran antes, fuera de aquí.
 * `appointmentWords` son las palabras que usa la clínica para sus citas.
 */
export function routeClinicText(text: string, appointmentWords: readonly string[] = []): ClinicRoute {
  const normalized = normalizeText(text)
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []

  const namesAppointment = containsAnyWord(normalized, [...BOOK_WORDS, ...appointmentWords])
  if (namesAppointment && (words.length <= 3 || containsAnyWord(normalized, ASKING_WORDS))) return 'book'

  const topicAt = indexOfAnyWord(normalized, CLINIC_HUMAN_WORDS)
  const isQuestion = /[?¿]/.test(normalized) || QUESTION_STARTS.includes(words[0] ?? '')
  if (
    topicAt >= 0 &&
    !containsAnyWord(normalized.slice(0, topicAt), NEGATIONS_AND_THANKS) &&
    !isQuestion
  ) {
    return 'human'
  }

  const plain = words.join(' ')
  if (words.length <= 4 && GREETINGS.some((g) => plain === g || plain.startsWith(`${g} `))) return 'greeting'

  return 'ai'
}

/**
 * Un toque en "No acepto" cuando ya había autorizado: queda registrado como
 * rechazo y el hilo pasa a una persona. Qué texto vio la persona al revocar y
 * cómo debe revocarse queda para revisarlo con el abogado: aquí se guarda el
 * texto vigente.
 */
export async function handleConsentRevoked(ctx: ClinicStepCtx): Promise<ClinicHandoff> {
  const { texts } = ctx
  try {
    await recordConsent(ctx.db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      kind: 'datos_sensibles',
      granted: false,
      textVersion: ctx.clinic.consentVersion,
      textSnapshot: ctx.clinic.consentText,
      source: 'whatsapp',
      messageId: ctx.inboundMessageId,
      createdAtIso: ctx.nowIso,
    })
  } catch (err) {
    // El paciente pidió parar: el hilo pasa a una persona de todos modos, y la
    // nota le dice que el registro hay que hacerlo a mano.
    console.error('[clinica] no se pudo registrar la revocación:', err)
    return { kind: 'handoff', message: texts.consentDeclined, note: texts.consentRevokedUnsavedNote }
  }
  return { kind: 'handoff', message: texts.consentDeclined, note: texts.consentRevokedNote }
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
          // Invitar a escribir una duda que nadie va a contestar es peor que pasarla.
          if (!(await ctx.aiAutoReplyOn())) return { kind: 'handoff', note: texts.aiOffNote }
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
