import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateTimeOffCreate } from '@/verticals/barberia/config'
import { createTimeOff } from '@/verticals/barberia/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// ============================================================
// POST /api/verticals/barberia/time-off
//
// Bloqueo puntual de un barbero (vacaciones, cita médica, día no
// disponible): body `{ staff_id, starts_at, ends_at, reason? }` con
// fechas ISO. Mientras el bloqueo está vigente, el bot no ofrece
// horas en ese rango (computeDaySlots lo resta).
//
// El barbero debe ser de la cuenta (404 si no) y el rango ISO debe
// tener fin > inicio y durar máximo 366 días.
// ============================================================

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const parsed = validateTimeOffCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const timeOff = await createTimeOff(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      parsed.value,
    )
    return NextResponse.json({ timeOff })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
