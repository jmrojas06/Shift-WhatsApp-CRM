import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { describeError } from '@/lib/ops/describe-error'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import {
  isAppointmentStatus,
  validateStatusChange,
  type AppointmentStatus,
  type StatusChangeRejection,
} from '@/verticals/agenda/appointments'
import { validatePanelBooking, canMove } from '@/verticals/agenda/panel-booking'
import { isUuid, parseCancelBody, parseMoveBody } from '@/verticals/agenda/panel-booking-input'
import {
  accountHasClinic,
  loadBookableStaff,
  loadEditableAppointment,
  loadPanelLabels,
  loadSlotContext,
  staffServesService,
  writeCancel,
  writeMove,
} from '@/verticals/agenda/panel-booking-repo'
import { notifyIfRequested, type PanelNotifyKind } from '@/verticals/agenda/panel-notify'

import { panelError, panelRejection, scheduleCalendarKick } from '../../_lib/panel-http'

// ============================================================
// PATCH /api/verticals/agenda/appointments/[id]
//
// Tres cosas, según el cuerpo:
//
//   { status, confirm_past? }   — la agenda del día mueve una cita
//       entre estados operativos (completed / no_show / cancelled, o
//       pending → confirmed). Es lo de siempre y no cambió.
//   { action: 'move', starts_at, staff_id?, notify?, outside_hours_ok? }
//       — la recepción cambia la hora (y, si quiere, el profesional) en
//       la MISMA fila, con las mismas reglas que al crear.
//   { action: 'cancel', reason?, notify?, confirm_past? }
//       — la recepción cancela con un motivo (por defecto 'clinic').
//
// Guardas:
//   - requireRole('agent'): viewers son solo-lectura (la política
//     RLS booking_appointments_update exige lo mismo — doble capa).
//   - El `[id]` debe ser un uuid; si no, 404 "no existe" (nunca llega a
//     la base).
//   - La cita SIEMPRE se lee y se escribe acotada por account_id.
//   - Las reglas de transición y la confirmación de citas pasadas
//     viven en verticals/agenda/appointments.ts; las de mover, en
//     verticals/agenda/panel-booking.ts (probadas).
//   - Update optimista: mover solo escribe si `updated_at` sigue igual
//     al que se leyó; el estado y cancelar, si el estado sigue igual.
//     Si alguien más la tocó, se avisa (409 stale) en vez de pisarla.
//
// Mover y cancelar responden `{ appointment, notified, notify_error? }`.
// El aviso al paciente nunca deshace el cambio. Después de cada
// escritura que guardó se avisa a Google Calendar con `after()`.
//
// El trigger de la migración 047 registra solo el evento de cambio
// en booking_events (actor 'system'); esta ruta no lo duplica.
// ============================================================

const REJECTION_MESSAGES: Record<StatusChangeRejection, string> = {
  invalid_status: 'El estado solicitado no es válido.',
  terminal_status: 'Esta cita ya está cerrada; no se puede volver a cambiar.',
  invalid_transition: 'Ese cambio de estado no está permitido.',
  past_confirmation_required:
    'La cita ya pasó. Confirma que quieres cambiar su estado.',
}

const REJECTION_STATUS: Record<StatusChangeRejection, number> = {
  invalid_status: 400,
  terminal_status: 409,
  invalid_transition: 409,
  past_confirmation_required: 409,
}

const NOT_FOUND = { error: 'La cita no existe.', code: 'not_found' }

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    // Un id que no es uuid no puede ser una cita: se corta aquí, antes de
    // llegar a Postgres (que daría 22P02 → 500) y en las tres rutas del PATCH.
    if (!isUuid(id)) return NextResponse.json(NOT_FOUND, { status: 404 })

    const body = (await request.json().catch(() => null)) as {
      status?: unknown
      confirm_past?: unknown
      action?: unknown
    } | null

    // `action: null` es lo mismo que no mandarla: el cambio de estado de siempre.
    if (body && body.action != null) {
      if (body.action === 'move') return await moveAppointment(ctx, id, body)
      if (body.action === 'cancel') return await cancelAppointment(ctx, id, body)
      return panelError(400, 'invalid_action', 'La acción pedida no es válida.')
    }

    if (!body || !isAppointmentStatus(body.status)) {
      return NextResponse.json(
        { error: REJECTION_MESSAGES.invalid_status, code: 'invalid_status' },
        { status: 400 },
      )
    }
    const nextStatus: AppointmentStatus = body.status

    const { data: appointment, error: loadError } = await ctx.supabase
      .from('booking_appointments')
      .select('id, status, starts_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (loadError) {
      console.error('[agenda appointments] no se pudo leer la cita:', describeError(loadError))
      return NextResponse.json(
        { error: 'No se pudo leer la cita.' },
        { status: 500 },
      )
    }
    if (!appointment) {
      return NextResponse.json(NOT_FOUND, { status: 404 })
    }

    const now = new Date()
    const check = validateStatusChange({
      currentStatus: appointment.status as AppointmentStatus,
      nextStatus,
      startsAt: new Date(appointment.starts_at as string),
      now,
      confirmPast: body.confirm_past === true,
    })
    if (!check.ok) {
      return NextResponse.json(
        { error: REJECTION_MESSAGES[check.code], code: check.code },
        { status: REJECTION_STATUS[check.code] },
      )
    }

    const patch: Record<string, unknown> = { status: check.nextStatus }
    if (check.nextStatus === 'cancelled') {
      patch.cancelled_at = now.toISOString()
      patch.cancel_reason = 'equipo'
    }

    const { data: updated, error: updateError } = await ctx.supabase
      .from('booking_appointments')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      // Update optimista: solo pisa el estado que leímos.
      .eq('status', appointment.status as string)
      .select('id, status')
      .maybeSingle()

    if (updateError) {
      console.error(
        '[agenda appointments] no se pudo actualizar la cita:',
        describeError(updateError),
      )
      return NextResponse.json(
        { error: 'No se pudo actualizar la cita.' },
        { status: 500 },
      )
    }
    if (!updated) {
      return NextResponse.json(
        {
          error: 'La cita cambió mientras la actualizabas. Recarga la agenda.',
          code: 'stale',
        },
        { status: 409 },
      )
    }

    scheduleCalendarKick(ctx.accountId)
    return NextResponse.json({ appointment: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** El aviso al paciente, con el service role (escribe en `messages`). */
function notifyPatientAbout(
  ctx: AccountContext,
  appointmentId: string,
  kind: PanelNotifyKind,
  notify: boolean,
  now: Date,
) {
  return notifyIfRequested(notify, () => ({
    db: supabaseAdmin(),
    accountId: ctx.accountId,
    appointmentId,
    kind,
    now,
  }))
}

async function moveAppointment(ctx: AccountContext, id: string, body: unknown) {
  const { accountId } = ctx
  const db = ctx.supabase

  const parsed = parseMoveBody(body)
  if (!parsed.ok) return panelError(400, 'invalid_body', parsed.message)
  const input = parsed.value

  const appointment = await loadEditableAppointment(db, accountId, id)
  if (!appointment) return NextResponse.json(NOT_FOUND, { status: 404 })

  const now = new Date()
  const labels = await loadPanelLabels(db, accountId)

  if (
    !canMove(appointment.status as AppointmentStatus, appointment.startsAt, now)
  ) {
    return panelRejection('not_editable', labels)
  }

  const staffId = input.staffId ?? appointment.staffId
  if (!staffId) return panelError(400, 'staff_required', 'Elige quién atiende la cita.')
  const staff = await loadBookableStaff(db, accountId, staffId)
  if (!staff) {
    return panelError(
      404,
      'staff_not_found',
      'Esa opción ya no existe o está desactivada. Recarga la página e intenta de nuevo.',
    )
  }

  // Mover conserva la duración que la cita ya tenía. Si el servicio se borró
  // del catálogo no se sabe qué atiende cada quien: solo vale el mismo profesional.
  const durationMinutes = Math.round(
    (appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000,
  )
  const serves = appointment.serviceId
    ? await staffServesService(db, accountId, staff.id, appointment.serviceId)
    : staff.id === appointment.staffId

  const clinic = await accountHasClinic(db, accountId)
  const slot = await loadSlotContext(db, {
    accountId,
    staffId: staff.id,
    startsAt: input.startsAt,
    endsAt: new Date(input.startsAt.getTime() + durationMinutes * 60_000),
    clinic,
    ignore: { startsAt: appointment.startsAt, endsAt: appointment.endsAt },
  })
  const check = validatePanelBooking({
    startsAt: input.startsAt,
    durationMinutes,
    now,
    staffServesService: serves,
    workBlocks: slot.workBlocks,
    timeOff: slot.timeOff,
    outsideHoursOk: input.outsideHoursOk,
    chairs: slot.chairs,
  })
  if (!check.ok) return panelRejection(check.code, labels)

  const written = await writeMove(db, {
    accountId,
    appointment,
    startsAt: input.startsAt,
    endsAt: check.endsAt,
    staffId: staff.id,
  })
  if (written.kind === 'slot_taken') return panelRejection('slot_taken', labels)
  if (written.kind === 'stale') return panelRejection('stale', labels)

  scheduleCalendarKick(accountId)
  const outcome = await notifyPatientAbout(ctx, id, 'moved', input.notify, now)
  return NextResponse.json({ appointment: written.appointment, ...outcome })
}

async function cancelAppointment(ctx: AccountContext, id: string, body: unknown) {
  const { accountId } = ctx
  const db = ctx.supabase

  const parsed = parseCancelBody(body)
  if (!parsed.ok) return panelError(400, 'invalid_body', parsed.message)
  const input = parsed.value

  const appointment = await loadEditableAppointment(db, accountId, id)
  if (!appointment) return NextResponse.json(NOT_FOUND, { status: 404 })

  // Las mismas reglas que el cambio de estado: una cita cerrada no se toca y
  // una que ya pasó pide confirmación.
  const now = new Date()
  const check = validateStatusChange({
    currentStatus: appointment.status as AppointmentStatus,
    nextStatus: 'cancelled',
    startsAt: appointment.startsAt,
    now,
    confirmPast: input.confirmPast,
  })
  if (!check.ok) {
    return NextResponse.json(
      { error: REJECTION_MESSAGES[check.code], code: check.code },
      { status: REJECTION_STATUS[check.code] },
    )
  }

  const cancelled = await writeCancel(db, {
    accountId,
    appointment,
    reason: input.reason,
    nowIso: now.toISOString(),
  })
  if (!cancelled) return panelRejection('stale', await loadPanelLabels(db, accountId))

  scheduleCalendarKick(accountId)
  const outcome = await notifyPatientAbout(ctx, id, 'cancelled', input.notify, now)
  return NextResponse.json({ appointment: cancelled, ...outcome })
}
