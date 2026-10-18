import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateStaffServices } from '@/verticals/barberia/config'
import { setStaffServices } from '@/verticals/barberia/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../../../_lib/http'

// ============================================================
// PUT /api/verticals/barberia/staff/[id]/services
//
// Relación barbero ↔ servicios (qué atiende cada barbero):
// body `{ service_ids: string[] }` — el set completo, no un delta.
//
// Se aplica por DIFF: la intersección no se toca, se agregan los
// nuevos y se borran los que salieron (guardar dos veces el mismo
// set no reescribe filas). Todos los ids deben ser de la cuenta: el
// barbero y los servicios se validan antes de escribir nada.
// La ausencia de relación no borra historial; solo deja de ofrecer
// combinaciones nuevas al bot.
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const parsed = validateStaffServices(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const count = await setStaffServices(
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
