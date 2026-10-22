// ============================================================
// Controlador de reservas por WhatsApp — agenda.
//
//   hola/cita → sesión (booking_sessions) → servicios → barbero
//   (o "Cualquiera") → días con cupo → horas → preguntas extra del
//   negocio (si hay) → resumen → Confirmar / Reprogramar / Cancelar → cita confirmed + negocio
//   en el pipeline Barbería + etiqueta + evento.
//
// Principios (todos verificados por controller.test.ts):
//   - El flujo es DETERMINISTA: la IA nunca decide disponibilidad
//     ni crea citas; cada paso es un menú de botón/lista y la
//     respuesta se resuelve contra el último menú ofrecido.
//   - Toda hora se recalcula al mostrarla, al crear el resumen y
//     al confirmar: si se ocupó, se avisa y se ofrecen alternativas.
//     El EXCLUDE de la base (23P01) es la última red de seguridad.
//   - Todo se guarda en UTC (timestamptz); días y horas se
//     calculan y muestran en America/Bogota.
//   - La sesión expira a los 15 minutos de inactividad y cada
//     mensaje la refresca.
//   - 'asesor' / 'humano' / 'persona' o dos respuestas inválidas
//     seguidas → handoff: IA en pausa, tag quiere-humano, aviso al
//     equipo y mensaje claro al cliente.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { VerticalDispatchResult, VerticalSession } from '@/lib/verticals/types'

import type { AgendaAppointmentSummary } from '../texts'
import { mergeBotTexts, type AgendaAgentTextsMerged } from '../bot-texts'
import { listQuestions } from '../config-repo'
import { capitalize } from '../labels'
import { validateAnswer, type AgendaQuestion } from '../questions'
import {
  computeDaySlots,
  mergeSlotsByStart,
  type MergedSlot,
} from './availability'
import {
  applyContactTag,
  cancelAppointment,
  claimSession,
  closeSession,
  createSession,
  expireStaleSessions,
  findNextAppointment,
  insertAppointment,
  insertBookingEvent,
  insertNotification,
  isStaffFree,
  listBusy,
  listEligibleStaff,
  listServices,
  listWorkBlocks,
  loadAccount,
  loadAppointment,
  loadBotSettings,
  loadContact,
  hasRecentBookingEvent,
  loadConversationAssignee,
  loadConversationOwnership,
  loadHandoffAgentId,
  loadInboundMessage,
  loadStaffName,
  markAppointmentConfirmed,
  markConversationHandoff,
  releaseSession,
  updateSession,
  upsertAgendaDeal,
  type AccountInfo,
  type AppointmentInfo,
  type BotSettings,
  type BusyRow,
  type ServiceInfo,
  type StaffInfo,
  type WorkBlockRow,
} from './db'
import { formatDayLabel, formatLongDate, formatPrice, formatTimeLabel, truncate } from './format'
import {
  actId,
  ansId,
  containsHandoffWord,
  containsIntentWord,
  dayId,
  matchAnswerOption,
  matchChoice,
  newBookingState,
  parseOptionId,
  parseReminderId,
  slotId,
  staffId,
  svcId,
  type BookingState,
  type BookingStep,
  type OfferedOption,
  type ReminderAction,
} from './state'
import { addDaysToKey, startOfZonedDay, zonedDateKey, zonedParts } from './time'

/** La sesión muere a los 15 minutos sin actividad. */
export const SESSION_TTL_MS = 15 * 60_000

/** Días hacia adelante que se exploran al ofrecer días. */
export const OFFER_DAYS = 7

/** Meta: máximo de botones y de filas de lista por mensaje. */
const MAX_BUTTONS = 3
const MAX_LIST_OPTIONS = 10
const BUTTON_TITLE_MAX = 20
const LIST_TITLE_MAX = 24
const LIST_DESC_MAX = 72

// ------------------------------------------------------------
// Contrato de envío (inyectable; en producción lo implementa
// meta-send.ts y en tests un grabador)
// ------------------------------------------------------------

export interface AgendaSender {
  sendText(args: { text: string }): Promise<void>
  sendButtons(args: {
    bodyText: string
    buttons: { id: string; title: string }[]
    headerText?: string
    footerText?: string
  }): Promise<void>
  sendList(args: {
    bodyText: string
    buttonLabel: string
    sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[]
    headerText?: string
    footerText?: string
  }): Promise<void>
}

export interface HandleAgendaInboundArgs {
  db: SupabaseClient
  sender: AgendaSender
  /** Reloj inyectable (tests); en producción es la hora real. */
  now?: Date
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  inboundMessageId?: string
  session?: VerticalSession | null
  /**
   * Un humano es dueño del hilo (agente asignado o bot en pausa). Solo
   * se atienden los taps del recordatorio y la confirmación de una
   * cancelación abierta desde él; todo lo demás es del humano.
   */
  humanOwned?: boolean
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------

export async function handleAgendaInbound(
  args: HandleAgendaInboundArgs,
): Promise<VerticalDispatchResult> {
  const now = args.now ?? new Date()

  const inbound = args.inboundMessageId
    ? await loadInboundMessage(
        args.db,
        args.conversationId,
        args.inboundMessageId,
      )
    : null
  const text = inbound?.text ?? ''
  const replyId = inbound?.replyId ?? null
  const reminderAction = replyId ? parseReminderId(replyId) : null
  const humanOwned = args.humanOwned === true

  // Hilo de un humano: antes de cargar nada más, soltar todo lo que no
  // sea respuesta a un mensaje del sistema.
  if (
    humanOwned &&
    !reminderAction &&
    !isCancelConfirmTap(args.session ?? null, replyId)
  ) {
    return { consumed: false }
  }

  const [settings, account] = await Promise.all([
    loadBotSettings(args.db, args.accountId),
    loadAccount(args.db, args.accountId),
  ])
  const dialog: Dialog = {
    db: args.db,
    sender: args.sender,
    now,
    nowIso: now.toISOString(),
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    account,
    settings,
    texts: mergeBotTexts(settings.botTexts, settings.labels),
  }

  // 0) Tap de un recordatorio (Confirmar / Reprogramar / Cancelar).
  //    Los ids `rem:*` son estáticos — también viajan como quick
  //    replies de la plantilla de Meta—, así que la cita se resuelve
  //    como la próxima cita activa del contacto. Se atienden aunque
  //    haya una sesión a medias (y sin abrir una nueva para confirmar),
  //    y también cuando un humano es dueño del hilo (D1).
  if (reminderAction) {
    await handleReminderTap(
      dialog,
      args.session ?? null,
      reminderAction,
      humanOwned,
    )
    return { consumed: true }
  }

  // Hilo de un humano: solo queda el "Sí, cancelar" / "No" de una
  // cancelación que abrió el recordatorio (filtrado arriba).
  if (humanOwned && args.session) {
    await advanceSession(dialog, args.session, { text, replyId })
    return { consumed: true }
  }

  // 1) Pedir un humano gana sobre cualquier paso del flujo.
  if (replyId === null && containsHandoffWord(text)) {
    await performHandoff(dialog, args.session?.id ?? null)
    return { consumed: true }
  }

  // 2) Con sesión activa, el flujo es dueño del mensaje.
  if (args.session) {
    await advanceSession(dialog, args.session, { text, replyId })
    return { consumed: true }
  }

  // 3) Sin sesión: limpiar las vencidas que hayan quedado colgadas.
  await expireStaleSessions(
    args.db,
    args.accountId,
    args.contactId,
    dialog.nowIso,
  )

  // Un tap de un menú viejo no arranca nada (y no se consume).
  if (replyId !== null) return { consumed: false }

  // 4) ¿Quiere agendar? Se abre el diálogo (o la gestión si ya
  //    tiene una cita próxima).
  const { labels } = dialog.settings
  if (!containsIntentWord(text, [labels.cita, labels.citas, labels.servicio, labels.servicios])) {
    return { consumed: false }
  }

  const existing = await findNextAppointment(
    args.db,
    args.accountId,
    args.contactId,
    dialog.nowIso,
  )
  const state = existing
    ? newBookingState('manage_menu', { appointmentId: existing.id })
    : newBookingState('pick_service')

  const sessionId = await openSession(dialog, state)
  await conclude(dialog, sessionId, state)
  return { consumed: true }
}

/**
 * Abre una sesión nueva. Antes expira las vencidas que sigan en
 * 'active' (una reserva abandonada): el índice único de 047 las
 * cuenta aunque el dispatcher ya no las entregue.
 */
async function openSession(dialog: Dialog, state: BookingState): Promise<string> {
  await expireStaleSessions(
    dialog.db,
    dialog.accountId,
    dialog.contactId,
    dialog.nowIso,
  )
  const sessionId = crypto.randomUUID()
  await createSession(dialog.db, {
    id: sessionId,
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    state: toJson(state),
    expiresAtIso: expiryIso(dialog),
  })
  return sessionId
}

// ------------------------------------------------------------
// Recordatorios (taps rem:*) — Fase 3
// ------------------------------------------------------------

/**
 * Acciones Confirmar / Reprogramar / Cancelar del recordatorio.
 *
 * La cita sobre la que se actúa es la PRÓXIMA cita activa del
 * contacto: los botones de la plantilla de Meta no admiten ids
 * dinámicos, así que no viaja el id de la cita en el tap.
 *
 *   - Confirmar: marca la cita y responde; no toca la sesión.
 *   - Reprogramar: retoma el flujo existente (`pick_day` en modo
 *     reschedule) reutilizando la fila de sesión si ya había una.
 *   - Cancelar: entra a la confirmación de cancelación existente
 *     (`manage_cancel_confirm`), que ya cancela con etiqueta y evento.
 */
/** ¿Es el tap "Sí, cancelar" / "No" de una confirmación de cancelación abierta? */
function isCancelConfirmTap(
  session: VerticalSession | null,
  replyId: string | null,
): boolean {
  if (!session || !replyId) return false
  if (session.state.step !== 'manage_cancel_confirm') return false
  return replyId === actId('cancel_yes') || replyId === actId('back')
}

async function handleReminderTap(
  dialog: Dialog,
  session: VerticalSession | null,
  action: ReminderAction,
  humanOwned = false,
): Promise<void> {
  const appt = await findNextAppointment(
    dialog.db,
    dialog.accountId,
    dialog.contactId,
    dialog.nowIso,
  )
  if (!appt) {
    await dialog.sender.sendText({
      text: dialog.texts.managedAppointmentGone,
    })
    return
  }

  if (action === 'confirm') {
    try {
      await markAppointmentConfirmed(dialog.db, {
        accountId: dialog.accountId,
        id: appt.id,
        confirmedAtIso: dialog.nowIso,
      })
    } catch (err) {
      console.error('[agenda] confirmar desde el recordatorio falló:', err)
      await dialog.sender.sendText({ text: dialog.texts.confirmError })
      return
    }
    await bestEffort('evento confirmed (recordatorio)', () =>
      insertBookingEvent(dialog.db, {
        accountId: dialog.accountId,
        appointmentId: appt.id,
        event: 'confirmed',
        payload: { via: 'recordatorio' },
      }),
    )

    const service = appt.serviceId
      ? await findService(dialog, appt.serviceId)
      : null
    const staffName = appt.staffId
      ? await loadStaffName(dialog.db, dialog.accountId, appt.staffId)
      : null
    const parts = zonedParts(appt.startsAt)
    await dialog.sender.sendText({
      text: dialog.texts.reminderConfirmed({
        service: service?.name ?? dialog.texts.serviceFallback,
        staff: staffName ?? dialog.texts.staffAnyTitle,
        date: formatLongDate(parts.dateKey),
        time: formatTimeLabel(parts),
      }),
    })
    return
  }

  // Pieza "reprogramar/cancelar" apagada: nada de flujo; lo atiende una
  // persona. Un solo mensaje al cliente (`changesByHuman`).
  if (!dialog.settings.toggles.allowReschedule) {
    await handoffChangeRequest(dialog, appt, action, {
      via: 'recordatorio',
      sessionId: session?.id ?? null,
    })
    return
  }

  // Reprogramar con un humano a cargo: el bot NO abre su flujo encima
  // del agente. Avisa al agente (o al dueño), deja rastro y le dice al
  // cliente que una persona sigue.
  if (action === 'reschedule' && humanOwned) {
    await handoffRescheduleRequest(dialog, appt)
    return
  }

  const state =
    action === 'reschedule'
      ? newBookingState('pick_day', {
          mode: 'reschedule',
          appointmentId: appt.id,
          serviceId: appt.serviceId ?? undefined,
          staffId: rescheduleStaffId(dialog, appt),
        })
      : newBookingState('manage_cancel_confirm', { appointmentId: appt.id })

  const sessionId = session?.id ?? (await openSession(dialog, state))
  await conclude(dialog, sessionId, state)
}

// ------------------------------------------------------------
// Contexto interno
// ------------------------------------------------------------

interface Dialog {
  db: SupabaseClient
  sender: AgendaSender
  now: Date
  nowIso: string
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  account: AccountInfo | null
  /** Palabras, piezas y textos editables de la cuenta, leídos una vez por mensaje. */
  settings: BotSettings
  /**
   * Copy del controlador con las palabras del negocio y los overrides
   * de Configuración ya aplicados (Fase 4).
   */
  texts: AgendaAgentTextsMerged
}

/**
 * Profesional con el que se busca la nueva hora al reprogramar: el de
 * la cita, o cualquiera cuando el negocio no deja elegir (pieza apagada).
 */
function rescheduleStaffId(dialog: Dialog, appt: AppointmentInfo): string {
  return dialog.settings.toggles.chooseStaff ? (appt.staffId ?? 'any') : 'any'
}

function expiryIso(dialog: Dialog): string {
  return new Date(dialog.now.getTime() + SESSION_TTL_MS).toISOString()
}

/** JSON plano para `state` (jsonb en producción, objeto en tests). */
function toJson(state: BookingState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>
}

/** Reconstruye el estado desde `booking_sessions.state`. */
function coerceState(raw: Record<string, unknown>): BookingState {
  return newBookingState((raw.step as BookingStep) ?? 'pick_service', {
    mode: raw.mode === 'reschedule' ? 'reschedule' : 'book',
    options: Array.isArray(raw.options)
      ? (raw.options as OfferedOption[])
      : [],
    fails: Number(raw.fails) || 0,
    ...(typeof raw.serviceId === 'string' ? { serviceId: raw.serviceId } : {}),
    ...(typeof raw.staffId === 'string' ? { staffId: raw.staffId } : {}),
    ...(typeof raw.dateKey === 'string' ? { dateKey: raw.dateKey } : {}),
    ...(typeof raw.slotStartsAt === 'string'
      ? { slotStartsAt: raw.slotStartsAt }
      : {}),
    ...(typeof raw.appointmentId === 'string'
      ? { appointmentId: raw.appointmentId }
      : {}),
    ...(typeof raw.questionId === 'string' ? { questionId: raw.questionId } : {}),
    ...(raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)
      ? { answers: coerceAnswers(raw.answers as Record<string, unknown>) }
      : {}),
  })
}

/** Respuestas guardadas en la sesión: solo textos ('' = opcional sin responder). */
function coerceAnswers(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[id] = value
  }
  return out
}

// ------------------------------------------------------------
// Máquina de estados
// ------------------------------------------------------------

async function advanceSession(
  dialog: Dialog,
  session: VerticalSession,
  input: { text: string; replyId: string | null },
): Promise<void> {
  const state = coerceState(session.state)
  // Las preguntas extra se responden escribiendo (o con la opción tocada): no
  // pasan por el emparejamiento general del menú.
  if (state.step === 'ask_question') {
    await handleAnswer(dialog, session.id, state, input)
    return
  }
  const choice = matchChoice({
    text: input.text,
    replyId: input.replyId,
    options: state.options,
  })
  if (!choice) {
    await registerFail(dialog, session.id, state)
    return
  }
  await handleChoice(dialog, session.id, { ...state, fails: 0 }, choice)
}

/**
 * Respuesta que no empareja con el menú: a la primera se re-pregunta,
 * a la segunda se escala a un humano.
 */
async function registerFail(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
): Promise<void> {
  const fails = state.fails + 1
  if (fails >= 2) {
    await performHandoff(dialog, sessionId)
    return
  }
  const next = { ...state, fails }
  await dialog.sender.sendText({ text: dialog.texts.retry })
  await conclude(dialog, sessionId, next)
}

// ------------------------------------------------------------
// Preguntas extra
//
// El estado sigue la pregunta por ID (no por posición) y se vuelve a
// leer la lista en cada mensaje: el dueño puede reordenar, editar o
// desactivar mientras el cliente responde. "La próxima" es siempre la
// primera, en el orden actual, que aún no tiene respuesta.
// ------------------------------------------------------------

/**
 * Preguntas activas en orden. Si la base falla devuelve null: el que llama
 * sigue SIN preguntas (jamás se pierde una reserva por las preguntas extra).
 */
async function loadQuestions(dialog: Dialog): Promise<AgendaQuestion[] | null> {
  try {
    return await listQuestions(dialog.db, dialog.accountId)
  } catch (err) {
    console.error('[agenda] no se pudieron leer las preguntas extra:', err)
    return null
  }
}

function hasAnswer(answers: Record<string, string> | undefined, id: string): boolean {
  return answers !== undefined && Object.hasOwn(answers, id)
}

function nextUnanswered(
  questions: AgendaQuestion[],
  answers: Record<string, string> | undefined,
): AgendaQuestion | null {
  return questions.find((q) => !hasAnswer(answers, q.id)) ?? null
}

/** Siguiente paso tras elegir la hora o responder: la próxima pregunta o el resumen. */
function stateAfterQuestions(
  state: BookingState,
  questions: AgendaQuestion[] | null,
): BookingState {
  const next = questions ? nextUnanswered(questions, state.answers) : null
  return next
    ? { ...state, step: 'ask_question', questionId: next.id }
    : { ...state, step: 'summary', questionId: undefined }
}

async function handleAnswer(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  input: { text: string; replyId: string | null },
): Promise<void> {
  const questions = await loadQuestions(dialog)
  if (!questions) {
    await conclude(dialog, sessionId, stateAfterQuestions(state, null))
    return
  }

  const question = questions.find((q) => q.id === state.questionId)
  if (!question) {
    // La desactivaron (o la borraron): este mensaje no era para ninguna
    // pregunta vigente, así que no se consume. Sigue la próxima o el resumen.
    await conclude(dialog, sessionId, stateAfterQuestions({ ...state, fails: 0 }, questions))
    return
  }

  // Cambió de tipo desde que se la mostramos (de opciones a texto o al revés):
  // lo que contestó no corresponde a lo que ahora se pregunta. Se repite.
  if ((state.options.length > 0) !== (question.kind === 'opcion')) {
    await conclude(dialog, sessionId, state)
    return
  }

  let value: string
  if (question.kind === 'opcion') {
    const choice = matchAnswerOption({
      text: input.text,
      replyId: input.replyId,
      options: state.options,
    })
    const offered = choice ? state.options.find((o) => o.id === choice) : undefined
    if (!offered) {
      await registerFail(dialog, sessionId, state)
      return
    }
    // Se guarda el título que se ofreció; si el dueño ya lo quitó, se repite.
    if (!question.options.includes(offered.title)) {
      await conclude(dialog, sessionId, state)
      return
    }
    value = offered.title
  } else {
    // Un tap de un menú viejo no responde una pregunta escrita.
    if (input.replyId !== null) {
      await registerFail(dialog, sessionId, state)
      return
    }
    const check = validateAnswer(question, input.text)
    if (!check.ok) {
      const warning =
        check.reason === 'number'
          ? dialog.texts.answerInvalidNumber
          : check.reason === 'too_long'
            ? dialog.texts.answerTooLong
            : dialog.texts.answerRequired
      await dialog.sender.sendText({ text: warning })
      await conclude(dialog, sessionId, state)
      return
    }
    value = check.value
  }

  // '' = pregunta opcional sin responder: queda marcada para no repetirla, pero
  // ni el resumen ni la cita la guardan.
  const answers = { ...state.answers, [question.id]: value }
  await conclude(
    dialog,
    sessionId,
    stateAfterQuestions({ ...state, answers, fails: 0 }, questions),
  )
}

/** Respuestas con texto, en el orden actual de las preguntas vigentes. */
function visibleAnswers(
  questions: AgendaQuestion[],
  answers: Record<string, string> | undefined,
): { id: string; label: string; value: string }[] {
  return questions
    .filter((q) => hasAnswer(answers, q.id) && answers![q.id])
    .map((q) => ({ id: q.id, label: q.label, value: answers![q.id] }))
}

async function handleChoice(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  choice: string,
): Promise<void> {
  const parsed = parseOptionId(choice)

  // Pieza "reprogramar/cancelar" apagada: un menú, una confirmación o
  // una reprogramación abiertos antes de apagarla no son un atajo.
  // Excepción: en el resumen de una reprogramación, "Cancelar" solo
  // descarta el cambio y deja la cita como está (cancelDeclined).
  if (!dialog.settings.toggles.allowReschedule) {
    const value = parsed?.kind === 'act' ? parsed.value : null
    const dropsRescheduleDraft =
      state.step === 'summary' && state.mode === 'reschedule' && value === 'cancel'
    const blocked =
      !dropsRescheduleDraft &&
      (state.mode === 'reschedule' ||
        (state.step === 'manage_menu' && (value === 'reschedule' || value === 'cancel')) ||
        (state.step === 'manage_cancel_confirm' && value === 'cancel_yes'))
    if (blocked) {
      const kind =
        state.mode !== 'reschedule' && (value === 'cancel' || value === 'cancel_yes')
          ? 'cancel'
          : 'reschedule'
      const appt = await loadManagedAppointment(dialog, state)
      if (!appt) {
        await dialog.sender.sendText({
          text: dialog.texts.managedAppointmentGone,
        })
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
        return
      }
      await handoffChangeRequest(dialog, appt, kind, {
        via: 'menu',
        sessionId,
      })
      return
    }
  }

  switch (state.step) {
    case 'pick_service': {
      if (parsed?.kind !== 'svc') break
      const services = await listServices(dialog.db, dialog.accountId)
      const service = services.find((s) => s.id === parsed.value)
      if (!service) break
      const staff = await listEligibleStaff(
        dialog.db,
        dialog.accountId,
        service.id,
      )
      if (!staff.length) {
        await dialog.sender.sendText({
          text: dialog.texts.noStaffForService,
        })
        await conclude(dialog, sessionId, {
          ...state,
          serviceId: service.id,
          staffId: undefined,
          step: 'pick_service',
        })
        return
      }
      if (staff.length === 1 || !dialog.settings.toggles.chooseStaff) {
        await conclude(dialog, sessionId, {
          ...state,
          serviceId: service.id,
          // Con la pieza apagada se asigna al confirmar (resolveCandidates
          // con 'any' prueba a todos los elegibles; el EXCLUDE manda).
          staffId: staff.length === 1 ? staff[0].id : 'any',
          step: 'pick_day',
        })
        return
      }
      await conclude(dialog, sessionId, {
        ...state,
        serviceId: service.id,
        staffId: undefined,
        step: 'pick_staff',
      })
      return
    }

    case 'pick_staff': {
      if (parsed?.kind !== 'staff') break
      const staff = await listEligibleStaff(
        dialog.db,
        dialog.accountId,
        state.serviceId ?? '',
      )
      if (parsed.value !== 'any' && !staff.some((s) => s.id === parsed.value)) {
        break
      }
      await conclude(dialog, sessionId, {
        ...state,
        staffId: parsed.value,
        step: 'pick_day',
      })
      return
    }

    case 'pick_day': {
      if (parsed?.kind !== 'day') break
      const dateKey = parsed.value
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) break
      const slots = await mergedSlotsForDay(dialog, state, dateKey)
      if (!slots.length) {
        await dialog.sender.sendText({ text: dialog.texts.dayTaken })
        await conclude(dialog, sessionId, { ...state, step: 'pick_day' })
        return
      }
      await conclude(dialog, sessionId, {
        ...state,
        dateKey,
        step: 'pick_slot',
      })
      return
    }

    case 'pick_slot': {
      if (parsed?.kind !== 'slot') break
      const startsAtIso = parsed.value
      const dateKey = state.dateKey ?? zonedDateKey(dialog.now)
      const slots = await mergedSlotsForDay(dialog, state, dateKey)
      const slot = slots.find((s) => s.startsAt.toISOString() === startsAtIso)
      if (!slot) {
        await offerAlternatives(dialog, sessionId, state)
        return
      }
      // Cita nueva: preguntas extra del negocio antes del resumen. Reprogramar
      // una existente no las repite (la cita nueva copia las respuestas).
      const questions =
        state.mode === 'reschedule' ? null : await loadQuestions(dialog)
      await conclude(
        dialog,
        sessionId,
        stateAfterQuestions({ ...state, dateKey, slotStartsAt: startsAtIso }, questions),
      )
      return
    }

    case 'summary': {
      if (parsed?.kind !== 'act') break
      if (parsed.value === 'confirm') {
        await confirmAppointment(dialog, sessionId, state)
        return
      }
      if (parsed.value === 'reschedule') {
        // Con otra hora se vuelve a empezar: nada de respuestas viejas.
        await conclude(dialog, sessionId, {
          ...state,
          slotStartsAt: undefined,
          answers: undefined,
          questionId: undefined,
          step: 'pick_day',
        })
        return
      }
      if (parsed.value === 'cancel') {
        const text =
          state.mode === 'reschedule'
            ? dialog.texts.cancelDeclined
            : dialog.texts.draftCancelled
        await dialog.sender.sendText({ text })
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
        return
      }
      break
    }

    case 'manage_menu': {
      if (parsed?.kind !== 'act') break
      if (parsed.value === 'new') {
        await conclude(
          dialog,
          sessionId,
          newBookingState('pick_service'),
        )
        return
      }
      if (parsed.value === 'reschedule') {
        const appt = await loadManagedAppointment(dialog, state)
        if (!appt) {
          await dialog.sender.sendText({
            text: dialog.texts.managedAppointmentGone,
          })
          await closeSession(dialog.db, {
            id: sessionId,
            accountId: dialog.accountId,
            status: 'completed',
            updatedAtIso: dialog.nowIso,
          })
          return
        }
        await conclude(dialog, sessionId, {
          ...newBookingState('pick_day', {
            mode: 'reschedule',
            appointmentId: appt.id,
            serviceId: appt.serviceId ?? undefined,
            staffId: rescheduleStaffId(dialog, appt),
          }),
        })
        return
      }
      if (parsed.value === 'cancel') {
        await conclude(dialog, sessionId, {
          ...state,
          step: 'manage_cancel_confirm',
        })
        return
      }
      break
    }

    case 'manage_cancel_confirm': {
      if (parsed?.kind !== 'act') break
      if (parsed.value === 'back') {
        await dialog.sender.sendText({
          text: dialog.texts.cancelDeclined,
        })
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
        return
      }
      if (parsed.value === 'cancel_yes') {
        const appt = await loadManagedAppointment(dialog, state)
        if (!appt) {
          await dialog.sender.sendText({
            text: dialog.texts.managedAppointmentGone,
          })
          await closeSession(dialog.db, {
            id: sessionId,
            accountId: dialog.accountId,
            status: 'completed',
            updatedAtIso: dialog.nowIso,
          })
          return
        }
        try {
          await cancelAppointment(dialog.db, {
            accountId: dialog.accountId,
            id: appt.id,
            reason: 'cliente',
            cancelledAtIso: dialog.nowIso,
          })
        } catch (err) {
          // La cita sigue viva: avisar y re-ofrecer la confirmación.
          console.error('[agenda] cancelar la cita falló:', err)
          await dialog.sender.sendText({
            text: dialog.texts.confirmError,
          })
          await conclude(dialog, sessionId, state)
          return
        }
        await bestEffort('etiqueta cita-cancelada', () =>
          applyContactTag(dialog.db, {
            accountId: dialog.accountId,
            contactId: dialog.contactId,
            tagName: 'cita-cancelada',
            userId: dialog.configOwnerUserId,
          }),
        )
        await bestEffort('evento cancelled', () =>
          insertBookingEvent(dialog.db, {
            accountId: dialog.accountId,
            appointmentId: appt.id,
            event: 'cancelled',
            payload: { reason: 'cliente' },
          }),
        )
        await dialog.sender.sendText({
          text: dialog.texts.cancelDone,
        })
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
        return
      }
      break
    }
  }

  // Opción que no pinta nada en este paso (menú viejo o datos
  // cambiaron): cuenta como fallo.
  await registerFail(dialog, sessionId, state)
}

// ------------------------------------------------------------
// Confirmación / reprogramación
// ------------------------------------------------------------

async function confirmAppointment(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
): Promise<void> {
  if (!state.slotStartsAt || !state.serviceId) {
    await registerFail(dialog, sessionId, state)
    return
  }
  const service = await findService(dialog, state.serviceId)
  if (!service) {
    await dialog.sender.sendText({ text: dialog.texts.noServices })
    await closeSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      status: 'completed',
      updatedAtIso: dialog.nowIso,
    })
    return
  }

  // En reprogramación la cita anterior debe seguir viva.
  let oldAppt: AppointmentInfo | null = null
  if (state.mode === 'reschedule') {
    oldAppt = await loadManagedAppointment(dialog, state)
    if (!oldAppt) {
      await dialog.sender.sendText({
        text: dialog.texts.managedAppointmentGone,
      })
      await closeSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        status: 'completed',
        updatedAtIso: dialog.nowIso,
      })
      return
    }
  }

  const start = new Date(state.slotStartsAt)
  const end = new Date(start.getTime() + service.durationMinutes * 60_000)

  // Revalidación final: candidatos frescos + barbero libre.
  const candidates = await resolveCandidates(dialog, state, state.slotStartsAt)
  if (!candidates?.length) {
    await offerAlternatives(dialog, sessionId, state)
    return
  }
  let assigned: string | null = null
  for (const candidate of candidates) {
    const free = await isStaffFree(
      dialog.db,
      dialog.accountId,
      candidate,
      start.toISOString(),
      end.toISOString(),
    )
    if (free) {
      assigned = candidate
      break
    }
  }
  if (!assigned) {
    await offerAlternatives(dialog, sessionId, state)
    return
  }

  const answers = await answersForNewAppointment(dialog, state, oldAppt)

  // Un solo ganador por sesión: si otro proceso (un doble tap de
  // "Confirmar") ya la reclamó, ese es el que agenda y responde.
  // Aquí no se inserta nada ni se manda un mensaje que contradiga.
  const claimed = await claimSession(dialog.db, {
    id: sessionId,
    accountId: dialog.accountId,
    updatedAtIso: dialog.nowIso,
  })
  if (!claimed) return

  const appointmentId = crypto.randomUUID()
  const { error } = await insertAppointment(dialog.db, {
    id: appointmentId,
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    conversationId: dialog.conversationId,
    serviceId: service.id,
    staffId: assigned,
    startsAtIso: start.toISOString(),
    endsAtIso: end.toISOString(),
    status: 'confirmed',
    createdVia: 'bot',
    confirmedAtIso: dialog.nowIso,
    rescheduledFrom: oldAppt?.id ?? null,
    answers,
  })

  if (error) {
    // La cita no existe: la sesión vuelve a estar activa para que el
    // cliente pueda elegir otra hora o reintentar.
    await releaseSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      updatedAtIso: dialog.nowIso,
    })
    if (error.code === '23P01') {
      // Choque con el EXCLUDE anti-doble-reserva: alguien ganó la carrera.
      await offerAlternatives(dialog, sessionId, state)
      return
    }
    await dialog.sender.sendText({
      text: dialog.texts.confirmError,
    })
    await conclude(dialog, sessionId, state)
    return
  }

  // Efectos de CRM — mejor esfuerzo: la cita ya existe y el cliente
  // no puede quedarse sin confirmación por un fallo del CRM.
  if (oldAppt) {
    // Crítica: si la cita anterior no se cancela, el cliente quedaría
    // con dos citas. Se deshace la nueva y se re-ofrece el resumen.
    try {
      await cancelAppointment(dialog.db, {
        accountId: dialog.accountId,
        id: oldAppt.id,
        reason: 'reprogramada',
        cancelledAtIso: dialog.nowIso,
      })
    } catch (err) {
      console.error('[agenda] cancelar la cita anterior falló:', err)
      await bestEffort('deshacer la cita nueva', () =>
        cancelAppointment(dialog.db, {
          accountId: dialog.accountId,
          id: appointmentId,
          reason: 'error_reprogramacion',
          cancelledAtIso: dialog.nowIso,
        }),
      )
      await releaseSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        updatedAtIso: dialog.nowIso,
      })
      await dialog.sender.sendText({ text: dialog.texts.confirmError })
      await conclude(dialog, sessionId, state)
      return
    }
    await bestEffort('etiqueta cita-reprogramada', () =>
      applyContactTag(dialog.db, {
        accountId: dialog.accountId,
        contactId: dialog.contactId,
        tagName: 'cita-reprogramada',
        userId: dialog.configOwnerUserId,
      }),
    )
    await bestEffort('evento rescheduled', () =>
      insertBookingEvent(dialog.db, {
        accountId: dialog.accountId,
        appointmentId,
        event: 'rescheduled',
        payload: {
          from_appointment_id: oldAppt!.id,
          from_starts_at: oldAppt!.startsAt.toISOString(),
          to_starts_at: start.toISOString(),
        },
      }),
    )
  } else {
    await bestEffort('etiqueta cita-confirmada', () =>
      applyContactTag(dialog.db, {
        accountId: dialog.accountId,
        contactId: dialog.contactId,
        tagName: 'cita-confirmada',
        userId: dialog.configOwnerUserId,
      }),
    )
    await bestEffort('negocio en el pipeline Agenda', () =>
      upsertAgendaDeal(dialog.db, {
        accountId: dialog.accountId,
        userId: dialog.configOwnerUserId,
        contactId: dialog.contactId,
        conversationId: dialog.conversationId,
        title: `${capitalize(dialog.settings.labels.cita)}: ${service.name}`,
        value: service.price,
        currency: dialog.account?.defaultCurrency ?? 'COP',
        nowIso: dialog.nowIso,
      }),
    )
    await bestEffort('evento confirmed', () =>
      insertBookingEvent(dialog.db, {
        accountId: dialog.accountId,
        appointmentId,
        event: 'confirmed',
        payload: {
          service_id: service.id,
          staff_id: assigned!,
          starts_at: start.toISOString(),
        },
      }),
    )
  }

  // La sesión ya quedó 'completed' al reclamarla (claimSession).
  const staffName = await loadStaffName(dialog.db, dialog.accountId, assigned!)
  const summary = buildSummary(dialog, service, staffName ?? '', start)
  await dialog.sender.sendText({
    text: oldAppt
      ? dialog.texts.rescheduleDone(summary)
      : dialog.texts.confirmed(summary),
  })
}

/** Hora perdida: avisa y re-renderiza el menú de horas. */
async function offerAlternatives(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
): Promise<void> {
  await dialog.sender.sendText({ text: dialog.texts.slotTaken })
  await conclude(dialog, sessionId, {
    ...state,
    slotStartsAt: undefined,
    step: 'pick_slot',
  })
}

/**
 * Barberos que podrían atender el slot: el elegido, o los
 * candidatos frescos si el cliente eligió "Cualquiera". `null`
 * cuando el slot ya no existe.
 */
async function resolveCandidates(
  dialog: Dialog,
  state: BookingState,
  startsAtIso: string,
): Promise<string[] | null> {
  if (state.staffId && state.staffId !== 'any') return [state.staffId]
  if (!state.dateKey) return null
  const slots = await mergedSlotsForDay(dialog, state, state.dateKey)
  const slot = slots.find((s) => s.startsAt.toISOString() === startsAtIso)
  return slot ? slot.staffIds : null
}

// ------------------------------------------------------------
// Render de cada paso
// ------------------------------------------------------------

interface Rendered {
  state: BookingState
  closed: boolean
}

/**
 * Reconstruye y envía el menú del paso actual con datos frescos.
 * Devuelve el estado efectivo: puede haber cambiado de paso (una
 * hora ocupada cae al menú de días) o haberse cerrado (sin
 * servicios, sin días, cita gestionada desaparecida).
 */
async function renderStep(dialog: Dialog, state: BookingState): Promise<Rendered> {
  switch (state.step) {
    case 'pick_service': {
      const services = await listServices(dialog.db, dialog.accountId)
      if (!services.length) {
        await dialog.sender.sendText({
          text: dialog.texts.noServices,
        })
        return { state, closed: true }
      }
      const options: OfferedOption[] = services.map((service) => ({
        id: svcId(service.id),
        title: service.name,
      }))
      await sendOptions(dialog, {
        bodyText: dialog.texts.serviceMenuBody,
        buttonLabel: dialog.texts.serviceMenuButton,
        options: options.map((o, i) => ({
          ...o,
          description: serviceDescription(dialog, services[i]),
        })),
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'pick_staff': {
      const staff = await listEligibleStaff(
        dialog.db,
        dialog.accountId,
        state.serviceId ?? '',
      )
      if (!staff.length) {
        await dialog.sender.sendText({
          text: dialog.texts.noStaffForService,
        })
        return renderStep(dialog, { ...state, step: 'pick_service' })
      }
      const sent = [
        ...staff.map((s) => ({ id: staffId(s.id), title: s.name })),
        {
          id: staffId('any'),
          title: dialog.texts.staffAnyTitle,
          description: dialog.texts.staffAnyDescription,
        },
      ]
      const options: OfferedOption[] = sent.map(({ id, title }) => ({
        id,
        title,
      }))
      await sendOptions(dialog, {
        bodyText: dialog.texts.staffMenuBody,
        buttonLabel: dialog.texts.staffMenuButton,
        options: sent,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'pick_day': {
      const days = await dayOptions(dialog, state)
      if (!days.length) {
        await dialog.sender.sendText({
          text: dialog.texts.noDaysAvailable,
        })
        return { state, closed: true }
      }
      const options: OfferedOption[] = days.map((day) => ({
        id: dayId(day.key),
        title: day.label,
      }))
      await sendOptions(dialog, {
        bodyText:
          state.mode === 'reschedule'
            ? dialog.texts.rescheduleStart
            : dialog.texts.dayMenuBody,
        buttonLabel: dialog.texts.dayMenuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'pick_slot': {
      const dateKey = state.dateKey
      if (!dateKey) return renderStep(dialog, { ...state, step: 'pick_day' })
      const slots = await mergedSlotsForDay(dialog, state, dateKey)
      if (!slots.length) {
        await dialog.sender.sendText({ text: dialog.texts.dayTaken })
        return renderStep(dialog, {
          ...state,
          dateKey: undefined,
          slotStartsAt: undefined,
          step: 'pick_day',
        })
      }
      const shown = slots.slice(0, MAX_LIST_OPTIONS)
      const options: OfferedOption[] = shown.map((slot: MergedSlot) => ({
        id: slotId(slot.startsAt.toISOString()),
        title: slot.label,
      }))
      await sendOptions(dialog, {
        bodyText: dialog.texts.slotMenuBody(formatLongDate(dateKey)),
        buttonLabel: dialog.texts.slotMenuButton,
        options,
        footerText:
          slots.length > shown.length
            ? dialog.texts.optionsTruncated
            : undefined,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'ask_question': {
      const questions = await loadQuestions(dialog)
      // Su pregunta sigue vigente; si no, la próxima sin responder (o el resumen).
      const question = questions
        ? (questions.find((q) => q.id === state.questionId) ??
          nextUnanswered(questions, state.answers))
        : null
      if (!question) {
        return renderStep(dialog, { ...state, step: 'summary', questionId: undefined })
      }
      if (question.kind === 'opcion') {
        const options: OfferedOption[] = question.options.map((title, i) => ({
          id: ansId(i),
          title,
        }))
        await sendOptions(dialog, {
          bodyText: question.label,
          buttonLabel: dialog.texts.answerMenuButton,
          options,
        })
        return { state: { ...state, questionId: question.id, options }, closed: false }
      }
      await dialog.sender.sendText({ text: question.label })
      return { state: { ...state, questionId: question.id, options: [] }, closed: false }
    }

    case 'summary': {
      const built = await buildSummaryForState(dialog, state)
      if (!built) {
        return renderStep(dialog, newBookingState('pick_service'))
      }
      const options: OfferedOption[] = [
        { id: actId('confirm'), title: dialog.texts.summaryConfirm },
        {
          id: actId('reschedule'),
          title: dialog.texts.summaryReschedule,
        },
        { id: actId('cancel'), title: dialog.texts.summaryCancel },
      ]
      await sendButtons(dialog, {
        bodyText: dialog.texts.summaryBody(built),
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'manage_menu': {
      const appt = await loadManagedAppointment(dialog, state)
      if (!appt) {
        await dialog.sender.sendText({
          text: dialog.texts.managedAppointmentGone,
        })
        return { state, closed: true }
      }
      const service = appt.serviceId
        ? await findService(dialog, appt.serviceId)
        : null
      const parts = zonedParts(appt.startsAt)
      const options: OfferedOption[] = [
        { id: actId('new'), title: dialog.texts.manageNew },
        ...(dialog.settings.toggles.allowReschedule
          ? [
              {
                id: actId('reschedule'),
                title: dialog.texts.manageReschedule,
              },
              { id: actId('cancel'), title: dialog.texts.manageCancel },
            ]
          : []),
      ]
      const menuBody = dialog.settings.toggles.allowReschedule
        ? dialog.texts.manageMenuBody
        : dialog.texts.manageMenuBodyNoChanges
      await sendButtons(dialog, {
        bodyText: menuBody({
          service: service?.name ?? dialog.texts.serviceFallback,
          date: formatLongDate(parts.dateKey),
          time: formatTimeLabel(parts),
        }),
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'manage_cancel_confirm': {
      const appt = await loadManagedAppointment(dialog, state)
      if (!appt) {
        await dialog.sender.sendText({
          text: dialog.texts.managedAppointmentGone,
        })
        return { state, closed: true }
      }
      const parts = zonedParts(appt.startsAt)
      const options: OfferedOption[] = [
        { id: actId('cancel_yes'), title: dialog.texts.cancelYes },
        { id: actId('back'), title: dialog.texts.cancelNo },
      ]
      await sendButtons(dialog, {
        bodyText: dialog.texts.cancelConfirmBody({
          date: formatLongDate(parts.dateKey),
          time: formatTimeLabel(parts),
        }),
        options,
      })
      return { state: { ...state, options }, closed: false }
    }
  }
}

/** Envía el menú del paso y persiste (o cierra) la sesión. */
async function conclude(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
): Promise<void> {
  const { state: effective, closed } = await renderStep(dialog, state)
  if (closed) {
    await closeSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      status: 'completed',
      updatedAtIso: dialog.nowIso,
    })
    return
  }
  await updateSession(dialog.db, {
    id: sessionId,
    accountId: dialog.accountId,
    state: toJson(effective),
    updatedAtIso: dialog.nowIso,
    expiresAtIso: expiryIso(dialog),
  })
}

// ------------------------------------------------------------
// Disponibilidad
// ------------------------------------------------------------

interface AvailabilityCtx {
  service: ServiceInfo | null
  staffIds: string[]
  blocks: WorkBlockRow[]
  busy: BusyRow[]
  now: Date
}

async function loadAvailabilityContext(
  dialog: Dialog,
  state: BookingState,
  fromKey: string,
  days: number,
): Promise<AvailabilityCtx> {
  const service = await findService(dialog, state.serviceId)
  if (!service) {
    return { service: null, staffIds: [], blocks: [], busy: [], now: dialog.now }
  }
  const staff: Pick<StaffInfo, 'id'>[] =
    state.staffId && state.staffId !== 'any'
      ? [{ id: state.staffId }]
      : await listEligibleStaff(dialog.db, dialog.accountId, service.id)
  const staffIds = staff.map((s) => s.id)
  if (!staffIds.length) {
    return { service, staffIds: [], blocks: [], busy: [], now: dialog.now }
  }
  const fromIso = startOfZonedDay(fromKey).toISOString()
  const toIso = startOfZonedDay(addDaysToKey(fromKey, days)).toISOString()
  const [blocks, busy] = await Promise.all([
    listWorkBlocks(dialog.db, dialog.accountId, staffIds),
    listBusy(dialog.db, dialog.accountId, staffIds, fromIso, toIso),
  ])
  return { service, staffIds, blocks, busy, now: dialog.now }
}

function slotsForDay(ctx: AvailabilityCtx, dateKey: string): MergedSlot[] {
  if (!ctx.service || !ctx.staffIds.length) return []
  const sets = ctx.staffIds.map((sid) => ({
    staffId: sid,
    slots: computeDaySlots({
      dateKey,
      durationMinutes: ctx.service!.durationMinutes,
      workBlocks: ctx.blocks.filter((b) => b.staffId === sid),
      busy: ctx.busy.filter((b) => b.staffId === sid),
      now: ctx.now,
    }),
  }))
  return mergeSlotsByStart(sets)
}

async function mergedSlotsForDay(
  dialog: Dialog,
  state: BookingState,
  dateKey: string,
): Promise<MergedSlot[]> {
  const ctx = await loadAvailabilityContext(dialog, state, dateKey, 1)
  return slotsForDay(ctx, dateKey)
}

/** Próximos días (hasta 7) que tienen al menos una hora ofrecible. */
async function dayOptions(
  dialog: Dialog,
  state: BookingState,
): Promise<{ key: string; label: string }[]> {
  const todayKey = zonedDateKey(dialog.now)
  const keys: string[] = []
  for (let i = 0; i < OFFER_DAYS; i += 1) keys.push(addDaysToKey(todayKey, i))

  const ctx = await loadAvailabilityContext(dialog, state, keys[0], OFFER_DAYS)
  const out: { key: string; label: string }[] = []
  for (let i = 0; i < keys.length; i += 1) {
    if (!slotsForDay(ctx, keys[i]).length) continue
    const label =
      i === 0
        ? dialog.texts.dayToday
        : i === 1
          ? dialog.texts.dayTomorrow
          : formatDayLabel(keys[i])
    out.push({ key: keys[i], label })
  }
  return out
}

// ------------------------------------------------------------
// Resumen
// ------------------------------------------------------------

async function findService(
  dialog: Dialog,
  serviceId: string | undefined,
): Promise<ServiceInfo | null> {
  if (!serviceId) return null
  const services = await listServices(dialog.db, dialog.accountId)
  return services.find((s) => s.id === serviceId) ?? null
}

async function loadManagedAppointment(
  dialog: Dialog,
  state: BookingState,
): Promise<AppointmentInfo | null> {
  if (!state.appointmentId) return null
  const appt = await loadAppointment(
    dialog.db,
    dialog.accountId,
    dialog.contactId,
    state.appointmentId,
  )
  if (!appt) return null
  if (appt.status !== 'pending' && appt.status !== 'confirmed') return null
  return appt
}

function buildSummary(
  dialog: Dialog,
  service: ServiceInfo,
  staffName: string,
  start: Date,
): AgendaAppointmentSummary {
  const parts = zonedParts(start)
  return {
    service: service.name,
    staff: staffName,
    date: formatLongDate(parts.dateKey),
    time: formatTimeLabel(parts),
    price: dialog.settings.toggles.showPrice
      ? formatPrice(service.price, dialog.account?.defaultCurrency ?? 'COP')
      : null,
  }
}

async function buildSummaryForState(
  dialog: Dialog,
  state: BookingState,
): Promise<AgendaAppointmentSummary | null> {
  if (!state.slotStartsAt) return null
  const service = await findService(dialog, state.serviceId)
  if (!service) return null
  // Sin la pieza "elegir profesional" el resumen nunca muestra la línea
  // (vacía = se omite): el nombre real llega al confirmar.
  let staffName = ''
  if (dialog.settings.toggles.chooseStaff) {
    staffName =
      state.staffId && state.staffId !== 'any'
        ? ((await loadStaffName(dialog.db, dialog.accountId, state.staffId)) ??
          dialog.texts.staffAnyTitle)
        : dialog.texts.staffAnyTitle
  }
  const summary = buildSummary(dialog, service, staffName, new Date(state.slotStartsAt))
  // Las respuestas a las preguntas extra, en el orden actual (solo cita nueva).
  if (state.mode === 'reschedule' || !state.answers) return summary
  const questions = await loadQuestions(dialog)
  const answers = questions ? visibleAnswers(questions, state.answers) : []
  return answers.length
    ? { ...summary, answers: answers.map(({ label, value }) => ({ label, value })) }
    : summary
}

/**
 * Respuestas que lleva la cita nueva. Reprogramar una cita existente copia las
 * de la anterior; una cita nueva guarda las del estado, acotadas a las
 * preguntas vigentes (si no se pueden leer, las que ya tenía).
 */
async function answersForNewAppointment(
  dialog: Dialog,
  state: BookingState,
  oldAppt: AppointmentInfo | null,
): Promise<Record<string, string>> {
  if (oldAppt) return oldAppt.answers
  if (!state.answers) return {}
  const questions = await loadQuestions(dialog)
  if (!questions) return state.answers
  return Object.fromEntries(visibleAnswers(questions, state.answers).map((a) => [a.id, a.value]))
}

/** Descripción de la fila del menú según las piezas duración / precio. */
function serviceDescription(dialog: Dialog, service: ServiceInfo): string | undefined {
  const { showPrice, showDuration } = dialog.settings.toggles
  const parts: string[] = []
  if (showDuration) parts.push(`${service.durationMinutes} min`)
  if (showPrice) {
    parts.push(formatPrice(service.price, dialog.account?.defaultCurrency ?? 'COP'))
  }
  return parts.length ? parts.join(' • ') : undefined
}

// ------------------------------------------------------------
// Envío de menús (botones ≤3, lista ≤10)
// ------------------------------------------------------------

async function sendOptions(
  dialog: Dialog,
  args: {
    bodyText: string
    buttonLabel: string
    options: (OfferedOption & { description?: string })[]
    footerText?: string
  },
): Promise<void> {
  const { options } = args
  if (options.length <= MAX_BUTTONS) {
    await dialog.sender.sendButtons({
      bodyText: args.bodyText,
      buttons: options.map((o) => ({
        id: o.id,
        title: truncate(o.title, BUTTON_TITLE_MAX),
      })),
      footerText: args.footerText,
    })
    return
  }
  const shown = options.slice(0, MAX_LIST_OPTIONS)
  const truncated = options.length > shown.length
  await dialog.sender.sendList({
    bodyText: args.bodyText,
    buttonLabel: truncate(args.buttonLabel, BUTTON_TITLE_MAX),
    sections: [
      {
        rows: shown.map((o) => ({
          id: o.id,
          title: truncate(o.title, LIST_TITLE_MAX),
          ...(o.description
            ? { description: truncate(o.description, LIST_DESC_MAX) }
            : {}),
        })),
      },
    ],
    footerText:
      args.footerText ??
      (truncated ? dialog.texts.optionsTruncated : undefined),
  })
}

async function sendButtons(
  dialog: Dialog,
  args: { bodyText: string; options: OfferedOption[] },
): Promise<void> {
  await dialog.sender.sendButtons({
    bodyText: args.bodyText,
    buttons: args.options.map((o) => ({
      id: o.id,
      title: truncate(o.title, BUTTON_TITLE_MAX),
    })),
  })
}

// ------------------------------------------------------------
// Handoff
// ------------------------------------------------------------

/**
 * Escala a un humano: pausa la IA (los gates del dispatcher y del
 * auto-reply cortan el hilo a partir de aquí), etiqueta, asigna al
 * agente de handoff si está configurado, avisa al dueño y cierra la
 * sesión de reservas. El mensaje al cliente va al final: si algo
 * anterior falla, el error sube y el cliente no recibe una promesa
 * que no se cumplió.
 */
async function performHandoff(
  dialog: Dialog,
  sessionId: string | null,
): Promise<void> {
  await markConversationHandoff(dialog.db, {
    accountId: dialog.accountId,
    conversationId: dialog.conversationId,
    note: dialog.texts.handoffNote,
    agentId: await loadHandoffAgentId(dialog.db, dialog.accountId),
  })

  await bestEffort('etiqueta quiere-humano', () =>
    applyContactTag(dialog.db, {
      accountId: dialog.accountId,
      contactId: dialog.contactId,
      tagName: 'quiere-humano',
      userId: dialog.configOwnerUserId,
    }),
  )

  // El trigger de asignación avisa al agente; el dueño recibe su
  // aviso aquí para que el equipo lo vea aunque no haya agente.
  const agentId = await loadHandoffAgentId(dialog.db, dialog.accountId)
  const owner = dialog.account?.ownerUserId ?? null
  if (owner && owner !== agentId) {
    const contact = await loadContact(
      dialog.db,
      dialog.accountId,
      dialog.contactId,
    )
    const who = contact?.name?.trim() || contact?.phone || 'Un cliente'
    await bestEffort('aviso de handoff al equipo', () =>
      insertNotification(dialog.db, {
        accountId: dialog.accountId,
        userId: owner,
        conversationId: dialog.conversationId,
        contactId: dialog.contactId,
        title: dialog.texts.handoffNotificationTitle,
        body: dialog.texts.handoffNotificationBody(who),
      }),
    )
  }

  if (sessionId) {
    await closeSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      status: 'cancelled',
      updatedAtIso: dialog.nowIso,
    })
  }

  await dialog.sender.sendText({ text: dialog.texts.handoff })
}

/**
 * D1 — "Reprogramar" del recordatorio cuando un humano es dueño del
 * hilo: avisa al agente asignado (o al dueño si nadie está asignado),
 * registra el intento en booking_events y le responde al cliente que
 * una persona continúa. La cita no se toca.
 */
async function handoffRescheduleRequest(
  dialog: Dialog,
  appt: AppointmentInfo,
): Promise<void> {
  const assignee = await loadConversationAssignee(
    dialog.db,
    dialog.accountId,
    dialog.conversationId,
  )
  const notifyUserId = assignee ?? dialog.account?.ownerUserId ?? null
  const parts = zonedParts(appt.startsAt)
  const date = formatLongDate(parts.dateKey)
  const time = formatTimeLabel(parts)

  if (notifyUserId) {
    const contact = await loadContact(
      dialog.db,
      dialog.accountId,
      dialog.contactId,
    )
    const who = contact?.name?.trim() || contact?.phone || 'Un cliente'
    await bestEffort('aviso de reprogramación al agente', () =>
      insertNotification(dialog.db, {
        accountId: dialog.accountId,
        userId: notifyUserId,
        conversationId: dialog.conversationId,
        contactId: dialog.contactId,
        title: dialog.texts.rescheduleRequestNotificationTitle,
        body: dialog.texts.rescheduleRequestNotificationBody({
          who,
          date,
          time,
        }),
      }),
    )
  }

  await bestEffort('evento reschedule_requested', () =>
    insertBookingEvent(dialog.db, {
      accountId: dialog.accountId,
      appointmentId: appt.id,
      event: 'reschedule_requested',
      payload: {
        via: 'recordatorio',
        handled_by: 'humano',
        notified_user_id: notifyUserId,
      },
    }),
  )

  await dialog.sender.sendText({
    text: dialog.texts.rescheduleHandedToHuman,
  })
}

/** Ventana en la que un segundo tap sobre la misma cita no repite el aviso. */
const CHANGE_REQUEST_DEDUPE_MS = 2 * 60 * 1000

/**
 * Pieza "reprogramar/cancelar" apagada: el cliente pidió cambiar su
 * cita y eso lo atiende una persona.
 *
 *   - Idempotente: si ya hay un aviso de la misma clase (reprogramar o
 *     cancelar) para esta cita en los últimos 2 minutos (doble tap), no avisa, no registra y no responde otra vez.
 *   - Nunca le quita el hilo a un humano: solo pausa el bot (y asigna
 *     al agente de handoff, etiqueta y avisa) si nadie es dueño del chat.
 *   - Avisos como en performHandoff: al agente que asignamos lo avisa el
 *     trigger de asignación (027); el dueño recibe el suyo aquí; si ya
 *     había un asignado, se le avisa a él. Nadie recibe dos.
 *   - El mensaje al cliente (UN solo `changesByHuman`) va al final: si
 *     pausar falla, el error sube, la sesión sigue abierta y no se
 *     promete un asesor.
 */
async function handoffChangeRequest(
  dialog: Dialog,
  appt: AppointmentInfo,
  kind: 'reschedule' | 'cancel',
  opts: { via: 'recordatorio' | 'menu'; sessionId: string | null },
): Promise<void> {
  const closeOwnSession = async () => {
    if (!opts.sessionId) return
    await closeSession(dialog.db, {
      id: opts.sessionId,
      accountId: dialog.accountId,
      status: 'cancelled',
      updatedAtIso: dialog.nowIso,
    })
  }

  const alreadyAsked = await hasRecentBookingEvent(dialog.db, {
    accountId: dialog.accountId,
    appointmentId: appt.id,
    events: [kind === 'cancel' ? 'cancel_requested' : 'reschedule_requested'],
    sinceIso: new Date(dialog.now.getTime() - CHANGE_REQUEST_DEDUPE_MS).toISOString(),
  })
  if (alreadyAsked) {
    await closeOwnSession()
    return
  }

  const parts = zonedParts(appt.startsAt)
  const date = formatLongDate(parts.dateKey)
  const time = formatTimeLabel(parts)

  const { assigneeId, humanOwned } = await loadConversationOwnership(
    dialog.db,
    dialog.accountId,
    dialog.conversationId,
  )

  // Quién queda con el hilo y a quién avisa el bot (sin repetidos).
  const owner = dialog.account?.ownerUserId ?? null
  const notify = new Set<string>()
  if (!humanOwned) {
    const agentId = await loadHandoffAgentId(dialog.db, dialog.accountId)
    await markConversationHandoff(dialog.db, {
      accountId: dialog.accountId,
      conversationId: dialog.conversationId,
      note: dialog.texts.changeRequestNote({ action: kind, date, time }),
      agentId,
    })
    await bestEffort('etiqueta quiere-humano', () =>
      applyContactTag(dialog.db, {
        accountId: dialog.accountId,
        contactId: dialog.contactId,
        tagName: 'quiere-humano',
        userId: dialog.configOwnerUserId,
      }),
    )
    if (owner && owner !== agentId) notify.add(owner)
  } else {
    if (assigneeId) notify.add(assigneeId)
    if (owner) notify.add(owner)
  }

  if (notify.size) {
    const contact = await loadContact(
      dialog.db,
      dialog.accountId,
      dialog.contactId,
    )
    const who = contact?.name?.trim() || contact?.phone || 'Un cliente'
    for (const userId of notify) {
      await bestEffort('aviso de cambio de cita al equipo', () =>
        insertNotification(dialog.db, {
          accountId: dialog.accountId,
          userId,
          conversationId: dialog.conversationId,
          contactId: dialog.contactId,
          title: dialog.texts.changeRequestNotificationTitle,
          body: dialog.texts.changeRequestNotificationBody({
            who,
            action: kind,
            date,
            time,
          }),
        }),
      )
    }
  }

  await bestEffort('evento de cambio de cita pedido', () =>
    insertBookingEvent(dialog.db, {
      accountId: dialog.accountId,
      appointmentId: appt.id,
      event: kind === 'cancel' ? 'cancel_requested' : 'reschedule_requested',
      createdAtIso: dialog.nowIso,
      payload: {
        via: opts.via,
        handled_by: 'humano',
        reason: 'allow_reschedule_off',
        notified_user_ids: [...notify],
      },
    }),
  )

  await closeOwnSession()
  await dialog.sender.sendText({ text: dialog.texts.changesByHuman })
}

async function bestEffort(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    console.error(`[agenda] ${label} falló:`, err)
  }
}
