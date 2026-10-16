import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  isAppointmentStatus,
  validateStatusChange,
  type AppointmentStatus,
  type StatusChangeRejection,
} from '@/verticals/barberia/appointments'

// ============================================================
// PATCH /api/verticals/barberia/appointments/[id]
//
// La agenda del día mueve una cita entre estados operativos
// (completed / no_show / cancelled, o pending → confirmed).
//
// Guardas:
//   - requireRole('agent'): viewers son solo-lectura (la política
//     RLS booking_appointments_update exige lo mismo — doble capa).
//   - La cita SIEMPRE se lee y se escribe acotada por account_id.
//   - Las reglas de transición y la confirmación de citas pasadas
//     viven en verticals/barberia/appointments.ts (probadas).
//   - Update optimista por estado: si alguien más la movió entre la
//     lectura y la escritura, se avisa en vez de sobrescribir.
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

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as {
      status?: unknown
      confirm_past?: unknown
    } | null
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
      console.error('[barberia appointments] no se pudo leer la cita:', loadError)
      return NextResponse.json(
        { error: 'No se pudo leer la cita.' },
        { status: 500 },
      )
    }
    if (!appointment) {
      return NextResponse.json(
        { error: 'La cita no existe.', code: 'not_found' },
        { status: 404 },
      )
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
        '[barberia appointments] no se pudo actualizar la cita:',
        updateError,
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

    return NextResponse.json({ appointment: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
