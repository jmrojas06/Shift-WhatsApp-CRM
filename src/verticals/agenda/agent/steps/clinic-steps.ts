// ============================================================
// Pasos del bot clínico: autorización, menú, pacientes y urgencias.
//
// Este archivo no toca la sesión: cada paso devuelve un `ClinicOutcome`
// y el controlador lo aplica. Así los pasos no dependen del controlador
// y el estado sigue teniendo un solo dueño.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { latestConsent, recordConsent } from '@/modules/clinica/consent'
import { validatePatientName } from '@/modules/clinica/patients'
import type { ClinicContext } from '@/modules/clinica/settings'
import { CLINIC_HUMAN_WORDS, type ClinicTexts } from '@/modules/clinica/texts'

import type { ClinicBackend } from '../backend'
import type { AgendaSender } from '../controller'
import type { ServiceInfo } from '../db'
import { formatDayLabel, formatTimeLabel } from '../format'
import {
  actId,
  apptId,
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
import { zonedDateKey, zonedParts } from '../time'

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
  /** Servicio activo por id, con los candidatos que lo atienden; null si ya no hay a quién ofrecer. */
  serviceScope(serviceId: string): Promise<{ service: ServiceInfo; staffIds: string[] } | null>
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

/** Los toques del menú principal (los mismos ids que `renderClinicStep` ofrece). */
const MENU_TAPS: readonly string[] = ['book', 'mine', 'faq', 'urgent', 'human'].map(actId)

/** ¿Es el toque de una opción del menú principal? Vale aunque el menú ya haya vencido. */
export const isClinicMenuTap = (replyId: string | null): replyId is string =>
  replyId !== null && MENU_TAPS.includes(replyId)

/** Quien arranca así pregunta, no pide: "puedo pagar con tarjeta", "dan factura". */
const QUESTION_STARTS = [
  'puedo',
  'puede',
  'pueden',
  'dan',
  'dar',
  'debo',
  'existe',
  'existen',
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

/** Palabras que no piden nada: "ok", "gracias", "listo". */
const CONTENTLESS_WORDS = [
  'ok',
  'okay',
  'oki',
  'listo',
  'vale',
  'gracias',
  'muchas',
  'mil',
  'bueno',
  'bien',
  'perfecto',
  'excelente',
  'genial',
  'entendido',
  'claro',
  'dale',
  'ya',
  'si',
  'no',
  'de',
  'nada',
]

/**
 * Un mensaje corto que no dice nada ("ok", "gracias", "de nada", un 👍): con el menú
 * abierto no es una duda para la IA ni un error, sino alguien que no sabe qué
 * contestar. Se le repite el menú.
 */
export function isContentless(text: string): boolean {
  const words = normalizeText(text).match(WORD) ?? []
  return words.length <= 4 && words.every((word) => CONTENTLESS_WORDS.includes(word))
}

/** Adónde va un texto libre en una clínica. */
export type ClinicRoute = 'book' | 'mine' | 'greeting' | 'human' | 'ai'

/** Dos palabras con las que arranca una pregunta: "tengo que llevar documentos". */
const QUESTION_PHRASES = ['tengo que', 'hay que', 'se puede', 'se debe', 'es necesario']

/** Palabras de cita. Las de la clínica ("turno", "sesión") se suman al llamar. */
const BOOK_WORDS = [
  'cita',
  'citas',
  'agendar',
  'agenda',
  'agendo',
  'reservar',
  'turno',
  'valoracion',
  'cupo',
  'cupos',
]

/**
 * Quien las trae sin una palabra de cita ya habla de la suya: la cancela o la
 * reprograma ("necesito reprogramar").
 */
const CHANGE_WORDS = [
  'cancelar',
  'cancelo',
  'cancela',
  'anular',
  'reprogramar',
  'reagendar',
  'aplazar',
  'posponer',
]

/**
 * Estas solas no hablan de una cita ("quiero cambiar mi número", "mover el
 * carro"): solo cuentan junto a una palabra de cita.
 */
const CHANGE_WITH_APPOINTMENT_WORDS = ['cancelacion', 'cambiar', 'mover']

/** Quejas: no piden una cita ni la cambian, y las atiende una persona. */
const COMPLAINT_WORDS = ['queja', 'quejas', 'reclamo', 'reclamos', 'pqr', 'pqrs']

/**
 * "No puedo ir a la cita", "mi hijo no puede ir": avisar que no va, no pedir una.
 * `puede` y `pueden` cubren al paciente que escribe un familiar.
 */
const CANNOT_ATTEND =
  /\bno (puedo|puede|pueden|podre|podemos|podria|voy a poder) (ir|asistir|llegar|venir|acudir)\b/

/**
 * Quien arranca así pide algo aunque lo escriba como pregunta: "¿puedo cancelar mi
 * cita?", "¿cómo cambio mi cita?". Cualquier otra pregunta sobre cancelar ("¿cuánto
 * cuesta cancelar?", "¿qué pasa si cancelo?") es una duda para la IA.
 */
const REQUEST_STARTS = ['puedo', 'puede', 'pueden', 'como']

/** Quien las usa pide algo. */
const ASKING_WORDS = [
  'quiero',
  'queria',
  'me gustaria',
  'me regala',
  'me regalas',
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

/** Una de estas JUSTO antes de la palabra (dos palabras como mucho) la anula: "no tengo ninguna queja". */
const NEGATIONS = ['no', 'ni', 'nunca', 'jamas', 'tampoco', 'sin', 'ningun', 'ninguna', 'ninguno', 'nada']

/** Un agradecimiento en las tres palabras de antes la anula: "gracias por la receta". */
const THANKS = ['gracias', 'agradezco', 'agradecido', 'agradecida']

/**
 * Una sola regla para el texto libre de una clínica, en este orden. Lo que no
 * encaja en nada es para la IA: es el valor por defecto, y equivocarse hacia
 * ahí cuesta menos que mandar a alguien al menú o a una persona sin motivo.
 *
 *   1. book: nombra una cita Y la pide (un verbo de pedir), o es un mensaje de
 *      tres palabras o menos ("cita", "una cita hoy"), o arranca con la cita y no
 *      es una duda ("cita para mi hijo"). No lo es cancelarla, cambiarla, no
 *      poder ir ni quejarse de ella.
 *   2. human: trae una palabra de queja, pago o documento sin una negación justo
 *      antes (dos palabras) ni un agradecimiento antes (tres), y no es una pregunta.
 *      El saludo del principio no cuenta para saber si es una pregunta.
 *   3. mine: quiere cancelar, cambiar o mover SU cita, o dice que no puede ir
 *      ("quiero cancelar mi cita", "necesito reprogramar"): se le muestran sus
 *      citas. Una pregunta que no sea un pedido ("¿cuánto cuesta cancelar?") es
 *      una duda y va a la IA.
 *   4. greeting: arranca con un saludo y no pasa de cuatro palabras.
 *   5. ai: todo lo demás.
 *
 * La urgencia y la palabra de pase a una persona se miran antes, fuera de aquí.
 * `appointmentWords` son las palabras que usa la clínica para sus citas.
 */
export function routeClinicText(text: string, appointmentWords: readonly string[] = []): ClinicRoute {
  const normalized = normalizeText(text)
  const words = normalized.match(WORD) ?? []
  // Sin el saludo del principio: "hola cuánto vale una radiografía" es una pregunta.
  const body = afterGreeting(words)
  const bodyPlain = body.join(' ')
  const isQuestion =
    /[?¿]/.test(normalized) ||
    QUESTION_STARTS.includes(body[0] ?? '') ||
    QUESTION_PHRASES.some((phrase) => bodyPlain.startsWith(`${phrase} `))

  const bookWords = [...BOOK_WORDS, ...appointmentWords]
  const namesAppointment = containsAnyWord(normalized, bookWords)
  const changesIt =
    containsAnyWord(normalized, CHANGE_WORDS) ||
    (namesAppointment &&
      (containsAnyWord(normalized, CHANGE_WITH_APPOINTMENT_WORDS) || CANNOT_ATTEND.test(normalized)))
  const notABooking = changesIt || containsAnyWord(normalized, COMPLAINT_WORDS)
  if (namesAppointment && !notABooking) {
    const asks = containsAnyWord(normalized, ASKING_WORDS)
    // "cita para mi hijo": arranca con la cita y no pregunta nada.
    const startsWithBooking = containsAnyWord(body[0] ?? '', bookWords)
    const isDoubt = isQuestion || body.some((w) => QUESTION_STARTS.includes(w))
    if (words.length <= 3 || asks || (startsWithBooking && !isDoubt)) return 'book'
  }

  const topicAt = indexOfAnyWord(normalized, CLINIC_HUMAN_WORDS)
  if (topicAt >= 0 && !isQuestion) {
    const before = normalized.slice(0, topicAt).match(WORD) ?? []
    const negated = containsAnyWord(before.slice(-2).join(' '), NEGATIONS)
    const thanked = containsAnyWord(before.slice(-3).join(' '), THANKS)
    if (!negated && !thanked) return 'human'
  }

  if (changesIt) {
    const asksForIt = REQUEST_STARTS.includes(body[0] ?? '') || bodyPlain.startsWith('se puede ')
    if (!isQuestion || asksForIt) return 'mine'
  }

  if (words.length <= 4 && greetingAt(words) !== null) return 'greeting'

  return 'ai'
}

const WORD = /[\p{L}\p{N}]+/gu

/** El saludo con que arranca la lista de palabras (el más largo), o null. */
function greetingAt(words: readonly string[]): string | null {
  const plain = words.join(' ')
  const found = GREETINGS.filter((g) => plain === g || plain.startsWith(`${g} `))
  return found.sort((a, b) => b.length - a.length)[0] ?? null
}

/** Las palabras sin los saludos del principio ("hola, buenas tardes, ..."). */
function afterGreeting(words: readonly string[]): string[] {
  let rest = [...words]
  for (let greeting = greetingAt(rest); greeting; greeting = greetingAt(rest)) {
    rest = rest.slice(greeting.split(' ').length)
  }
  return rest
}

/**
 * Un toque en "No acepto" cuando ya había autorizado: queda registrado como
 * rechazo y el hilo pasa a una persona. Qué texto vio la persona al revocar y
 * cómo debe revocarse queda para revisarlo con el abogado: aquí se guarda el
 * texto vigente.
 */
export async function handleConsentRevoked(ctx: ClinicStepCtx): Promise<ClinicHandoff> {
  const { texts } = ctx
  // El paciente pidió parar: el hilo pasa a una persona de todos modos, y si no
  // se pudo registrar, la nota le dice que el registro hay que hacerlo a mano.
  const note = (await recordConsentRevoked(ctx)) ? texts.consentRevokedNote : texts.consentRevokedUnsavedNote
  return { kind: 'handoff', message: texts.consentDeclined, note }
}

/**
 * Registra el rechazo con el texto vigente. `false` si no se pudo guardar: quien
 * llama decide qué hace, pero la persona ya pidió parar y eso no se pierde en
 * silencio.
 */
export async function recordConsentRevoked(ctx: ClinicStepCtx): Promise<boolean> {
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
    return true
  } catch (err) {
    console.error('[clinica] no se pudo registrar la revocación:', err)
    return false
  }
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

/**
 * Sin cupo hoy (o sin atención de urgencia configurada): el teléfono de turno si
 * lo hay, aviso prioritario a la clínica y el hilo a una persona.
 */
export function urgencyOffHoursHandoff(texts: ClinicTexts, onCallPhone: string | null): ClinicHandoff {
  return {
    kind: 'handoff',
    message: texts.urgencyOffHours(onCallPhone),
    note: texts.urgencyOffHoursNote,
    notification: urgencyNotice(texts),
  }
}

function urgencyHandoff(ctx: ClinicStepCtx): ClinicHandoff {
  return urgencyOffHoursHandoff(ctx.texts, ctx.clinic.location?.onCallPhone ?? null)
}

/**
 * Una urgencia sin signos de alarma, ya en la reserva de hoy, que pidió una
 * persona o no logró agendar (dos respuestas que no se entienden). El mensaje es
 * el pase de siempre; lo que cambia es la nota y que el aviso es el prioritario.
 */
export function urgencyBookingHandoff(texts: ClinicTexts): Omit<ClinicHandoff, 'kind'> {
  return { note: texts.urgencyBookingNote, notification: urgencyNotice(texts) }
}

/** El aviso prioritario al equipo: el mismo en todos los pases de una urgencia. */
const urgencyNotice = (texts: ClinicTexts): NonNullable<ClinicHandoff['notification']> => ({
  title: texts.urgencyNotificationTitle,
  body: texts.urgencyNotificationBody,
})

/**
 * Quien llegó a la autorización desde una urgencia la dejó sin responder (dos
 * respuestas que no se entienden, o dos veces que no se pudo guardar): el pase
 * es el de siempre, pero con el aviso prioritario.
 */
export function urgencyConsentUnansweredHandoff(texts: ClinicTexts): Omit<ClinicHandoff, 'kind'> {
  return { note: texts.urgencyConsentUnansweredNote, notification: urgencyNotice(texts) }
}

/**
 * La persona dijo que le duele y no se supo si es grave: dos respuestas que no
 * se entendieron en los signos de alarma, o pidió una persona en ese paso. No se
 * sigue agendando. El mensaje repite los signos de alarma de la clínica, y el
 * aviso al equipo es el prioritario. Nada más: ni medicamentos ni diagnóstico.
 */
export function urgencyUnconfirmedHandoff(texts: ClinicTexts, alarmText: string): ClinicHandoff {
  return {
    kind: 'handoff',
    message: texts.urgencyPending(alarmText),
    note: texts.urgencyPendingNote,
    notification: urgencyNotice(texts),
  }
}

/** "Sí, tengo alguno": a urgencias, y el equipo recibe el aviso prioritario. */
export function urgencyGoErHandoff(texts: ClinicTexts): ClinicHandoff {
  return {
    kind: 'handoff',
    message: texts.urgencyGoEr,
    note: texts.urgencyNote,
    notification: urgencyNotice(texts),
  }
}

/**
 * Sin signos de alarma: la primera hora de hoy de la atención de urgencia.
 * Sin cupo hoy (fuera de horario o agenda llena) pasa a una persona. Si no se
 * pueden leer las horas, también: quien llegó aquí tiene dolor, y callarse no
 * es una opción.
 */
async function urgencyBooking(ctx: ClinicStepCtx): Promise<ClinicOutcome> {
  const serviceId = ctx.clinic.urgencyServiceId
  if (!serviceId) return urgencyHandoff(ctx)
  try {
    const scope = await ctx.serviceScope(serviceId)
    if (!scope) return urgencyHandoff(ctx)

    const dateKey = zonedDateKey(ctx.now)
    const slots = await ctx.backend.getDaySlots({ ...scope, dateKey, now: ctx.now })
    if (!slots.length) return urgencyHandoff(ctx)

    return {
      kind: 'next',
      state: newBookingState('pick_patient', {
        serviceId: scope.service.id,
        staffId: 'any',
        dateKey,
        urgent: true,
      }),
    }
  } catch (err) {
    console.error(
      '[clinica] no se pudieron leer las horas de la urgencia:',
      err instanceof Error ? err.message : 'error desconocido',
    )
    return urgencyHandoff(ctx)
  }
}

/**
 * "Mis citas": sin citas lo dice y vuelve al menú; con una sola va directo a
 * gestionarla; con varias pregunta cuál. Se lee en vivo: una cita cancelada en
 * recepción no aparece.
 */
async function myAppointments(ctx: ClinicStepCtx): Promise<ClinicOutcome> {
  const upcoming = await ctx.backend.listUpcoming({
    contactId: ctx.contactId,
    nowIso: ctx.nowIso,
  })
  if (!upcoming.length) {
    await ctx.sender.sendText({ text: ctx.texts.noUpcoming })
    return { kind: 'next', state: newBookingState('clinic_menu') }
  }
  if (upcoming.length === 1) {
    return {
      kind: 'next',
      state: newBookingState('manage_menu', { appointmentId: upcoming[0].id }),
    }
  }
  return { kind: 'next', state: newBookingState('pick_appointment') }
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

    case 'pick_appointment': {
      const upcoming = await ctx.backend.listUpcoming({
        contactId: ctx.contactId,
        nowIso: ctx.nowIso,
      })
      if (!upcoming.length) {
        await ctx.sender.sendText({ text: texts.noUpcoming })
        return { state, closed: true }
      }
      // Una lista admite 10 filas. Con 3 o menos van botones, que no llevan
      // descripción: el nombre del paciente tiene que caber en el título y estar
      // también en el cuerpo, donde cabe completo.
      const rows = upcoming.slice(0, 10).map((appt) => {
        const parts = zonedParts(appt.startsAt)
        const when = `${formatDayLabel(parts.dateKey)}, ${formatTimeLabel(parts)}`
        const firstName = appt.patientName?.split(' ')[0]
        return {
          id: apptId(appt.id),
          title: firstName ? `${formatTimeLabel(parts)} ${firstName}` : when,
          description: when,
          line: appt.patientName ? `• ${appt.patientName}: ${when}` : `• ${when}`,
        }
      })
      await ctx.sendOptions({
        bodyText: `${texts.pickAppointmentBody}\n\n${rows.map((r) => r.line).join('\n')}`,
        buttonLabel: texts.pickAppointmentButton,
        options: rows.map(({ id, title, description }) => ({ id, title, description })),
      })
      const options: OfferedOption[] = rows.map(({ id, title }) => ({ id, title }))
      return { state: { ...state, options }, closed: false }
    }

    case 'urgency': {
      const options: OfferedOption[] = [
        { id: actId('alarm_yes'), title: texts.urgencyYes },
        { id: actId('alarm_no'), title: texts.urgencyNo },
      ]
      await ctx.sendOptions({
        bodyText: texts.urgencyBody(ctx.clinic.urgencyAlarmText),
        buttonLabel: texts.menuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
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
        // Quien llegó aquí desde una urgencia ya dijo que le duele: el pase es
        // prioritario, no el de cualquier paciente que no autoriza.
        if (state.afterConsent === 'urgency_book') {
          return {
            kind: 'handoff',
            message: texts.consentDeclined,
            note: texts.urgencyConsentDeclinedNote,
            notification: urgencyNotice(texts),
          }
        }
        return {
          kind: 'handoff',
          message: texts.consentDeclined,
          note: texts.consentDeclinedNote,
        }
      }
      // Quien llegó a la autorización desde una urgencia sigue con su hora de hoy.
      if (state.afterConsent === 'urgency_book') return urgencyBooking(ctx)
      return { kind: 'next', state: newBookingState('clinic_menu') }
    }

    case 'clinic_menu': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      switch (parsed.value) {
        case 'book':
          return { kind: 'next', state: newBookingState('pick_patient') }
        case 'mine':
          return myAppointments(ctx)
        case 'urgent':
          return { kind: 'next', state: newBookingState('urgency') }
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

    case 'pick_appointment': {
      if (parsed?.kind !== 'appt') return { kind: 'fail' }
      // El menú guardado puede ser viejo: manda la base. Solo vale una cita activa
      // y futura de este contacto en esta cuenta (el backend lee con las dos).
      const upcoming = await ctx.backend.listUpcoming({
        contactId: ctx.contactId,
        nowIso: ctx.nowIso,
      })
      if (!upcoming.some((a) => a.id === parsed.value)) return { kind: 'fail' }
      if (state.reminderAction) {
        return { kind: 'reminder', action: state.reminderAction, appointmentId: parsed.value }
      }
      return {
        kind: 'next',
        state: newBookingState('manage_menu', { appointmentId: parsed.value }),
      }
    }

    case 'urgency': {
      if (parsed?.kind !== 'act') return { kind: 'fail' }
      if (parsed.value === 'alarm_yes') return urgencyGoErHandoff(texts)
      // Una negación sin ningún signo ("no, solo me duele"): ni "ve a urgencias" ni agendar.
      if (parsed.value === 'alarm_unsure') {
        return urgencyUnconfirmedHandoff(texts, ctx.clinic.urgencyAlarmText)
      }
      if (parsed.value !== 'alarm_no') return { kind: 'fail' }
      // Primero el cupo: sin cupo hoy (o sin atención de urgencia) no tiene sentido
      // pedir una autorización para agendar. Va el teléfono de turno y el aviso
      // prioritario, sin texto legal.
      const opening = await urgencyBooking(ctx)
      if (opening.kind !== 'next') return opening
      // La urgencia no espera la autorización para mostrar los signos de alarma,
      // pero agendar sí la necesita: se pide ahora y luego sigue la hora de hoy.
      const consent = await latestConsent(ctx.db, {
        accountId: ctx.accountId,
        contactId: ctx.contactId,
        kind: 'datos_sensibles',
      })
      if (!consent?.granted) {
        return { kind: 'next', state: newBookingState('consent', { afterConsent: 'urgency_book' }) }
      }
      return opening
    }

    default:
      return { kind: 'fail' }
  }
}
