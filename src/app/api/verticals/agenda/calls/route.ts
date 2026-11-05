import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { CallListError, loadCallList } from '@/verticals/agenda/call-list'
import { callListRowToPayload, type CallListResponse } from '@/verticals/agenda/call-list-payload'
import {
  countManualCalls,
  insertManualCall,
  isCallable,
  loadCallTarget,
  MANUAL_ATTEMPTS_MAX,
  parseManualCallBody,
  writeAttendanceConfirmed,
} from '@/verticals/agenda/manual-calls'
import { loadPanelLabels, writeCancel } from '@/verticals/agenda/panel-booking-repo'
import { notifyIfRequested } from '@/verticals/agenda/panel-notify'
import { PATIENT_CALL_CANCEL_REASON } from '@/verticals/agenda/voice/effects'

import { panelError, panelRejection, scheduleCalendarKick } from '../_lib/panel-http'

// ============================================================
// /api/verticals/agenda/calls — la lista "Para llamar" de /agenda.
//
//   GET   → { rows, outbound_enabled }
//       Las citas activas de las próximas 48 h a las que le toca llamar a una
//       persona (ver verticals/agenda/call-list.ts). Cualquier miembro la lee.
//
//   POST { appointment_id, outcome, notify? }
//       La recepción anota cómo le fue en una llamada a mano. `outcome`:
//         confirmed     el paciente dijo que va → `attendance_confirmed_at`.
//         cancelled     el paciente canceló → la cita pasa a `cancelled` (motivo
//                       'patient_call'), con aviso opcional por WhatsApp.
//         no_response   no contestó → solo queda en el historial.
//         wrong_number  el número no es del paciente → solo el historial.
//       Responde { ok, recorded, attempt, notified?, notify_error?, note? }.
//       `recorded: false` = la llamada no quedó en el historial (la base admite
//       3 llamadas manuales por cita); lo que cambia la cita igual se aplicó.
//
// Guardas:
//   - requireRole('agent') para anotar: un viewer solo lee (la RLS de la
//     migración 056 exige lo mismo para insertar).
//   - La cuenta sale de la sesión, nunca del cuerpo; toda lectura y escritura
//     va acotada a ella.
//   - Primero se cambia la cita y después se anota la llamada: una fila que dice
//     "confirmó" sin que la cita haya cambiado sería peor que no anotarla.
//   - El aviso al paciente y la copia a Google nunca deshacen la cancelación.
// Los textos de error no llevan el teléfono ni el nombre del paciente.
// ============================================================

const MESSAGES = {
  badBody: 'La solicitud no es válida. Recarga la página e intenta de nuevo.',
  notFound: 'La cita no existe.',
  notActive: 'Esta cita ya no está activa. Recarga la lista.',
  alreadyConfirmed: 'El paciente ya confirmó esta cita.',
  migrationMissing: 'Falta actualizar la base de datos. Avísale a Shift.',
  historyFull: `Ya hay ${MANUAL_ATTEMPTS_MAX} llamadas anotadas a esta cita, así que esta no quedó en el historial.`,
  historyFailed: 'La cita se actualizó, pero no se pudo guardar la llamada en el historial.',
} as const

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const { rows, outboundEnabled } = await loadCallList(ctx.supabase, {
      accountId: ctx.accountId,
      now: new Date(),
    })
    const payload: CallListResponse = {
      rows: rows.map(callListRowToPayload),
      outbound_enabled: outboundEnabled,
    }
    return NextResponse.json(payload)
  } catch (err) {
    // A la base le falta la 056: no es un fallo que la recepción pueda arreglar.
    if (err instanceof CallListError && err.missingMigration) {
      console.error('[agenda calls] falta la migración 056:', err.message)
      return panelError(503, 'migration_missing', MESSAGES.migrationMissing)
    }
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const { accountId, userId } = ctx
    const db = ctx.supabase

    const parsed = parseManualCallBody(await request.json().catch(() => null))
    if (!parsed.ok) return panelError(400, 'invalid_body', parsed.message)
    const input = parsed.value

    const target = await loadCallTarget(db, accountId, input.appointmentId)
    if (!target) return panelError(404, 'not_found', MESSAGES.notFound)

    const now = new Date()
    const nowIso = now.toISOString()
    if (!isCallable(target, now)) return panelError(409, 'not_active', MESSAGES.notActive)
    if (input.outcome === 'confirmed' && target.attendanceConfirmedAt) {
      return panelError(409, 'already_confirmed', MESSAGES.alreadyConfirmed)
    }

    // 1) Lo que cambia la cita.
    let notice: { notified: boolean; notify_error?: string } | null = null
    if (input.outcome === 'confirmed') {
      const written = await writeAttendanceConfirmed(db, {
        accountId,
        appointmentId: input.appointmentId,
        nowIso,
      })
      if (!written) return panelRejection('stale', await loadPanelLabels(db, accountId))
      scheduleCalendarKick(accountId)
    } else if (input.outcome === 'cancelled') {
      const cancelled = await writeCancel(db, {
        accountId,
        appointment: target.appointment,
        reason: PATIENT_CALL_CANCEL_REASON,
        nowIso,
      })
      if (!cancelled) return panelRejection('stale', await loadPanelLabels(db, accountId))
      scheduleCalendarKick(accountId)
      notice = await notifyIfRequested(input.notify, () => ({
        db: supabaseAdmin(),
        accountId,
        appointmentId: input.appointmentId,
        kind: 'cancelled',
        now,
      }))
    }
    const changedAppointment = input.outcome === 'confirmed' || input.outcome === 'cancelled'

    // 2) La llamada, en el historial.
    const previous = await countManualCalls(db, accountId, input.appointmentId)
    if (previous >= MANUAL_ATTEMPTS_MAX) {
      return NextResponse.json({
        ok: true,
        recorded: false,
        attempt: null,
        note: MESSAGES.historyFull,
        ...notice,
      })
    }

    const attempt = previous + 1
    try {
      await insertManualCall(db, {
        accountId,
        appointmentId: input.appointmentId,
        contactId: target.contactId,
        userId,
        attempt,
        outcome: input.outcome,
        nowIso,
      })
    } catch (err) {
      // Sin cambio en la cita, lo único que había que hacer era anotar: es un error.
      if (!changedAppointment) throw err
      console.error('[agenda calls] no se pudo anotar la llamada:', err instanceof Error ? err.message : 'error')
      return NextResponse.json({
        ok: true,
        recorded: false,
        attempt: null,
        note: MESSAGES.historyFailed,
        ...notice,
      })
    }

    return NextResponse.json({ ok: true, recorded: true, attempt, ...notice })
  } catch (err) {
    return toErrorResponse(err)
  }
}
