import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { listEligibleStaff } from '@/verticals/agenda/agent/db'
import { createInternalBackend } from '@/verticals/agenda/agent/internal-backend'
import {
  accountHasClinic,
  loadBookableService,
  loadBookableStaff,
  loadPanelLabels,
  staffServesService,
} from '@/verticals/agenda/panel-booking-repo'
import { parseSlotsQuery, toPanelSlots } from '@/verticals/agenda/panel-slots'

import { panelError, panelRejection } from '../_lib/panel-http'

// ============================================================
// GET /api/verticals/agenda/slots
//
// Las horas libres que el panel ofrece al crear o mover una cita:
//
//   ?service_id=<uuid>&date=YYYY-MM-DD
//   [&staff_id=<uuid>]   un profesional; sin él, "Cualquiera": todos
//                        los activos que atienden el servicio
//   [&exclude=<uuid>]    la cita que se está moviendo: ni ella ni su
//                        sillón cuentan como ocupados
//
// Usa el mismo cálculo que el bot (InternalBackend): horario semanal,
// citas activas, bloqueos y, en una clínica, el cupo de sillones. Así
// el panel y el bot ofrecen exactamente lo mismo. La hora de "ahora" es
// la real, con el mismo margen de anticipación del bot.
//
// Respuesta 200: `{ slots: [{ starts_at, staff_ids }] }`, en orden;
// `starts_at` es ISO en UTC y `staff_ids` quiénes están libres a esa
// hora. Un día sin horas devuelve `slots: []`.
// Errores: `{ error, code }` (ver _lib/panel-http.ts). Si no se puede
// leer la agenda responde 500 sin detalles: nunca se ofrecen horas a
// ciegas.
// ============================================================

const NOT_FOUND_MESSAGE =
  'Esa opción ya no existe o está desactivada. Recarga la página e intenta de nuevo.'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const { accountId } = ctx
    const db = ctx.supabase

    const parsed = parseSlotsQuery(new URL(request.url).searchParams)
    if (!parsed.ok) return panelError(400, 'invalid_query', parsed.message)
    const query = parsed.value

    const service = await loadBookableService(db, accountId, query.serviceId)
    if (!service) return panelError(404, 'service_not_found', NOT_FOUND_MESSAGE)

    let staffIds: string[]
    if (query.staffId) {
      const staff = await loadBookableStaff(db, accountId, query.staffId)
      if (!staff) return panelError(404, 'staff_not_found', NOT_FOUND_MESSAGE)
      if (!(await staffServesService(db, accountId, staff.id, service.id))) {
        return panelRejection('staff_not_for_service', await loadPanelLabels(db, accountId))
      }
      staffIds = [staff.id]
    } else {
      staffIds = (await listEligibleStaff(db, accountId, service.id, { strict: true })).map((staff) => staff.id)
    }
    if (staffIds.length === 0) return NextResponse.json({ slots: [] })

    const backend = createInternalBackend({
      db,
      accountId,
      clinic: await accountHasClinic(db, accountId),
    })
    const slots = await backend.getDaySlots({
      // El cálculo solo usa la duración; el resto es lo que pide el contrato del bot.
      service: {
        id: service.id,
        name: service.name,
        description: null,
        durationMinutes: service.durationMinutes,
        price: 0,
      },
      staffIds,
      dateKey: query.dateKey,
      now: new Date(),
      excludeAppointmentId: query.excludeAppointmentId ?? undefined,
    })

    return NextResponse.json({ slots: toPanelSlots(slots) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
