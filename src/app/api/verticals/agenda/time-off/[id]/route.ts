import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { deleteTimeOff } from '@/verticals/agenda/config-repo'

import { configErrorResponse } from '../../_lib/http'

// ============================================================
// DELETE /api/verticals/agenda/time-off/[id]
//
// Elimina un bloqueo puntual (los bloqueos SÍ se borran: solo
// afectan disponibilidad futura). Un id de otra cuenta se comporta
// como inexistente (404) y la fila ajena no se toca.
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    await deleteTimeOff(ctx.supabase, ctx.accountId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
