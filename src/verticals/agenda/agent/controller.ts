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
//   - Clínica: una palabra de urgencia (o el toque "Tengo una urgencia") gana
//     sobre todo, también sobre la autorización: abre los signos de alarma y,
//     si no responde con claridad, el aviso al equipo es el prioritario.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ModuleKey, VerticalDispatchResult, VerticalSession } from '@/lib/verticals/types'
import { notifyAlert } from '@/lib/ops/alert'
import { aiWillAnswer } from '@/lib/ai/eligibility'
import { latestConsent } from '@/modules/clinica/consent'
import {
  loadClinicContext,
  loadServicePrep,
  type ClinicContext,
  type ClinicContextResult,
} from '@/modules/clinica/settings'
import {
  buildClinicTexts,
  DEFAULT_URGENCY_ALARM_TEXT,
  DEFAULT_URGENCY_WORDS,
  type ClinicTexts,
} from '@/modules/clinica/texts'

import type { AgendaAppointmentSummary } from '../texts'
import { mergeBotTexts, type AgendaAgentTextsMerged } from '../bot-texts'
import { listQuestions } from '../config-repo'
import { capitalize, DEFAULT_LABELS } from '../labels'
import { readAnswerMap, validateAnswer, type AgendaQuestion, type AnswerMap } from '../questions'
import type { MergedSlot } from './availability'
import type { ClinicBackend } from './backend'
import {
  applyContactTag,
  claimSession,
  closeSession,
  createSession,
  expireStaleSessions,
  findNextAppointment,
  insertBookingEvent,
  insertNotification,
  listEligibleStaff,
  listServices,
  loadAccount,
  loadAppointment,
  loadAppointmentClinicLinks,
  loadBotSettings,
  loadContact,
  hasRecentBookingEvent,
  hasRecentNotification,
  loadConversationAssignee,
  loadConversationOwnership,
  loadHandoffAgentId,
  loadInboundMessage,
  loadStaffName,
  markConversationHandoff,
  releaseSession,
  updateSession,
  upsertAgendaDeal,
  type AccountInfo,
  type AppointmentInfo,
  type BotSettings,
  type ServiceInfo,
  type StaffInfo,
} from './db'
import { formatDayLabel, formatLongDate, formatPrice, formatTimeLabel, truncate } from './format'
import { createInternalBackend } from './internal-backend'
import { consentRevocation, type ConsentRevocation } from '@/modules/clinica/revocation'
import { isReminderTemplateName } from './reminders'
import {
  actId,
  ansId,
  ansSkipId,
  containsHandoffWord,
  containsIntentWord,
  dayId,
  detectsUrgency,
  isHandoffOnly,
  isSkipAnswer,
  matchAnswerOption,
  matchAppointmentOption,
  matchChoice,
  newBookingState,
  parseAnswerId,
  parseOptionId,
  parseReminderTap,
  slotId,
  staffId,
  svcId,
  type BookingState,
  type BookingStep,
  type OfferedOption,
  type ReminderAction,
  type ReminderTap,
} from './state'
import {
  handleClinicChoice,
  handleConsentRevoked,
  handlePatientName,
  isClinicMenuTap,
  isClinicStep,
  isContentless,
  recordConsentRevoked,
  renderClinicStep,
  routeClinicText,
  urgencyBookingHandoff,
  urgencyConsentUnansweredHandoff,
  urgencyGoErHandoff,
  urgencyOffHoursHandoff,
  urgencyUnconfirmedHandoff,
  type ClinicHandoff,
  type ClinicOutcome,
  type ClinicStepCtx,
} from './steps/clinic-steps'
import { addDaysToKey, zonedDateKey, zonedParts } from './time'

/** La sesión muere a los 15 minutos sin actividad. */
export const SESSION_TTL_MS = 15 * 60_000

/**
 * Un toque de recordatorio sin id de cita se refiere a la única cita que empieza
 * en menos de esto. Con más de una cita activa y ninguna o varias tan cercanas no
 * dice a cuál se refiere: se pregunta, no se adivina.
 */
const TAP_AMBIGUITY_MS = 72 * 60 * 60 * 1000

/** Días hacia adelante que se exploran al ofrecer días. */
export const OFFER_DAYS = 7

/** Meta: máximo de botones y de filas de lista por mensaje. */
const MAX_BUTTONS = 3
const MAX_LIST_OPTIONS = 10
const BUTTON_TITLE_MAX = 20
const LIST_TITLE_MAX = 24
const LIST_DESC_MAX = 72

/**
 * Quien contesta los signos de alarma puede tardar: está con dolor, o buscando
 * cómo llegar a urgencias. Esa sesión dura 2 horas, no 15 minutos.
 */
export const URGENCY_SESSION_TTL_MS = 2 * 60 * 60_000

/** Días por página: una fila de la lista queda para "Ver más días". */
const DAY_PAGE_SIZE = MAX_LIST_OPTIONS - 1

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
  /** Módulos de la cuenta. Con 'clinica' se prenden los pasos clínicos. */
  modules?: readonly ModuleKey[]
  /** Dónde viven las citas. Por defecto, la Agenda de Shift. */
  backend?: ClinicBackend
  /**
   * ¿La respuesta automática con IA está prendida? Solo la lee la clínica, al
   * soltar una duda o invitar a escribirla. Por defecto, la configuración real.
   */
  aiAutoReplyOn?: () => Promise<boolean>
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
  // Una ETIQUETA ("Confirmar") la puede traer el botón de cualquier otra
  // plantilla o difusión: solo es un toque de recordatorio si el mensaje
  // responde a una plantilla de recordatorio. Los ids `rem:*` los pone este
  // módulo, no necesitan esa comprobación. Sin referencia o con otra
  // plantilla, el mensaje sigue el camino normal.
  const parsedTap = replyId ? parseReminderTap(replyId) : null
  const reminderTap =
    parsedTap && (!parsedTap.viaLabel || isReminderTemplateName(inbound?.repliedTemplateName))
      ? parsedTap
      : null
  const humanOwned = args.humanOwned === true
  const clinicActive = args.modules?.includes('clinica') === true

  // Revocar escribiendo ("ya no autorizo el uso de mis datos", "revoco mi
  // autorización", "quiero que borren mis datos"): solo vale con una autorización
  // vigente y no mientras responde los signos de alarma, donde manda la urgencia.
  let textRevocation: ConsentRevocation | null = null
  if (clinicActive && replyId === null) {
    const detected = consentRevocation(text)
    if (detected && sessionStep(args.session) !== 'urgency') {
      const consent = await latestConsent(args.db, {
        accountId: args.accountId,
        contactId: args.contactId,
        kind: 'datos_sensibles',
      })
      if (consent?.granted) textRevocation = detected
    }
  }

  // "No acepto" es la respuesta al mensaje de la autorización, que es del
  // sistema: retira el permiso aunque el hilo lo lleve una persona. Revocar
  // escribiendo también.
  const revokesConsent = clinicActive && (replyId === actId('consent_no') || textRevocation !== null)

  // Hilo de un humano: antes de cargar nada más, soltar todo lo que no
  // sea respuesta a un mensaje del sistema. El bot no contesta para no pisar a
  // la persona, pero una urgencia en un hilo suyo no puede pasar desapercibida.
  if (
    humanOwned &&
    !reminderTap &&
    !revokesConsent &&
    !isSystemTap(args.session ?? null, replyId)
  ) {
    if (clinicActive) await warnHumanOfUrgency(args, { text, replyId })
    return { consumed: false }
  }

  const [settings, account, clinicResult] = await Promise.all([
    loadBotSettings(args.db, args.accountId),
    loadAccount(args.db, args.accountId),
    clinicActive ? loadClinicContext(args.db, args.accountId) : Promise.resolve(null),
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
    backend: args.backend ?? createInternalBackend({ db: args.db, accountId: args.accountId }),
    clinic: clinicResult?.status === 'ok' ? clinicResult.clinic : null,
    // Con el módulo activo, una configuración que falta o no se pudo leer NO
    // equivale a una cuenta sin clínica: ver el cierre de más abajo.
    clinicUnavailable: clinicResult !== null && clinicResult.status !== 'ok',
    clinicTexts: buildClinicTexts(settings.labels),
    inboundMessageId: args.inboundMessageId ?? null,
    humanOwned,
    aiProbe:
      args.aiAutoReplyOn ??
      (() => aiWillAnswer(args.db, { accountId: args.accountId, conversationId: args.conversationId })),
  }

  // 0) Tap de un recordatorio (Confirmar / Reprogramar / Cancelar).
  //    Los botones llevan `rem:<acción>` o, en una clínica, `rem:<acción>:<cita>`;
  //    una plantilla enviada sin payload devuelve la etiqueta del botón
  //    ("Confirmar"): `parseReminderTap` lee las tres formas. Con el id de la cita
  //    se actúa sobre esa. Sin id, una cuenta sin clínica toma la próxima cita
  //    activa del contacto, y una clínica la única que empieza en 72 h, o pregunta
  //    cuál (`resolveTapAppointment`). Se atienden aunque haya una sesión a medias
  //    (y sin abrir una nueva para confirmar), y también cuando un humano es dueño
  //    del hilo (D1).
  if (reminderTap) {
    await handleReminderTap(dialog, args.session ?? null, reminderTap, humanOwned)
    return { consumed: true }
  }

  // Hilo de un humano: el "No acepto" solo se registra, sin tocar el hilo.
  if (humanOwned && revokesConsent) {
    await revokeConsentInHumanThread(dialog, args.session?.id ?? null, {
      deleteData: textRevocation?.deleteData,
    })
    // Un mensaje que revoca puede traer también un dolor: el aviso de urgencia no se pierde.
    if (textRevocation) await warnHumanOfUrgency(args, { text, replyId })
    return { consumed: true }
  }

  // Hilo de un humano: solo queda el "Sí, cancelar" / "No" de una
  // cancelación que abrió el recordatorio (filtrado arriba).
  if (humanOwned && args.session) {
    await advanceSession(dialog, args.session, { text, replyId })
    return { consumed: true }
  }

  // Clínica sin configuración usable (falta o no se pudo leer): no se sabe qué
  // autorización pedir ni qué urgencias vigilar, y seguir como una agenda
  // normal dejaría la conversación de un paciente a la IA sin su permiso. El
  // bot consume el mensaje y lo deja con una persona. Los toques de
  // recordatorio ya se atendieron arriba, y un hilo que ya es de una persona
  // no llega hasta aquí.
  if (dialog.clinicUnavailable) {
    await handoffClinicUnavailable(dialog, args.session?.id ?? null, { text, replyId })
    return { consumed: true }
  }

  const asking = args.session ? coerceState(args.session.state) : null

  // Un "Sí, tengo alguno" de unos signos que ya no están en pantalla vale igual: sin
  // sesión, sin autorización y en cualquier paso. (En los signos lo lee el paso.)
  if (dialog.clinic && replyId === actId('alarm_yes') && asking?.step !== 'urgency') {
    await performHandoff(dialog, args.session?.id ?? null, urgencyGoErHandoff(dialog.clinicTexts))
    return { consumed: true }
  }

  // Clínica: la urgencia gana sobre todo lo demás, también sobre la autorización,
  // sobre una reserva abierta (la reemplaza) y sobre pedir una persona. Se mira
  // antes de que ningún otro paso lea el mensaje.
  if (dialog.clinic && opensUrgency(dialog.clinic, { text, replyId }, asking)) {
    const state = newBookingState('urgency')
    const sessionId = args.session?.id ?? (await openSession(dialog, state))
    await conclude(dialog, sessionId, state)
    return { consumed: true }
  }

  // Revocar la autorización escribiendo gana sobre cualquier paso (menos los signos
  // de alarma, ya atendidos arriba) y sobre pedir una persona: queda registrado y el
  // chat pasa a una persona con una nota clara. Si pidió borrar sus datos, la nota
  // dice que hay que atenderlo a mano.
  if (dialog.clinic && textRevocation) {
    await performHandoff(
      dialog,
      args.session?.id ?? null,
      await handleConsentRevoked(clinicCtx(dialog), textRevocation),
    )
    return { consumed: true }
  }

  // 1) Pedir un humano gana sobre cualquier paso del flujo. Excepción: mientras
  //    el cliente escribe la respuesta a una pregunta extra de texto, o el nombre
  //    de quien va a asistir, solo cuenta el mensaje que ES la palabra ("es para
  //    una persona mayor" es la respuesta; "Ana Persona" es un nombre).
  const writingAnswer =
    (asking?.step === 'ask_question' && asking.options.length === 0) ||
    asking?.step === 'new_patient_name' ||
    // "Otra persona" es el título de una opción de la lista de pacientes.
    asking?.step === 'pick_patient'
  if (
    replyId === null &&
    (writingAnswer ? isHandoffOnly(text) : containsHandoffWord(text))
  ) {
    // Quien ya dijo que le duele y está contestando los signos de alarma no se
    // queda con un pase cualquiera: el equipo recibe el aviso prioritario.
    await performHandoff(
      dialog,
      args.session?.id ?? null,
      personRequestHandoff(dialog, asking),
    )
    return { consumed: true }
  }

  // Clínica: el texto libre y los toques del menú los enruta una sola regla.
  if (dialog.clinic) {
    return handleClinicInbound(dialog, args.session ?? null, asking, { text, replyId })
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
 * ¿Este mensaje abre los signos de alarma? Un toque en "Tengo una urgencia"
 * siempre: es una decisión de la persona, valga lo que valga el paso. Un texto
 * con una palabra de la clínica o del piso fijo (`detectsUrgency`) también, en
 * TODOS los pasos menos uno: la respuesta a los signos, que lee `matchChoice`.
 * Ni el nombre ni la respuesta a una pregunta extra son una excepción: "no puedo
 * respirar" escrito como nombre no puede quedar registrado como paciente. Una
 * palabra de urgencia se compara entera, así que "Dolores Ruiz" no dispara.
 * Una foto, un audio o un sticker no cuentan.
 */
function opensUrgency(
  clinic: ClinicContext,
  input: { text: string; replyId: string | null },
  current: BookingState | null,
): boolean {
  if (input.replyId !== null) {
    // Un "No, ninguno" de unos signos que ya no están no descarta nada: se vuelve a preguntar.
    if (input.replyId === actId('alarm_no')) return current?.step !== 'urgency'
    return input.replyId === actId('urgent')
  }
  if (isNonTextInbound(input.text)) return false
  return current?.step !== 'urgency' && detectsUrgency(input.text, clinic.urgencyWords)
}

/**
 * Los toques que dicen que hay una urgencia, para el hilo de una persona y para
 * la clínica sin configuración (donde el bot no puede atenderlos): "Tengo una
 * urgencia" y "Sí, tengo alguno" de los signos de alarma.
 */
const URGENT_TAPS: readonly string[] = [actId('urgent'), actId('alarm_yes')]

/** Los signos de alarma de la clínica; sin su configuración, los de siempre. */
function urgencyAlarmText(dialog: Dialog): string {
  return dialog.clinic?.urgencyAlarmText ?? DEFAULT_URGENCY_ALARM_TEXT
}

/**
 * Urgencia en un hilo de una persona: el bot no responde para no pisarla, pero
 * le avisa a quien lo lleva (o al dueño). Corre antes de cargar nada más, así
 * que lee lo suyo. Si la configuración de la clínica falta o no se pudo leer,
 * valen las palabras de siempre: un fallo de lectura nunca silencia el aviso.
 */
async function warnHumanOfUrgency(
  args: HandleAgendaInboundArgs,
  input: { text: string; replyId: string | null },
): Promise<void> {
  const { text, replyId } = input
  // Un toque que no es de urgencias ("Tengo una urgencia", "Sí, tengo alguno"), o un
  // mensaje sin texto, no avisa nada.
  if (replyId !== null ? !URGENT_TAPS.includes(replyId) : isNonTextInbound(text)) return

  await bestEffort('aviso de urgencia a la persona del hilo', async () => {
    if (replyId === null) {
      const result: ClinicContextResult = await loadClinicContext(args.db, args.accountId).catch(
        (err: unknown): ClinicContextResult => {
          console.error('[clinica] no se pudo leer la configuración para vigilar la urgencia:', err)
          return { status: 'error' }
        },
      )
      const words = result.status === 'ok' ? result.clinic.urgencyWords : DEFAULT_URGENCY_WORDS
      if (!detectsUrgency(text, words)) return
    }

    // Un aviso de urgencia por conversación cada 10 minutos: quien escribe "me
    // duele" tres veces seguidas no llena la bandeja de quien lo lleva.
    await notifyThreadHuman(
      args,
      (texts, who) => ({
        title: texts.urgencyNotificationTitle,
        body: texts.urgencyNotificationBody(who),
      }),
      { onceInMinutes: URGENCY_NOTICE_EVERY_MINUTES, now: args.now ?? new Date() },
    )
  })
}

/** Cada cuánto se repite el aviso de urgencia de un mismo chat. */
export const URGENCY_NOTICE_EVERY_MINUTES = 10

/**
 * Avisa a quien lleva un hilo de una persona (el agente asignado o, si nadie lo
 * lleva, el dueño). Cada lectura es opcional: un fallo no impide el aviso.
 * Lanza solo si no se pudo escribir.
 */
async function notifyThreadHuman(
  args: Pick<HandleAgendaInboundArgs, 'db' | 'accountId' | 'conversationId' | 'contactId'>,
  build: (texts: ClinicTexts, who: string) => { title: string; body: string },
  /** Con `onceInMinutes`, no repite un aviso igual de esta conversación en ese tiempo. */
  repeat?: { onceInMinutes: number; now: Date },
): Promise<'sent' | 'repeated' | 'nobody'> {
  const [settings, account, assignee, who] = await Promise.all([
    loadBotSettings(args.db, args.accountId).catch(() => null),
    loadAccount(args.db, args.accountId).catch(() => null),
    loadConversationAssignee(args.db, args.accountId, args.conversationId).catch(() => null),
    contactLabel(args.db, args.accountId, args.contactId, 'Un paciente'),
  ])
  const userId = assignee ?? account?.ownerUserId ?? null
  if (!userId) return 'nobody'
  const texts = buildClinicTexts(settings?.labels ?? DEFAULT_LABELS)
  const notice = build(texts, who)
  if (repeat) {
    const since = new Date(repeat.now.getTime() - repeat.onceInMinutes * 60_000).toISOString()
    if (
      await hasRecentNotification(args.db, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        title: notice.title,
        sinceIso: since,
      })
    ) {
      return 'repeated'
    }
  }
  await insertNotification(args.db, {
    accountId: args.accountId,
    userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    ...notice,
    createdAtIso: (repeat?.now ?? new Date()).toISOString(),
  })
  return 'sent'
}

/**
 * La persona abrió los signos de alarma (escribió algo que puede ser una urgencia o
 * tocó "Tengo una urgencia"): el aviso prioritario en la app sale YA, sin esperar a
 * que conteste. Uno por conversación cada 10 minutos (por su propio título, así el
 * aviso de confirmación, más grave, nunca se pierde por este límite). Si el aviso
 * falla, o no hay a quién avisar, se avisa al equipo técnico con la cuenta y la
 * conversación, nunca con el texto del paciente: los signos de alarma salen igual.
 */
async function announceUrgencyOpened(dialog: Dialog): Promise<void> {
  let problem: string | null = null
  try {
    const result = await notifyThreadHuman(
      dialog,
      (texts, who) => ({
        title: texts.urgencyOpenedNotificationTitle,
        body: texts.urgencyOpenedNotificationBody(who),
      }),
      { onceInMinutes: URGENCY_NOTICE_EVERY_MINUTES, now: dialog.now },
    )
    if (result === 'nobody') problem = 'avisar al equipo en la app: no hay a quién'
  } catch (err) {
    console.error('[agenda] el aviso de urgencia al abrir los signos de alarma falló:', err)
    problem = 'avisar al equipo en la app'
  }
  if (problem) {
    await notifyAlert(
      `Urgencia: no se pudo ${problem} (cuenta ${dialog.accountId}, conversación ${dialog.conversationId}). Revisa ese chat ya.`,
    ).catch(() => undefined)
  }
}

/**
 * "No acepto" en un hilo de una persona: el paciente retira su autorización, y
 * eso se registra aunque el bot no tenga el hilo. Solo se registra: no pausa,
 * no reasigna, no etiqueta y no le escribe al paciente, porque el hilo ya es de
 * una persona. Si no se pudo guardar (o la configuración de la clínica no está),
 * se avisa a quien lo lleva para que lo registre a mano. Una revocación que ya
 * estaba registrada no se repite.
 */
async function revokeConsentInHumanThread(
  dialog: Dialog,
  sessionId: string | null,
  opts: { deleteData?: boolean } = {},
): Promise<void> {
  // Quien retiró su autorización no sigue agendando: la sesión abierta se cierra.
  if (sessionId) {
    await closeSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      status: 'cancelled',
      updatedAtIso: dialog.nowIso,
    })
  }
  const consent = await latestConsent(dialog.db, {
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    kind: 'datos_sensibles',
  })
  if (consent && !consent.granted) return
  const saved = dialog.clinic ? await recordConsentRevoked(clinicCtx(dialog)) : false
  if (!saved) {
    await bestEffort('aviso de revocación sin registrar', () =>
      notifyThreadHuman(dialog, (texts, who) => ({
        title: texts.consentRevokeFailedTitle,
        body: texts.consentRevokeFailedBody(who),
      })),
    )
  }
  // Pidió que borren sus datos: el bot no borra nada y la persona del hilo lo atiende a mano.
  if (opts.deleteData) {
    await bestEffort('aviso de datos por borrar', () =>
      notifyThreadHuman(dialog, (texts, who) => ({
        title: texts.consentDeletionRequestTitle,
        body: texts.consentDeletionRequestBody(who),
      })),
    )
  }
}

/** El paso de una sesión, o null. */
function sessionStep(session: VerticalSession | null | undefined): BookingStep | null {
  return session ? coerceState(session.state).step : null
}

/**
 * Mensaje de una cuenta con clínica lista para usarse (la no disponible y el
 * pase por palabra ya se atendieron arriba).
 *
 * El texto libre sigue UNA regla (`routeClinicText`), y solo en tres
 * momentos: sin sesión, con el menú abierto y esperando una duda. En cualquier
 * otro paso (la autorización, el nombre, los servicios, las preguntas...) el
 * texto es la respuesta a ese paso y lo lee el paso.
 *
 *   sin sesión   book, greeting → menú · mine → sus citas · human → una persona ·
 *                ai → la IA
 *   clinic_menu  el mismo orden en los dos: book → "Agendar" · mine → "Mis
 *   faq_open     citas" · human → una persona · greeting → el menú, sin contar
 *                fallo · ai → la IA.
 *                Una duda con palabra de pago ("¿cuánto cuesta el certificado?")
 *                es una pregunta y va a la IA; un pedido ("quiero pagar") a una
 *                persona, también con la duda abierta
 *
 * Soltar a la IA cierra la sesión y lo avisa con `released`: el despachador
 * reclama todo lo que llega con una sesión abierta.
 */
async function handleClinicInbound(
  dialog: Dialog,
  session: VerticalSession | null,
  state: BookingState | null,
  input: { text: string; replyId: string | null },
): Promise<VerticalDispatchResult> {
  const { text, replyId } = input
  const { labels } = dialog.settings
  const step = state?.step ?? null
  // Solo se enruta el texto: una foto, un audio, un sticker o un toque no.
  const route =
    replyId === null && !isNonTextInbound(text)
      ? routeClinicText(text, [labels.cita, labels.citas])
      : null

  // "No acepto" con una autorización vigente (un botón viejo, o el menú ya abierto)
  // la revoca. En el paso de la autorización es el rechazo de siempre.
  if (replyId === actId('consent_no') && step !== 'consent') {
    const consent = await latestConsent(dialog.db, {
      accountId: dialog.accountId,
      contactId: dialog.contactId,
      kind: 'datos_sensibles',
    })
    if (consent?.granted) {
      await performHandoff(dialog, session?.id ?? null, await handleConsentRevoked(clinicCtx(dialog)))
      return { consumed: true }
    }
  }

  if (session && state) {
    // En una urgencia (los signos, la autorización o la reserva de hoy), pedir una
    // persona con el botón avisa con prioridad, como escribirlo.
    if (replyId === actId('human') && personRequestHandoff(dialog, state).notification) {
      await performHandoff(dialog, session.id, personRequestHandoff(dialog, state))
      return { consumed: true }
    }
    // Los botones del menú principal valen en cualquier paso: un menú viejo sigue
    // en el chat, y tocarlo no puede dar "No entendí". Quedan aparte la
    // autorización, que se contesta primero ("Tengo una urgencia" sí va antes: lo
    // atiende `opensUrgency`), el propio menú, que lee el emparejamiento de
    // siempre, y los signos de alarma, que también se contestan primero. "Mis
    // citas" también: a media reserva deja la reserva y abre la cita.
    if (
      isClinicMenuTap(replyId) &&
      step !== 'consent' &&
      step !== 'clinic_menu' &&
      step !== 'urgency'
    ) {
      await handleChoice(dialog, session.id, newBookingState('clinic_menu'), replyId)
      return { consumed: true }
    }
    if (step === 'clinic_menu' || step === 'faq_open') {
      if (route === 'book' || route === 'mine') {
        const tap = route === 'book' ? actId('book') : actId('mine')
        await handleChoice(dialog, session.id, newBookingState('clinic_menu'), tap)
        return { consumed: true }
      }
      if (route === 'human') {
        await performHandoff(dialog, session.id, { note: dialog.clinicTexts.humanTopicNote })
        return { consumed: true }
      }
      if (route === 'greeting') {
        // Un saludo vuelve al menú, sin contar fallo: desde la duda abierta, al
        // menú de verdad, no a invitar a preguntar otra vez.
        await conclude(dialog, session.id, step === 'faq_open' ? newBookingState('clinic_menu') : state)
        return { consumed: true }
      }
      if (step === 'clinic_menu' && replyId === null && !isNonTextInbound(text)) {
        // "1" o el título de una opción eligen esa opción antes de soltar nada a la
        // IA. "ok" o "gracias" no dicen nada: se repite el menú, sin contarlo como
        // fallo ni mandarlo a la IA.
        const choice = matchChoice({ text, options: state.options })
        if (choice) {
          await handleChoice(dialog, session.id, newBookingState('clinic_menu'), choice)
          return { consumed: true }
        }
        if (isContentless(text)) {
          await conclude(dialog, session.id, state)
          return { consumed: true }
        }
      }
      if (route !== null) return releaseToAi(dialog, session.id)
      // Una foto o un audio mientras espera la duda: no es la duda ni la cierra.
      if (step === 'faq_open' && replyId === null) {
        await conclude(dialog, session.id, state)
        return { consumed: true }
      }
    }
    // La pregunta de avisos de control es opcional. Quien escribe otra cosa ("gracias",
    // una duda, un "sí" escrito) no recibe un "no entendí" ni, a la segunda, pasa a una
    // persona: la pregunta se cierra sin registrar nada y el mensaje sigue su camino,
    // como si no hubiera sesión. Solo el toque de sus botones o un "no" la contestan.
    if (step === 'marketing_consent' && !matchChoice({ text, replyId, options: state.options })) {
      await closeSession(dialog.db, {
        id: session.id,
        accountId: dialog.accountId,
        status: 'completed',
        updatedAtIso: dialog.nowIso,
      })
      const result = await handleClinicInbound(dialog, null, null, input)
      // El despachador leyó esa sesión antes de llamarnos y, si el mensaje no se
      // consumió, la reclamaría por ella: nadie lo contestaría. Se avisa que se soltó.
      return result.consumed ? result : { ...result, released: true }
    }
    await advanceSession(dialog, session, input)
    return { consumed: true }
  }

  await expireStaleSessions(dialog.db, dialog.accountId, dialog.contactId, dialog.nowIso)

  // Quejas, pagos y documentos van a una persona sin esperar la autorización:
  // nadie con una queja se queda atascado en un aviso legal.
  if (route === 'human') {
    await performHandoff(dialog, null, { note: dialog.clinicTexts.humanTopicNote })
    return { consumed: true }
  }

  // Sin autorización no se sigue, y la IA no ve la conversación. Si la
  // autorización no se pudo leer, se vuelve a pedir.
  const consent = await latestConsent(dialog.db, {
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    kind: 'datos_sensibles',
  })
  if (!consent?.granted) {
    const consentState = newBookingState('consent')
    const sessionId = await openSession(dialog, consentState)
    await conclude(dialog, sessionId, consentState)
    return { consumed: true }
  }

  // Con autorización, los botones del menú valen aunque el menú ya haya vencido.
  if (replyId !== null) {
    const menu = newBookingState('clinic_menu')
    if (isClinicMenuTap(replyId)) {
      const sessionId = await openSession(dialog, menu)
      await handleChoice(dialog, sessionId, menu, replyId)
      return { consumed: true }
    }
    // Un botón de otro menú de este bot (un servicio, un día, una hora...) que ya no
    // está activo: se dice, y se muestra el menú. Nunca se manda a la IA.
    if (parseOptionId(replyId) !== null) {
      await dialog.sender.sendText({ text: dialog.clinicTexts.optionExpired })
      const sessionId = await openSession(dialog, menu)
      await conclude(dialog, sessionId, menu)
      return { consumed: true }
    }
    // Un toque que no es de este bot (otro botón, una plantilla) no es asunto suyo.
    return { consumed: false }
  }

  // Una foto, un audio o un sticker: no se leen, y no se deja a nadie en silencio.
  if (isNonTextInbound(text)) {
    await dialog.sender.sendText({ text: dialog.clinicTexts.nonTextNotice })
    const menu = newBookingState('clinic_menu')
    const sessionId = await openSession(dialog, menu)
    await conclude(dialog, sessionId, menu)
    return { consumed: true }
  }

  if (route === 'book' || route === 'greeting') {
    const menu = newBookingState('clinic_menu')
    const sessionId = await openSession(dialog, menu)
    await conclude(dialog, sessionId, menu)
    return { consumed: true }
  }

  // Quiere cancelar o cambiar su cita (ya con autorización): se le muestran las suyas.
  if (route === 'mine') {
    const menu = newBookingState('clinic_menu')
    const sessionId = await openSession(dialog, menu)
    await handleChoice(dialog, sessionId, menu, actId('mine'))
    return { consumed: true }
  }

  // Lo demás es para la IA. Si la IA no va a contestar, nadie se queda sin respuesta.
  if (!(await aiAnswers(dialog))) {
    await performHandoff(dialog, null, { note: dialog.clinicTexts.aiOffNote })
    return { consumed: true }
  }
  return { consumed: false }
}

/** ¿La IA va a contestar? Se lee una vez por mensaje; si no se puede leer, no. */
function aiAnswers(dialog: Dialog): Promise<boolean> {
  dialog.aiOn ??= dialog.aiProbe().catch((err: unknown) => {
    console.error('[clinica] no se pudo saber si la IA responde:', err)
    return false
  })
  return dialog.aiOn
}

/**
 * Le suelta el mensaje a la IA (ver `released`) y cierra la sesión. Si la IA no
 * va a contestar, soltarlo sería silencio: pasa a una persona.
 */
async function releaseToAi(dialog: Dialog, sessionId: string): Promise<VerticalDispatchResult> {
  if (!(await aiAnswers(dialog))) {
    await performHandoff(dialog, sessionId, { note: dialog.clinicTexts.aiOffNote })
    return { consumed: true }
  }
  await closeSession(dialog.db, {
    id: sessionId,
    accountId: dialog.accountId,
    status: 'completed',
    updatedAtIso: dialog.nowIso,
  })
  return { consumed: false, released: true }
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
    expiresAtIso: expiryIso(dialog, state),
  })
  return sessionId
}

// ------------------------------------------------------------
// Recordatorios (taps rem:*) — Fase 3
// ------------------------------------------------------------

/**
 * Acciones Confirmar / Reprogramar / Cancelar del recordatorio.
 *
 * La cita sobre la que se actúa:
 *   - Con el id de la cita en el botón (`rem:<acción>:<cita>`), esa cita, si es de
 *     este contacto y de esta cuenta, está activa y es futura.
 *   - Sin id (los botones de una plantilla de Meta pueden devolver solo la etiqueta),
 *     la PRÓXIMA cita activa del contacto. En una clínica, con más de una cita
 *     activa y sin exactamente una en las próximas 72 horas (ninguna o varias) no
 *     se adivina: se pregunta cuál.
 *
 *   - Confirmar: marca la cita y responde; no toca la sesión.
 *   - Reprogramar: retoma el flujo existente (`pick_day` en modo
 *     reschedule) reutilizando la fila de sesión si ya había una.
 *   - Cancelar: entra a la confirmación de cancelación existente
 *     (`manage_cancel_confirm`), que ya cancela con etiqueta y evento.
 */

/**
 * ¿Es la respuesta a una pregunta que abrió el propio sistema? Se atiende aunque
 * una persona sea dueña del hilo:
 *   - el "Sí, cancelar" / "No" de una cancelación abierta, o
 *   - elegir la cita cuando el toque de un recordatorio no decía cuál era.
 * La lista de "Mis citas" no cuenta: si una persona tomó el hilo mientras tanto,
 * lo que sigue es suyo.
 */
function isSystemTap(session: VerticalSession | null, replyId: string | null): boolean {
  if (!session || !replyId) return false
  if (session.state.step === 'pick_appointment') {
    return typeof session.state.reminderAction === 'string' && parseOptionId(replyId)?.kind === 'appt'
  }
  if (session.state.step !== 'manage_cancel_confirm') return false
  return replyId === actId('cancel_yes') || replyId === actId('back')
}

/**
 * La cita, solo si es de este contacto y de esta cuenta, está activa y es futura.
 * Lanza si la lectura falla (como `listUpcoming`): un error no es "esa cita ya no
 * está activa", y decírselo a un paciente con la cita viva es peor que fallar.
 */
async function loadUpcomingAppointment(
  dialog: Dialog,
  appointmentId: string,
): Promise<AppointmentInfo | null> {
  const appt = await loadAppointment(dialog.db, dialog.accountId, dialog.contactId, appointmentId, {
    strict: true,
  })
  if (!appt) return null
  if (appt.status !== 'pending' && appt.status !== 'confirmed') return null
  return appt.startsAt > dialog.now ? appt : null
}

/**
 * La cita del toque, o `null` si ya no hay una activa. Devuelve 'handled' cuando
 * no se puede saber cuál es y el mensaje ya se atendió: se le preguntó al paciente
 * o, sin la configuración de la clínica, pasó a una persona.
 *
 * Una cuenta sin el módulo clínica no cambia: siempre la próxima cita activa.
 */
async function resolveTapAppointment(
  dialog: Dialog,
  session: VerticalSession | null,
  tap: ReminderTap,
): Promise<AppointmentInfo | 'handled' | null> {
  if (!dialog.clinic && !dialog.clinicUnavailable) {
    return findNextAppointment(dialog.db, dialog.accountId, dialog.contactId, dialog.nowIso)
  }
  if (tap.appointmentId) return loadUpcomingAppointment(dialog, tap.appointmentId)

  const upcoming = await dialog.backend.listUpcoming({
    contactId: dialog.contactId,
    nowIso: dialog.nowIso,
  })
  const limit = dialog.now.getTime() + TAP_AMBIGUITY_MS
  const near = upcoming.filter((a) => a.startsAt.getTime() <= limit)
  // Una sola cercana es la del recordatorio. Con más de una cita activa y ninguna o
  // varias cercanas no se adivina: ni la primera ni la más próxima.
  if (upcoming.length > 1 && near.length !== 1) {
    // Sin la configuración de la clínica no hay lista que ofrecer, y adivinar
    // podría confirmar o cancelar la cita de otro paciente: lo atiende una persona.
    if (!dialog.clinic) {
      await handoffClinicUnavailable(dialog, session?.id ?? null, { text: '', replyId: null })
      return 'handled'
    }
    const state = newBookingState('pick_appointment', { reminderAction: tap.action })
    const sessionId = session?.id ?? (await openSession(dialog, state))
    await conclude(dialog, sessionId, state)
    return 'handled'
  }
  const chosen = near[0] ?? upcoming[0]
  return chosen ? loadUpcomingAppointment(dialog, chosen.id) : null
}

async function handleReminderTap(
  dialog: Dialog,
  session: VerticalSession | null,
  tap: ReminderTap,
  humanOwned = false,
): Promise<void> {
  const appt = await resolveTapAppointment(dialog, session, tap)
  if (appt === 'handled') return
  if (!appt) {
    await dialog.sender.sendText({
      text: dialog.texts.managedAppointmentGone,
    })
    return
  }
  await applyReminderAction(dialog, session?.id ?? null, tap.action, appt, humanOwned)
}

async function applyReminderAction(
  dialog: Dialog,
  sessionId: string | null,
  action: ReminderAction,
  appt: AppointmentInfo,
  humanOwned: boolean,
): Promise<void> {
  if (action === 'confirm') {
    try {
      await dialog.backend.confirm({ id: appt.id, confirmedAtIso: dialog.nowIso })
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

    const staffName = appt.staffId
      ? await loadStaffName(dialog.db, dialog.accountId, appt.staffId)
      : null
    const parts = zonedParts(appt.startsAt)
    const date = formatLongDate(parts.dateKey)
    const time = formatTimeLabel(parts)
    // Una clínica (incluida la que tiene el módulo sin configurar) no nombra el
    // procedimiento: el teléfono puede ser compartido. Dice quién va, con quién,
    // y cuándo. Las demás cuentas siguen igual.
    if (dialog.clinic || dialog.clinicUnavailable) {
      await dialog.sender.sendText({
        text: dialog.clinicTexts.reminderConfirmed({
          patient: await appointmentPatientName(dialog, appt),
          staff: staffName ?? dialog.clinicTexts.reminderStaffFallback,
          date,
          time,
        }),
      })
    } else {
      const service = appt.serviceId ? await findService(dialog, appt.serviceId) : null
      await dialog.sender.sendText({
        text: dialog.texts.reminderConfirmed({
          service: service?.name ?? dialog.texts.serviceFallback,
          staff: staffName ?? dialog.texts.staffAnyTitle,
          date,
          time,
        }),
      })
    }
    if (dialog.clinic) await bestEffort('instrucciones previas', () => sendPrepInfo(dialog, appt))
    return
  }

  // Pieza "reprogramar/cancelar" apagada: nada de flujo; lo atiende una
  // persona. Un solo mensaje al cliente (`changesByHuman`).
  if (!dialog.settings.toggles.allowReschedule) {
    await handoffChangeRequest(dialog, appt, action, {
      via: 'recordatorio',
      sessionId,
    })
    return
  }

  // Reprogramar con un humano a cargo: el bot NO abre su flujo encima
  // del agente. Avisa al agente (o al dueño), deja rastro y le dice al
  // cliente que una persona sigue. Lo mismo si en una clínica la persona revocó
  // su autorización de datos: reprogramar es agendar otra cita con sus datos, y
  // eso lo atiende una persona.
  if (action === 'reschedule' && (humanOwned || (await consentWithdrawn(dialog)))) {
    await handoffRescheduleRequest(dialog, appt)
    return
  }

  const state =
    action === 'reschedule'
      ? await rescheduleState(dialog, appt)
      : newBookingState('manage_cancel_confirm', { appointmentId: appt.id })

  await conclude(dialog, sessionId ?? (await openSession(dialog, state)), state)
}

/**
 * ¿La última autorización de datos de esta persona es un no? Solo en una clínica
 * (con su configuración o sin ella); sin ninguna fila (citas de antes del módulo)
 * no. Si no se puede leer cuenta como que no: no decide nada por sí sola.
 */
async function consentWithdrawn(dialog: Dialog): Promise<boolean> {
  if (!dialog.clinic && !dialog.clinicUnavailable) return false
  const consent = await latestConsent(dialog.db, {
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    kind: 'datos_sensibles',
  })
  return consent !== null && !consent.granted
}

/**
 * Tras confirmar: lo que la clínica escribió para ese servicio, la dirección y el
 * mapa de la sede. Solo texto de la clínica: ni procedimiento ni consejo médico.
 * Sin nada que decir no manda nada.
 */
async function sendPrepInfo(dialog: Dialog, appt: AppointmentInfo): Promise<void> {
  const location = dialog.clinic?.location ?? null
  const prep = appt.serviceId
    ? await loadServicePrep(dialog.db, dialog.accountId, appt.serviceId)
    : null
  const mapUrl =
    location?.latitude != null && location.longitude != null
      ? `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`
      : null
  const text = dialog.clinicTexts.prepInfo({ prep, address: location?.address ?? null, mapUrl })
  if (text) await dialog.sender.sendText({ text })
}

// ------------------------------------------------------------
// Contexto interno
// ------------------------------------------------------------

interface Dialog {
  db: SupabaseClient
  /** Citas y disponibilidad: lo que cambia según dónde viva la agenda. */
  backend: ClinicBackend
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
  /** Configuración de la clínica; null en cuentas sin el módulo o si no está disponible. */
  clinic: ClinicContext | null
  /**
   * La cuenta tiene el módulo clínica pero su configuración falta o no se pudo
   * leer. Nunca se atiende como una agenda normal: pasa a una persona.
   */
  clinicUnavailable: boolean
  /** Copy del bot clínico. No depende de la configuración, así que siempre existe. */
  clinicTexts: ClinicTexts
  /** Id de Meta del mensaje que se está atendiendo; queda en la autorización. */
  inboundMessageId: string | null
  humanOwned: boolean
  /** Cómo saber si la IA responde sola; el resultado se guarda en `aiOn`. */
  aiProbe: () => Promise<boolean>
  aiOn?: Promise<boolean>
  /**
   * Preguntas extra, leídas una sola vez por mensaje del cliente y compartidas
   * por todos los pasos (null = no se pudieron leer).
   */
  questions?: Promise<AgendaQuestion[] | null>
}

/**
 * Profesional con el que se busca la nueva hora al reprogramar: el de
 * la cita, o cualquiera cuando el negocio no deja elegir (pieza apagada).
 */
function rescheduleStaffId(dialog: Dialog, appt: AppointmentInfo): string {
  return dialog.settings.toggles.chooseStaff ? (appt.staffId ?? 'any') : 'any'
}

/**
 * Dónde empieza reprogramar una cita. En una clínica el paciente y la sede de la
 * cita anterior viajan en la sesión desde aquí: la cita nueva es del mismo paciente
 * y queda en la misma sede, pase lo que pase en los pasos de en medio. Si no se
 * pueden leer ahora, se leen al confirmar (ahí un fallo no agenda nada).
 */
async function rescheduleState(dialog: Dialog, appt: AppointmentInfo): Promise<BookingState> {
  const base = newBookingState('pick_day', {
    mode: 'reschedule',
    appointmentId: appt.id,
    serviceId: appt.serviceId ?? undefined,
    staffId: rescheduleStaffId(dialog, appt),
  })
  if (!dialog.clinic) return base
  try {
    const links = await loadAppointmentClinicLinks(dialog.db, dialog.accountId, appt.id)
    return {
      ...base,
      ...(links.patientId ? { patientId: links.patientId } : {}),
      ...(links.locationId ? { locationId: links.locationId } : {}),
    }
  } catch (err) {
    console.error('[clinica] no se pudo leer el paciente y la sede de la cita anterior:', err)
    return base
  }
}

function expiryIso(dialog: Dialog, state?: BookingState): string {
  const ttl = state?.step === 'urgency' ? URGENCY_SESSION_TTL_MS : SESSION_TTL_MS
  return new Date(dialog.now.getTime() + ttl).toISOString()
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
      ? { answers: readAnswerMap(raw.answers, { keepEmpty: true }) }
      : {}),
    ...(typeof raw.patientId === 'string' ? { patientId: raw.patientId } : {}),
    ...(typeof raw.locationId === 'string' ? { locationId: raw.locationId } : {}),
    ...(typeof raw.dayPage === 'number' ? { dayPage: raw.dayPage } : {}),
    ...(typeof raw.consentText === 'string' ? { consentText: raw.consentText } : {}),
    ...(typeof raw.consentVersion === 'number' ? { consentVersion: raw.consentVersion } : {}),
    ...(raw.afterConsent === 'urgency_book' ? { afterConsent: 'urgency_book' as const } : {}),
    ...(raw.urgent === true ? { urgent: true } : {}),
    ...(typeof raw.reminderAction === 'string'
      ? { reminderAction: raw.reminderAction as ReminderAction }
      : {}),
  })
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
  // Doble toque: la autorización ya se aceptó y el menú sigue abierto. El segundo
  // toque no es un error del paciente: se ignora, sin mensaje ni fallo. (Un
  // "No acepto" con una autorización vigente no es un doble toque: revoca.)
  if (
    (state.step === 'clinic_menu' || state.step === 'faq_open') &&
    input.replyId === actId('consent_yes')
  ) {
    return
  }
  // Las preguntas extra se responden escribiendo (o con la opción tocada): no
  // pasan por el emparejamiento general del menú.
  if (state.step === 'ask_question') {
    await handleAnswer(dialog, session.id, state, input)
    return
  }
  // El nombre de quien va a asistir se escribe: tampoco tiene menú que emparejar.
  if (state.step === 'new_patient_name' && dialog.clinic) {
    const outcome = await handlePatientName(clinicCtx(dialog), state, input)
    await applyClinicOutcome(dialog, session.id, state, outcome)
    return
  }
  // En la lista de citas, un texto que coincide con varias ("Marta" con dos citas de
  // Marta) no elige la primera: cuenta como fallo. Los demás menús no cambian.
  const match = state.step === 'pick_appointment' ? matchAppointmentOption : matchChoice
  const choice = match({
    text: input.text,
    replyId: input.replyId,
    options: state.options,
  })
  if (!choice) {
    await registerFail(dialog, session.id, state)
    return
  }
  // Un paso normal olvida los fallos al acertar. Los pasos clínicos no: su
  // "fallo" también es que la base no guardó la respuesta, y si se reiniciara
  // el paciente repetiría el toque para siempre sin llegar a una persona. Lo
  // que avanza a otro paso nace con 0.
  await handleChoice(
    dialog,
    session.id,
    isClinicStep(state.step) ? state : { ...state, fails: 0 },
    choice,
  )
}

/**
 * Respuesta que no empareja con el menú: a la primera se re-pregunta,
 * a la segunda se escala a un humano. `message` reemplaza el aviso por
 * defecto (una pregunta escrita no tiene opciones que elegir).
 */
async function registerFail(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  message: string = dialog.texts.retry,
): Promise<void> {
  const fails = state.fails + 1
  if (fails >= 2) {
    await performHandoff(dialog, sessionId, failureHandoff(dialog, state))
    return
  }
  const next = { ...state, fails }
  await dialog.sender.sendText({ text: message })
  await conclude(dialog, sessionId, next)
}

/**
 * El pase de quien pide una persona o falla dos veces en este paso. Una urgencia
 * (los signos de alarma, la autorización que se pidió para agendarla, o su
 * reserva de hoy) lleva el aviso prioritario: la persona ya dijo que le duele.
 */
function personRequestHandoff(
  dialog: Dialog,
  state: BookingState | null,
): Omit<ClinicHandoff, 'kind'> {
  if (state?.step === 'urgency') return pendingUrgencyHandoff(dialog)
  if (state && (state.urgent || state.afterConsent === 'urgency_book')) {
    return urgencyBookingHandoff(dialog.clinicTexts)
  }
  return {}
}

/** Dos respuestas que no se entienden: lo mismo, salvo la autorización sin responder. */
function failureHandoff(dialog: Dialog, state: BookingState): Omit<ClinicHandoff, 'kind'> {
  if (state.step !== 'consent') return personRequestHandoff(dialog, state)
  // Una autorización sin responder no es un pedido de hablar con una persona.
  return state.afterConsent === 'urgency_book'
    ? urgencyConsentUnansweredHandoff(dialog.clinicTexts)
    : { note: dialog.clinicTexts.consentUnansweredNote }
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
 * Preguntas activas en orden, leídas UNA vez por mensaje del cliente (se
 * comparte entre responder, mostrar la siguiente, el resumen y el insert). Si
 * la base falla devuelve null: el que llama sigue SIN preguntas (jamás se
 * pierde una reserva por las preguntas extra).
 */
function loadQuestions(dialog: Dialog): Promise<AgendaQuestion[] | null> {
  dialog.questions ??= listQuestions(dialog.db, dialog.accountId).catch((err: unknown) => {
    console.error('[agenda] no se pudieron leer las preguntas extra:', err)
    return null
  })
  return dialog.questions
}

function hasAnswer(answers: AnswerMap | undefined, id: string): boolean {
  return answers !== undefined && Object.hasOwn(answers, id)
}

function nextUnanswered(
  questions: AgendaQuestion[],
  answers: AnswerMap | undefined,
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

/** Foto, audio, sticker o tipo no soportado: llega sin texto o como "[Unsupported message type: …]". */
function isNonTextInbound(text: string): boolean {
  return !text.trim() || text.startsWith('[Unsupported message type')
}

/** ¿La pregunta de opciones ofrece la fila/botón "Omitir"? Sólo si no convierte 3 botones en lista. */
function offersSkipOption(question: AgendaQuestion): boolean {
  return (
    !question.required &&
    question.options.length !== MAX_BUTTONS &&
    question.options.length <= MAX_LIST_OPTIONS - 1
  )
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
    // La desactivaron (o la borraron): lo que escribió era para ella, así que no
    // se guarda como respuesta de otra pregunta. Sigue la próxima o el resumen.
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
    // Un tap de otra pregunta (botón viejo) no está en state.options: no empareja.
    const choice = matchAnswerOption({
      text: input.text,
      replyId: input.replyId,
      options: state.options,
    })
    const offered = choice ? state.options.find((o) => o.id === choice) : undefined
    const parsed = offered ? parseAnswerId(offered.id) : null
    if (offered && parsed?.index === 'skip') {
      // "Omitir" solo vale si la pregunta sigue siendo opcional.
      if (question.required) {
        await conclude(dialog, sessionId, state)
        return
      }
      value = ''
    } else if (offered) {
      // Se guarda el título que se ofreció; si el dueño ya lo quitó, se repite.
      if (!question.options.includes(offered.title)) {
        await conclude(dialog, sessionId, state)
        return
      }
      value = offered.title
    } else if (!question.required && input.replyId === null && isSkipAnswer(input.text)) {
      // Una opción llamada "No" gana (arriba); si no, "no"/"ninguno"/... salta.
      value = ''
    } else {
      await registerFail(dialog, sessionId, state)
      return
    }
  } else {
    // Un tap de un menú viejo no responde una pregunta escrita.
    if (input.replyId !== null) {
      await registerFail(dialog, sessionId, state, dialog.texts.answerRetryText)
      return
    }
    // Un sticker, una foto o un tipo no soportado no es una respuesta ni un
    // "omitir": se repite la pregunta (con su aviso si es opcional), sin contar fallo.
    if (isNonTextInbound(input.text)) {
      await conclude(dialog, sessionId, state)
      return
    }
    const check =
      !question.required && isSkipAnswer(input.text)
        ? ({ ok: true, value: '' } as const)
        : validateAnswer(question, input.text)
    if (!check.ok) {
      const warning =
        check.reason === 'number'
          ? dialog.texts.answerInvalidNumber
          : check.reason === 'too_long'
            ? dialog.texts.answerTooLong
            : dialog.texts.answerRequired
      // Una respuesta inválida cuenta como fallo: la segunda seguida pasa a un humano.
      await registerFail(dialog, sessionId, state, warning)
      return
    }
    value = check.value
  }

  // Valor '' = pregunta opcional sin responder: queda marcada para no repetirla,
  // pero ni el resumen ni la cita la guardan. Se guarda con la etiqueta que vio.
  const answers: AnswerMap = {
    ...state.answers,
    [question.id]: { label: question.label, value },
  }
  await conclude(
    dialog,
    sessionId,
    stateAfterQuestions({ ...state, answers, fails: 0 }, questions),
  )
}

/**
 * Respuestas con texto de las preguntas vigentes, en el orden actual. Muestra la
 * etiqueta con que se hizo la pregunta (las guardadas sin etiqueta usan la actual).
 */
function visibleAnswers(
  questions: AgendaQuestion[],
  answers: AnswerMap | undefined,
): { id: string; label: string; value: string }[] {
  const out: { id: string; label: string; value: string }[] = []
  for (const q of questions) {
    const entry = answers && Object.hasOwn(answers, q.id) ? answers[q.id] : undefined
    if (entry?.value) out.push({ id: q.id, label: entry.label || q.label, value: entry.value })
  }
  return out
}

async function handleChoice(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  choice: string,
): Promise<void> {
  const parsed = parseOptionId(choice)

  if (isClinicStep(state.step)) {
    if (!dialog.clinic) {
      await closeSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        status: 'completed',
        updatedAtIso: dialog.nowIso,
      })
      return
    }
    const outcome = await handleClinicChoice(clinicCtx(dialog), state, parsed)
    await applyClinicOutcome(dialog, sessionId, state, outcome)
    return
  }

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
      if (parsed?.kind === 'act' && parsed.value === 'more_days') {
        await conclude(dialog, sessionId, { ...state, dayPage: (state.dayPage ?? 0) + 1 })
        return
      }
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
        // Solo cambia la hora: las respuestas se conservan (al elegir la nueva hora
        // solo se pregunta lo que se agregó mientras tanto).
        await conclude(dialog, sessionId, {
          ...state,
          slotStartsAt: undefined,
          questionId: undefined,
          // Cambiar la hora es empezar a elegir otra vez: desde el primer día. Una
          // urgencia vuelve a las horas de hoy, no al menú de días.
          dayPage: undefined,
          step: state.urgent ? 'pick_slot' : 'pick_day',
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
        // En una clínica la cita nueva es de un paciente: sin elegirlo primero se
        // crearía a nombre de nadie.
        await conclude(
          dialog,
          sessionId,
          newBookingState(dialog.clinic ? 'pick_patient' : 'pick_service'),
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
        await conclude(dialog, sessionId, await rescheduleState(dialog, appt))
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
          await dialog.backend.cancel({
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
    const free = await dialog.backend.isStaffFree({
      staffId: candidate,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    })
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

  // Clínica: la cita es del paciente. Al reprogramar se conservan el paciente y la
  // sede de la cita anterior (no la sede que tenga la clínica hoy). Se leen antes de
  // reclamar la sesión: si la lectura falla, la sesión sigue viva y se puede
  // reintentar, y la cita nueva no pierde al paciente.
  let patientId = state.patientId ?? null
  let locationId = oldAppt ? (state.locationId ?? null) : (dialog.clinic?.location?.id ?? null)
  if (dialog.clinic && oldAppt && (!patientId || !locationId)) {
    try {
      const links = await loadAppointmentClinicLinks(dialog.db, dialog.accountId, oldAppt.id)
      patientId ??= links.patientId
      locationId ??= links.locationId
    } catch (err) {
      console.error('[clinica] no se pudo leer el paciente y la sede de la cita anterior:', err)
      await dialog.sender.sendText({ text: dialog.texts.confirmError })
      await conclude(dialog, sessionId, state)
      return
    }
  }

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
  const booked = await dialog.backend.book({
    id: appointmentId,
    contactId: dialog.contactId,
    conversationId: dialog.conversationId,
    serviceId: service.id,
    staffId: assigned,
    patientId,
    locationId,
    startsAtIso: start.toISOString(),
    endsAtIso: end.toISOString(),
    confirmedAtIso: dialog.nowIso,
    rescheduledFrom: oldAppt?.id ?? null,
    answers,
  })

  if (booked.kind !== 'ok') {
    // Se deja constancia antes de nada: el cliente solo ve un mensaje
    // genérico y sin esto el error real no queda en ningún log.
    if (booked.kind === 'failed') {
      console.error('[agenda] no se pudo crear la cita:', booked.message)
    }
    // La cita no existe: la sesión vuelve a estar activa para que el
    // cliente pueda elegir otra hora o reintentar.
    await releaseSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      updatedAtIso: dialog.nowIso,
    })
    if (booked.kind === 'slot_taken') {
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
      await dialog.backend.cancel({
        id: oldAppt.id,
        reason: 'reprogramada',
        cancelledAtIso: dialog.nowIso,
      })
    } catch (err) {
      console.error('[agenda] cancelar la cita anterior falló:', err)
      let undone = false
      try {
        await dialog.backend.cancel({
          id: appointmentId,
          reason: 'error_reprogramacion',
          cancelledAtIso: dialog.nowIso,
        })
        undone = true
      } catch (undoErr) {
        // La cita nueva tampoco se pudo deshacer: pueden quedar dos
        // citas activas. El error no se silencia.
        console.error('[agenda] no se pudo deshacer la cita nueva:', undoErr)
        await escalateBrokenReschedule(dialog, {
          newAppointmentId: appointmentId,
          oldAppointmentId: oldAppt.id,
        })
      }

      if (undone) {
        // Deshecho: el cliente conserva solo su cita original y su
        // sesión sigue activa para reintentar.
        await releaseSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          updatedAtIso: dialog.nowIso,
        })
        await dialog.sender.sendText({
          text: dialog.texts.confirmError,
        })
        await conclude(dialog, sessionId, state)
      }
      // Sin deshacer: la sesión se queda 'completed' y el hilo pasa a
      // un humano; el bot no vuelve a tocar la agenda de este cliente.
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
  const summary = withPatient(
    buildSummary(dialog, service, staffName ?? '', start),
    await patientName(dialog, patientId),
  )
  await dialog.sender.sendText({
    text: oldAppt
      ? dialog.texts.rescheduleDone(summary)
      : dialog.texts.confirmed(summary),
  })

  // Clínica: después de agendar se pregunta, una sola vez, si quiere que le avisen
  // cuando le toque control. No tras reprogramar (ya la hizo), y no en una reserva
  // de urgencia: primero la urgencia. La cita ya está hecha: si la pregunta falla,
  // no pasa nada.
  if (!oldAppt && dialog.clinic && !state.urgent) {
    await bestEffort('pregunta de avisos de control', () => askMarketingConsent(dialog))
  }
}

/** Permiso aparte para escribirle cuando le toque control (Fase 5). Solo si nunca respondió. */
async function askMarketingConsent(dialog: Dialog): Promise<void> {
  const answered = await latestConsent(dialog.db, {
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    kind: 'mercadeo',
  })
  if (answered) return
  const state = newBookingState('marketing_consent')
  const sessionId = await openSession(dialog, state)
  try {
    await conclude(dialog, sessionId, state)
  } catch (err) {
    // La pregunta no salió: una sesión abierta sin menú contestaría con "no
    // entendí" a lo siguiente que escriba el paciente.
    await closeSession(dialog.db, {
      id: sessionId,
      accountId: dialog.accountId,
      status: 'completed',
      updatedAtIso: dialog.nowIso,
    })
    throw err
  }
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
  /** El paso no tiene a quién ofrecer y pasa a una persona (una urgencia sin horas). */
  handoff?: ClinicHandoff
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
      // Si la agenda cambió y la página quedó vacía, se vuelve a la primera.
      const requested = state.dayPage ?? 0
      const page = requested * DAY_PAGE_SIZE < days.length ? requested : 0
      const shown = days.slice(page * DAY_PAGE_SIZE, (page + 1) * DAY_PAGE_SIZE)
      const options: OfferedOption[] = shown.map((day) => ({
        id: dayId(day.key),
        title: day.label,
      }))
      // "Ver más días" es de la clínica: una agenda normal ofrece 7 y cabe entera.
      if (dialog.clinic && days.length > (page + 1) * DAY_PAGE_SIZE) {
        options.push({ id: actId('more_days'), title: dialog.clinicTexts.moreDays })
      }
      await sendOptions(dialog, {
        bodyText:
          state.mode === 'reschedule'
            ? dialog.texts.rescheduleStart
            : dialog.texts.dayMenuBody,
        buttonLabel: dialog.texts.dayMenuButton,
        options,
      })
      // La primera página no guarda `dayPage`: la sesión queda como siempre.
      return {
        state: { ...state, options, dayPage: page > 0 ? page : undefined },
        closed: false,
      }
    }

    case 'pick_slot': {
      // Una urgencia es para hoy: sin día, hoy.
      const dateKey = state.dateKey ?? (state.urgent ? zonedDateKey(dialog.now) : undefined)
      if (!dateKey) return renderStep(dialog, { ...state, step: 'pick_day' })
      const slots = await mergedSlotsForDay(dialog, state, dateKey)
      if (!slots.length) {
        // Una urgencia sin horas nunca cae al menú de días: pasa a una persona.
        if (state.urgent && dialog.clinic) {
          return {
            state,
            closed: true,
            handoff: urgencyOffHoursHandoff(
              dialog.clinicTexts,
              dialog.clinic.location?.onCallPhone ?? null,
            ),
          }
        }
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
          id: ansId(question.id, i),
          title,
        }))
        // Opcional: fila/botón "Omitir" (hasta 9 opciones; con 3 se pasaría de
        // botones a lista, ahí solo vale escribir "omitir").
        const skip = offersSkipOption(question)
        if (skip) options.push({ id: ansSkipId(question.id), title: dialog.texts.answerSkip })
        const hint = skip ? dialog.texts.answerOptionalHintOptions : dialog.texts.answerOptionalHint
        await sendOptions(dialog, {
          bodyText: question.required ? question.label : `${question.label}\n${hint}`,
          buttonLabel: dialog.texts.answerMenuButton,
          options,
        })
        return { state: { ...state, questionId: question.id, options }, closed: false }
      }
      await dialog.sender.sendText({
        text: question.required
          ? question.label
          : `${question.label}\n${dialog.texts.answerOptionalHint}`,
      })
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

    case 'consent':
    case 'clinic_menu':
    case 'urgency':
    case 'pick_patient':
    case 'new_patient_name':
    case 'pick_appointment':
    case 'marketing_consent':
    case 'faq_open':
      if (!dialog.clinic) return { state, closed: true }
      return renderClinicStep(clinicCtx(dialog), state)
  }
}

/** Envía el menú del paso y persiste (o cierra) la sesión. */
async function conclude(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
): Promise<void> {
  // Al entrar a los signos de alarma (no al repetir la pregunta, que lleva fallos) el
  // equipo se entera ya: el aviso no espera a que la persona conteste.
  if (dialog.clinic && state.step === 'urgency' && state.fails === 0) {
    await announceUrgencyOpened(dialog)
  }
  const { state: effective, closed, handoff } = await renderStep(dialog, state)
  if (handoff) {
    await performHandoff(dialog, sessionId, handoff)
    return
  }
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
    expiresAtIso: expiryIso(dialog, effective),
  })
}

// ------------------------------------------------------------
// Disponibilidad
// ------------------------------------------------------------

/** Servicio y candidatos de la sesión; null si ya no hay a quién ofrecer. */
async function slotScope(
  dialog: Dialog,
  state: BookingState,
): Promise<{ service: ServiceInfo; staffIds: string[] } | null> {
  const service = await findService(dialog, state.serviceId)
  if (!service) return null
  const staff: Pick<StaffInfo, 'id'>[] =
    state.staffId && state.staffId !== 'any'
      ? [{ id: state.staffId }]
      : await listEligibleStaff(dialog.db, dialog.accountId, service.id)
  return staff.length ? { service, staffIds: staff.map((s) => s.id) } : null
}

async function mergedSlotsForDay(
  dialog: Dialog,
  state: BookingState,
  dateKey: string,
): Promise<MergedSlot[]> {
  const scope = await slotScope(dialog, state)
  if (!scope) return []
  return dialog.backend.getDaySlots({ ...scope, dateKey, now: dialog.now })
}

/** Próximos días (7, o los que fije la clínica) con al menos una hora ofrecible. */
async function dayOptions(
  dialog: Dialog,
  state: BookingState,
): Promise<{ key: string; label: string }[]> {
  const scope = await slotScope(dialog, state)
  if (!scope) return []
  const todayKey = zonedDateKey(dialog.now)
  const tomorrowKey = addDaysToKey(todayKey, 1)
  const keys = await dialog.backend.getDaysWithSlots({
    ...scope,
    fromKey: todayKey,
    days: dialog.clinic?.offerDays ?? OFFER_DAYS,
    now: dialog.now,
  })
  return keys.map((key) => ({
    key,
    label:
      key === todayKey
        ? dialog.texts.dayToday
        : key === tomorrowKey
          ? dialog.texts.dayTomorrow
          : formatDayLabel(key),
  }))
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

/**
 * El nombre de quien va a asistir, para el resumen y la confirmación (clínicas). Es
 * un dato personal: se le muestra a quien lo escribió y no va a logs. Si no se puede
 * leer, la cita sigue y solo falta la línea.
 */
async function patientName(dialog: Dialog, patientId: string | null): Promise<string | null> {
  if (!dialog.clinic || !patientId) return null
  try {
    const patients = await dialog.backend.findPatients({ contactId: dialog.contactId })
    return patients.find((p) => p.id === patientId)?.fullName ?? null
  } catch {
    return null
  }
}

/**
 * El paciente de una cita que ya existe, para la respuesta a Confirmar. Es un dato
 * personal: se le muestra a quien recibió el recordatorio y no va a logs. Si no se
 * puede leer, la cita ya quedó confirmada y solo falta la línea.
 */
async function appointmentPatientName(dialog: Dialog, appt: AppointmentInfo): Promise<string | null> {
  try {
    const { patientId } = await loadAppointmentClinicLinks(dialog.db, dialog.accountId, appt.id)
    if (!patientId) return null
    const patients = await dialog.backend.findPatients({ contactId: dialog.contactId })
    return patients.find((p) => p.id === patientId)?.fullName ?? null
  } catch {
    return null
  }
}

function withPatient(summary: AgendaAppointmentSummary, name: string | null): AgendaAppointmentSummary {
  return name ? { ...summary, patient: name } : summary
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
  const summary = withPatient(
    buildSummary(dialog, service, staffName, new Date(state.slotStartsAt)),
    await patientName(dialog, state.patientId ?? null),
  )
  // Las respuestas a las preguntas extra, en el orden actual (solo cita nueva).
  if (state.mode === 'reschedule' || !state.answers) return summary
  const questions = await loadQuestions(dialog)
  const answers = questions ? visibleAnswers(questions, state.answers) : []
  return answers.length ? fitSummaryAnswers(dialog, summary, answers) : summary
}

/** Meta limita el cuerpo de un mensaje interactivo a 1024 unidades UTF-16. */
const SUMMARY_BODY_MAX = 1024
/** Cada respuesta se acorta a esto en el resumen (la cita guarda la completa). */
const SUMMARY_ANSWER_MAX = 70

function shorten(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * Pone las respuestas en el resumen sin pasar del límite del cuerpo: valores
 * acortados y, si aun así no caben, las que sobran se reemplazan por una línea
 * "+N respuestas más". Se mide con el texto real del resumen, así que vale
 * también con servicios o palabras largas del negocio.
 */
function fitSummaryAnswers(
  dialog: Dialog,
  summary: AgendaAppointmentSummary,
  answers: { label: string; value: string }[],
): AgendaAppointmentSummary {
  const shown = answers.map((a) => ({ label: a.label, value: shorten(a.value, SUMMARY_ANSWER_MAX) }))
  let candidate: AgendaAppointmentSummary = summary
  for (let keep = shown.length; keep >= 0; keep -= 1) {
    const more = shown.length - keep
    candidate = {
      ...summary,
      ...(keep ? { answers: shown.slice(0, keep) } : {}),
      ...(more ? { moreAnswers: more } : {}),
    }
    if (dialog.texts.summaryBody(candidate).length <= SUMMARY_BODY_MAX) return candidate
  }
  return candidate
}

/**
 * Respuestas que lleva la cita nueva. Reprogramar una cita existente copia las
 * de la anterior (las guardadas sin etiqueta toman la de la pregunta actual); una
 * cita nueva guarda las del estado, acotadas a las preguntas vigentes (si no se
 * pueden leer, las que ya tenía).
 */
async function answersForNewAppointment(
  dialog: Dialog,
  state: BookingState,
  oldAppt: AppointmentInfo | null,
): Promise<AnswerMap> {
  if (oldAppt) {
    if (!Object.values(oldAppt.answers).some((a) => !a.label)) return oldAppt.answers
    const questions = await loadQuestions(dialog)
    const labels = new Map((questions ?? []).map((q) => [q.id, q.label]))
    return Object.fromEntries(
      Object.entries(oldAppt.answers).map(([id, a]) => [
        id,
        a.label ? a : { ...a, label: labels.get(id) ?? '' },
      ]),
    )
  }
  if (!state.answers) return {}
  const questions = await loadQuestions(dialog)
  if (!questions) return state.answers
  return Object.fromEntries(
    visibleAnswers(questions, state.answers).map(({ id, label, value }) => [id, { label, value }]),
  )
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
  opts: Omit<ClinicHandoff, 'kind'> = {},
): Promise<void> {
  // Con un aviso propio (el de urgencia) la persona ya dijo que le duele: su
  // mensaje sale aunque falle la pausa, el aviso o el cierre de la sesión. Lo
  // que falle se registra y se alerta, para que alguien mire ese chat. Un pase
  // normal sigue subiendo el error: no se le promete una persona al cliente si
  // el bot no se pudo pausar.
  const priority = opts.notification !== undefined
  const failed: string[] = []
  const critical = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (err) {
      if (!priority) throw err
      console.error(`[agenda] ${label} falló en una urgencia:`, err)
      failed.push(label)
    }
  }

  const agentId = await loadHandoffAgentId(dialog.db, dialog.accountId)
  await critical('pausar el bot', () =>
    markConversationHandoff(dialog.db, {
      accountId: dialog.accountId,
      conversationId: dialog.conversationId,
      note: opts.note ?? dialog.texts.handoffNote,
      agentId,
    }),
  )

  await bestEffort('etiqueta quiere-humano', () =>
    applyContactTag(dialog.db, {
      accountId: dialog.accountId,
      contactId: dialog.contactId,
      tagName: 'quiere-humano',
      userId: dialog.configOwnerUserId,
    }),
  )

  // El trigger de asignación avisa al agente; el dueño recibe su
  // aviso aquí para que el equipo lo vea aunque no haya agente. Un aviso
  // propio (el de urgencia) no se puede perder: sale siempre, también cuando
  // el dueño es el agente y el trigger solo le dice que le asignaron un chat,
  // y le llega además al agente.
  const owner = dialog.account?.ownerUserId ?? null
  const recipients = new Set<string>()
  if (owner && (owner !== agentId || opts.notification)) recipients.add(owner)
  if (opts.notification && agentId) recipients.add(agentId)
  if (recipients.size) {
    const who = await contactLabel(dialog.db, dialog.accountId, dialog.contactId)
    for (const userId of recipients) {
      try {
        await insertNotification(dialog.db, {
          accountId: dialog.accountId,
          userId,
          conversationId: dialog.conversationId,
          contactId: dialog.contactId,
          title: opts.notification?.title ?? dialog.texts.handoffNotificationTitle,
          body: (opts.notification?.body ?? dialog.texts.handoffNotificationBody)(who),
          // La hora del bot: así el siguiente aviso de urgencia de este chat ve este.
          createdAtIso: dialog.nowIso,
        })
      } catch (err) {
        console.error('[agenda] aviso de handoff al equipo falló:', err)
        if (priority) failed.push('avisar al equipo en la app')
      }
    }
  } else if (priority) {
    failed.push('avisar al equipo en la app: no hay a quién')
  }

  if (sessionId) {
    await critical('cerrar la sesión', () =>
      closeSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        status: 'cancelled',
        updatedAtIso: dialog.nowIso,
      }),
    )
  }

  // El respaldo del aviso: sin datos del paciente, solo dónde mirar.
  if (failed.length) {
    await notifyAlert(
      `Urgencia: no se pudo ${[...new Set(failed)].join(', ')} ` +
        `(cuenta ${dialog.accountId}, conversación ${dialog.conversationId}). Revisa ese chat ya.`,
    )
  }

  await dialog.sender.sendText({ text: opts.message ?? dialog.texts.handoff })
}

/**
 * Clínica sin configuración usable: el hilo queda con una persona. Si el
 * mensaje parece una urgencia (con las palabras de siempre, porque las de la
 * clínica no se pudieron leer) o es el toque de "Tengo una urgencia", el aviso
 * al equipo es el prioritario.
 */
async function handoffClinicUnavailable(
  dialog: Dialog,
  sessionId: string | null,
  input: { text: string; replyId: string | null },
): Promise<void> {
  const { clinicTexts: texts } = dialog
  const urgent =
    (input.replyId !== null && URGENT_TAPS.includes(input.replyId)) ||
    detectsUrgency(input.text, DEFAULT_URGENCY_WORDS)
  if (!urgent) {
    await performHandoff(dialog, sessionId, { note: texts.clinicUnavailableNote })
    return
  }
  // Sin la configuración no se sabe qué signos de alarma mostrar: valen los de
  // siempre. Quien tocó "Sí, tengo alguno" ya sabe que los tiene; los demás
  // reciben los signos repetidos, no el pase genérico.
  const answer =
    input.replyId === actId('alarm_yes')
      ? urgencyGoErHandoff(texts)
      : urgencyUnconfirmedHandoff(texts, DEFAULT_URGENCY_ALARM_TEXT)
  await performHandoff(dialog, sessionId, { ...answer, note: texts.clinicUnavailableUrgentNote })
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
    const who = await contactLabel(dialog.db, dialog.accountId, dialog.contactId)
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
    const who = await contactLabel(dialog.db, dialog.accountId, dialog.contactId)
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

/**
 * La reprogramación quedó a medias: la cita nueva no se pudo deshacer
 * y pueden quedar dos activas. Se deja rastro visible (alerta de ops,
 * aviso en la app), se pausa el bot en ese hilo y se le dice al
 * cliente que un humano lo arregla — sin pedirle que reintente, para
 * no multiplicar el problema.
 */
async function escalateBrokenReschedule(
  dialog: Dialog,
  ids: { newAppointmentId: string; oldAppointmentId: string },
): Promise<void> {
  await notifyAlert(
    `Agenda: la reprogramación de la cita ${ids.oldAppointmentId} quedó a medias (cuenta ${dialog.accountId}). ` +
      `La cita nueva ${ids.newAppointmentId} no se pudo deshacer y puede haber dos citas activas; hay que revisarlo en la agenda.`,
  )

  const agentId = await loadHandoffAgentId(dialog.db, dialog.accountId)
  await bestEffort('pausar el bot tras una reprogramación rota', () =>
    markConversationHandoff(dialog.db, {
      accountId: dialog.accountId,
      conversationId: dialog.conversationId,
      note: dialog.texts.rescheduleBrokenNote,
      agentId,
    }),
  )

  const owner = dialog.account?.ownerUserId ?? null
  if (owner && owner !== agentId) {
    const who = await contactLabel(dialog.db, dialog.accountId, dialog.contactId)
    await bestEffort('aviso de reprogramación rota al equipo', () =>
      insertNotification(dialog.db, {
        accountId: dialog.accountId,
        userId: owner,
        conversationId: dialog.conversationId,
        contactId: dialog.contactId,
        title: dialog.texts.rescheduleBrokenNotificationTitle,
        body: dialog.texts.rescheduleBrokenNotificationBody({ who }),
      }),
    )
  }

  await dialog.sender.sendText({ text: dialog.texts.rescheduleBroken })
}

/** Cómo se llama el contacto en un aviso: su nombre, su teléfono o `fallback`. */
async function contactLabel(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  fallback = 'Un cliente',
): Promise<string> {
  const contact = await loadContact(db, accountId, contactId).catch(() => null)
  return contact?.name?.trim() || contact?.phone || fallback
}

/** El pase de quien dijo que le duele y no confirmó si tiene signos de alarma. */
function pendingUrgencyHandoff(dialog: Dialog): ClinicHandoff {
  return urgencyUnconfirmedHandoff(dialog.clinicTexts, urgencyAlarmText(dialog))
}

async function bestEffort(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    console.error(`[agenda] ${label} falló:`, err)
  }
}

// ------------------------------------------------------------
// Pasos clínicos
// ------------------------------------------------------------

function clinicCtx(dialog: Dialog): ClinicStepCtx {
  return {
    db: dialog.db,
    sender: dialog.sender,
    backend: dialog.backend,
    clinic: dialog.clinic!,
    texts: dialog.clinicTexts,
    accountId: dialog.accountId,
    contactId: dialog.contactId,
    conversationId: dialog.conversationId,
    now: dialog.now,
    nowIso: dialog.nowIso,
    inboundMessageId: dialog.inboundMessageId,
    aiAutoReplyOn: () => aiAnswers(dialog),
    serviceScope: (serviceId) =>
      slotScope(dialog, newBookingState('pick_day', { serviceId, staffId: 'any' })),
    sendOptions: (args) => sendOptions(dialog, args),
  }
}

async function applyClinicOutcome(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  outcome: ClinicOutcome,
): Promise<void> {
  switch (outcome.kind) {
    case 'next':
      // `advanceSession` no reinicia los fallos en los pasos clínicos, así que
      // aquí un paso nuevo nace con 0: un error en el menú anterior no puede
      // adelantar el pase a una persona del paso que sigue.
      await conclude(
        dialog,
        sessionId,
        outcome.state.step === state.step ? outcome.state : { ...outcome.state, fails: 0 },
      )
      return
    case 'handoff':
      await performHandoff(dialog, sessionId, outcome)
      return
    case 'done':
      await closeSession(dialog.db, {
        id: sessionId,
        accountId: dialog.accountId,
        status: 'completed',
        updatedAtIso: dialog.nowIso,
      })
      return
    case 'fail':
      await registerFail(dialog, sessionId, state, outcome.message)
      return
    case 'reminder': {
      const appt = await loadUpcomingAppointment(dialog, outcome.appointmentId)
      if (!appt) {
        await dialog.sender.sendText({ text: dialog.texts.managedAppointmentGone })
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
        return
      }
      // La pregunta "¿cuál?" ya cumplió. Confirmar termina aquí, y reprogramar con
      // una persona a cargo también (solo le avisa). Cancelar y reprogramar siguen
      // en la misma sesión, que cambia de paso, o la cierra quien las pasa a una persona.
      const endsHere =
        outcome.action === 'confirm' || (outcome.action === 'reschedule' && dialog.humanOwned)
      if (endsHere) {
        await closeSession(dialog.db, {
          id: sessionId,
          accountId: dialog.accountId,
          status: 'completed',
          updatedAtIso: dialog.nowIso,
        })
      }
      await applyReminderAction(
        dialog,
        endsHere ? null : sessionId,
        outcome.action,
        appt,
        dialog.humanOwned,
      )
      return
    }
  }
}
