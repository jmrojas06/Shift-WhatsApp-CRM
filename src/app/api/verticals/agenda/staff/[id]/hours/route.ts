import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateWorkingHours } from '@/verticals/agenda/config'
import { replaceWorkingHours } from '@/verticals/agenda/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../../../_lib/http'

// ============================================================
// PUT /api/verticals/agenda/staff/[id]/hours
//
// Horario semanal del barbero: body `{ hours: [{ weekday, start_time,
// end_time }] }` — el set completo ([] borra el horario).
//
// Reglas (config.ts): weekday 0-6 (0 = domingo), horas HH:MM, fin >
// inicio y sin traslapes dentro del mismo día. Los bloques que se
// tocan (12:00→13:00) son válidos: así se modela el almuerzo con
// turnos partidos.
//
// La disponibilidad del bot se calcula en vivo contra estas filas:
// el cambio aplica de inmediato a nuevas reservas y NO toca citas ya
// confirmadas (guardan su propio starts_at/ends_at).
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const body = (await readJsonBody(request)) as { hours?: unknown } | null
    const parsed = validateWorkingHours(body?.hours)
    if (!parsed.ok) return badRequest(parsed.message)

    const count = await replaceWorkingHours(
      ctx.supabase,
      ctx.accountId,
      id,
      parsed.value,
    )
    return NextResponse.json({ ok: true, count })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
