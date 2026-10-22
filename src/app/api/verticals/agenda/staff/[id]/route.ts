import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateStaffUpdate } from '@/verticals/agenda/config'
import { updateStaff } from '@/verticals/agenda/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../../_lib/http'

// ============================================================
// PATCH /api/verticals/agenda/staff/[id]
//
// Edita un barbero: nombre, descripción y activo/inactivo. Sin
// DELETE: un barbero desactivado deja de ofrecerse en nuevas
// reservas y su historial (citas, bloqueos, horario) se conserva.
//
// Un id de otra cuenta se comporta como inexistente (404).
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const parsed = validateStaffUpdate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const staff = await updateStaff(ctx.supabase, ctx.accountId, id, parsed.value)
    return NextResponse.json({ staff })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
