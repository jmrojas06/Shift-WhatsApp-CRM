// ============================================================
// Controlador de reservas por WhatsApp — barbería.
//
//   hola/cita → sesión (booking_sessions) → servicios → barbero
//   (o "Cualquiera") → días con cupo → horas → resumen →
//   Confirmar / Reprogramar / Cancelar → cita confirmed + negocio
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

import { BARBERIA_AGENT_TEXTS, type BarberiaAppointmentSummary } from '../texts'
import {
  computeDaySlots,
  mergeSlotsByStart,
  type MergedSlot,
} from './availability'
import {
  applyContactTag,
  cancelAppointment,
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
  loadContact,
  loadHandoffAgentId,
  loadInboundMessage,
  loadStaffName,
  markConversationHandoff,
  updateSession,
  upsertBarberiaDeal,
  type AccountInfo,
  type AppointmentInfo,
  type BusyRow,
  type ServiceInfo,
  type StaffInfo,
  type WorkBlockRow,
} from './db'
import { formatDayLabel, formatLongDate, formatPrice, formatTimeLabel, truncate } from './format'
import {
  actId,
  containsHandoffWord,
  containsIntentWord,
  dayId,
  matchChoice,
  newBookingState,
  parseOptionId,
  slotId,
  staffId,
  svcId,
  type BookingState,
  type BookingStep,
  type OfferedOption,
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

export interface BarberiaSender {
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

export interface HandleBarberiaInboundArgs {
  db: SupabaseClient
  sender: BarberiaSender
  /** Reloj inyectable (tests); en producción es la hora real. */
  now?: Date
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  inboundMessageId?: string
  session?: VerticalSession | null
}

// ------------------------------------------------------------
// Entrada
// ------------------------------------------------------------

export async function handleBarberiaInbound(
  args: HandleBarberiaInboundArgs,
): Promise<VerticalDispatchResult> {
  const now = args.now ?? new Date()
  const dialog: Dialog = {
    db: args.db,
    sender: args.sender,
    now,
    nowIso: now.toISOString(),
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    account: await loadAccount(args.db, args.accountId),
  }

  const inbound = args.inboundMessageId
    ? await loadInboundMessage(
        args.db,
        args.conversationId,
        args.inboundMessageId,
      )
    : null
  const text = inbound?.text ?? ''
  const replyId = inbound?.replyId ?? null

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
  if (!containsIntentWord(text)) return { consumed: false }

  const existing = await findNextAppointment(
    args.db,
    args.accountId,
    args.contactId,
    dialog.nowIso,
  )
  const state = existing
    ? newBookingState('manage_menu', { appointmentId: existing.id })
    : newBookingState('pick_service')

  const sessionId = crypto.randomUUID()
  await createSession(args.db, {
    id: sessionId,
    accountId: args.accountId,
    contactId: args.contactId,
    state: toJson(state),
    expiresAtIso: expiryIso(dialog),
  })
  await conclude(dialog, sessionId, state)
  return { consumed: true }
}

// ------------------------------------------------------------
// Contexto interno
// ------------------------------------------------------------

interface Dialog {
  db: SupabaseClient
  sender: BarberiaSender
  now: Date
  nowIso: string
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  account: AccountInfo | null
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
  await dialog.sender.sendText({ text: BARBERIA_AGENT_TEXTS.retry })
  await conclude(dialog, sessionId, next)
}

async function handleChoice(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
  choice: string,
): Promise<void> {
  const parsed = parseOptionId(choice)

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
          text: BARBERIA_AGENT_TEXTS.noStaffForService,
        })
        await conclude(dialog, sessionId, {
          ...state,
          serviceId: service.id,
          staffId: undefined,
          step: 'pick_service',
        })
        return
      }
      if (staff.length === 1) {
        await conclude(dialog, sessionId, {
          ...state,
          serviceId: service.id,
          staffId: staff[0].id,
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
        await dialog.sender.sendText({ text: BARBERIA_AGENT_TEXTS.dayTaken })
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
      await conclude(dialog, sessionId, {
        ...state,
        dateKey,
        slotStartsAt: startsAtIso,
        step: 'summary',
      })
      return
    }

    case 'summary': {
      if (parsed?.kind !== 'act') break
      if (parsed.value === 'confirm') {
        await confirmAppointment(dialog, sessionId, state)
        return
      }
      if (parsed.value === 'reschedule') {
        await conclude(dialog, sessionId, {
          ...state,
          slotStartsAt: undefined,
          step: 'pick_day',
        })
        return
      }
      if (parsed.value === 'cancel') {
        const text =
          state.mode === 'reschedule'
            ? BARBERIA_AGENT_TEXTS.cancelDeclined
            : BARBERIA_AGENT_TEXTS.draftCancelled
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
            text: BARBERIA_AGENT_TEXTS.managedAppointmentGone,
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
            staffId: appt.staffId ?? 'any',
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
          text: BARBERIA_AGENT_TEXTS.cancelDeclined,
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
            text: BARBERIA_AGENT_TEXTS.managedAppointmentGone,
          })
          await closeSession(dialog.db, {
            id: sessionId,
            accountId: dialog.accountId,
            status: 'completed',
            updatedAtIso: dialog.nowIso,
          })
          return
        }
        await cancelAppointment(dialog.db, {
          accountId: dialog.accountId,
          id: appt.id,
          reason: 'cliente',
          cancelledAtIso: dialog.nowIso,
        })
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
          text: BARBERIA_AGENT_TEXTS.cancelDone,
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
    await dialog.sender.sendText({ text: BARBERIA_AGENT_TEXTS.noServices })
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
        text: BARBERIA_AGENT_TEXTS.managedAppointmentGone,
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
  })

  if (error) {
    if (error.code === '23P01') {
      // Choque con el EXCLUDE anti-doble-reserva: alguien ganó la carrera.
      await offerAlternatives(dialog, sessionId, state)
      return
    }
    await dialog.sender.sendText({
      text: BARBERIA_AGENT_TEXTS.confirmError,
    })
    await conclude(dialog, sessionId, state)
    return
  }

  // Efectos de CRM — mejor esfuerzo: la cita ya existe y el cliente
  // no puede quedarse sin confirmación por un fallo del CRM.
  if (oldAppt) {
    await bestEffort('cancelar la cita anterior', () =>
      cancelAppointment(dialog.db, {
        accountId: dialog.accountId,
        id: oldAppt!.id,
        reason: 'reprogramada',
        cancelledAtIso: dialog.nowIso,
      }),
    )
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
    await bestEffort('negocio en el pipeline Barbería', () =>
      upsertBarberiaDeal(dialog.db, {
        accountId: dialog.accountId,
        userId: dialog.configOwnerUserId,
        contactId: dialog.contactId,
        conversationId: dialog.conversationId,
        title: `Cita: ${service.name}`,
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

  await closeSession(dialog.db, {
    id: sessionId,
    accountId: dialog.accountId,
    status: 'completed',
    updatedAtIso: dialog.nowIso,
  })

  const staffName = await loadStaffName(dialog.db, dialog.accountId, assigned!)
  const summary = buildSummary(dialog, service, staffName ?? '', start)
  await dialog.sender.sendText({
    text: oldAppt
      ? BARBERIA_AGENT_TEXTS.rescheduleDone(summary)
      : BARBERIA_AGENT_TEXTS.confirmed(summary),
  })
}

/** Hora perdida: avisa y re-renderiza el menú de horas. */
async function offerAlternatives(
  dialog: Dialog,
  sessionId: string,
  state: BookingState,
): Promise<void> {
  await dialog.sender.sendText({ text: BARBERIA_AGENT_TEXTS.slotTaken })
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
          text: BARBERIA_AGENT_TEXTS.noServices,
        })
        return { state, closed: true }
      }
      const options: OfferedOption[] = services.map((service) => ({
        id: svcId(service.id),
        title: service.name,
      }))
      await sendOptions(dialog, {
        bodyText: BARBERIA_AGENT_TEXTS.serviceMenuBody,
        buttonLabel: BARBERIA_AGENT_TEXTS.serviceMenuButton,
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
          text: BARBERIA_AGENT_TEXTS.noStaffForService,
        })
        return renderStep(dialog, { ...state, step: 'pick_service' })
      }
      const sent = [
        ...staff.map((s) => ({ id: staffId(s.id), title: s.name })),
        {
          id: staffId('any'),
          title: BARBERIA_AGENT_TEXTS.staffAnyTitle,
          description: BARBERIA_AGENT_TEXTS.staffAnyDescription,
        },
      ]
      const options: OfferedOption[] = sent.map(({ id, title }) => ({
        id,
        title,
      }))
      await sendOptions(dialog, {
        bodyText: BARBERIA_AGENT_TEXTS.staffMenuBody,
        buttonLabel: BARBERIA_AGENT_TEXTS.staffMenuButton,
        options: sent,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'pick_day': {
      const days = await dayOptions(dialog, state)
      if (!days.length) {
        await dialog.sender.sendText({
          text: BARBERIA_AGENT_TEXTS.noDaysAvailable,
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
            ? BARBERIA_AGENT_TEXTS.rescheduleStart
            : BARBERIA_AGENT_TEXTS.dayMenuBody,
        buttonLabel: BARBERIA_AGENT_TEXTS.dayMenuButton,
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'pick_slot': {
      const dateKey = state.dateKey
      if (!dateKey) return renderStep(dialog, { ...state, step: 'pick_day' })
      const slots = await mergedSlotsForDay(dialog, state, dateKey)
      if (!slots.length) {
        await dialog.sender.sendText({ text: BARBERIA_AGENT_TEXTS.dayTaken })
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
        bodyText: BARBERIA_AGENT_TEXTS.slotMenuBody(formatLongDate(dateKey)),
        buttonLabel: BARBERIA_AGENT_TEXTS.slotMenuButton,
        options,
        footerText:
          slots.length > shown.length
            ? BARBERIA_AGENT_TEXTS.optionsTruncated
            : undefined,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'summary': {
      const built = await buildSummaryForState(dialog, state)
      if (!built) {
        return renderStep(dialog, newBookingState('pick_service'))
      }
      const options: OfferedOption[] = [
        { id: actId('confirm'), title: BARBERIA_AGENT_TEXTS.summaryConfirm },
        {
          id: actId('reschedule'),
          title: BARBERIA_AGENT_TEXTS.summaryReschedule,
        },
        { id: actId('cancel'), title: BARBERIA_AGENT_TEXTS.summaryCancel },
      ]
      await sendButtons(dialog, {
        bodyText: BARBERIA_AGENT_TEXTS.summaryBody(built),
        options,
      })
      return { state: { ...state, options }, closed: false }
    }

    case 'manage_menu': {
      const appt = await loadManagedAppointment(dialog, state)
      if (!appt) {
        await dialog.sender.sendText({
          text: BARBERIA_AGENT_TEXTS.managedAppointmentGone,
        })
        return { state, closed: true }
      }
      const service = appt.serviceId
        ? await findService(dialog, appt.serviceId)
        : null
      const parts = zonedParts(appt.startsAt)
      const options: OfferedOption[] = [
        { id: actId('new'), title: BARBERIA_AGENT_TEXTS.manageNew },
        {
          id: actId('reschedule'),
          title: BARBERIA_AGENT_TEXTS.manageReschedule,
        },
        { id: actId('cancel'), title: BARBERIA_AGENT_TEXTS.manageCancel },
      ]
      await sendButtons(dialog, {
        bodyText: BARBERIA_AGENT_TEXTS.manageMenuBody({
          service: service?.name ?? 'tu servicio',
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
          text: BARBERIA_AGENT_TEXTS.managedAppointmentGone,
        })
        return { state, closed: true }
      }
      const parts = zonedParts(appt.startsAt)
      const options: OfferedOption[] = [
        { id: actId('cancel_yes'), title: BARBERIA_AGENT_TEXTS.cancelYes },
        { id: actId('back'), title: BARBERIA_AGENT_TEXTS.cancelNo },
      ]
      await sendButtons(dialog, {
        bodyText: BARBERIA_AGENT_TEXTS.cancelConfirmBody({
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
        ? BARBERIA_AGENT_TEXTS.dayToday
        : i === 1
          ? BARBERIA_AGENT_TEXTS.dayTomorrow
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
): BarberiaAppointmentSummary {
  const parts = zonedParts(start)
  return {
    service: service.name,
    staff: staffName,
    date: formatLongDate(parts.dateKey),
    time: formatTimeLabel(parts),
    price: formatPrice(service.price, dialog.account?.defaultCurrency ?? 'COP'),
  }
}

async function buildSummaryForState(
  dialog: Dialog,
  state: BookingState,
): Promise<BarberiaAppointmentSummary | null> {
  if (!state.slotStartsAt) return null
  const service = await findService(dialog, state.serviceId)
  if (!service) return null
  const staffName =
    state.staffId && state.staffId !== 'any'
      ? ((await loadStaffName(dialog.db, dialog.accountId, state.staffId)) ??
        BARBERIA_AGENT_TEXTS.staffAnyTitle)
      : BARBERIA_AGENT_TEXTS.staffAnyTitle
  return buildSummary(dialog, service, staffName, new Date(state.slotStartsAt))
}

function serviceDescription(dialog: Dialog, service: ServiceInfo): string {
  const price = formatPrice(
    service.price,
    dialog.account?.defaultCurrency ?? 'COP',
  )
  return `${service.durationMinutes} min • ${price}`
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
    buttonLabel: args.buttonLabel,
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
      (truncated ? BARBERIA_AGENT_TEXTS.optionsTruncated : undefined),
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
    note: BARBERIA_AGENT_TEXTS.handoffNote,
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
        title: BARBERIA_AGENT_TEXTS.handoffNotificationTitle,
        body: BARBERIA_AGENT_TEXTS.handoffNotificationBody(who),
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

  await dialog.sender.sendText({ text: BARBERIA_AGENT_TEXTS.handoff })
}

async function bestEffort(label: string, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    console.error(`[barberia] ${label} falló:`, err)
  }
}
