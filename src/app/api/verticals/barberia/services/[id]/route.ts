import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateServiceUpdate } from '@/verticals/barberia/config'
import { updateService } from '@/verticals/barberia/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../../_lib/http'

// ============================================================
// PATCH /api/verticals/barberia/services/[id]
//
// Edita un servicio del catálogo: nombre, descripción, duración,
// precio y activo/inactivo. No hay DELETE a propósito: desactivar
// saca el servicio de nuevas reservas y conserva el historial.
//
// Un id de otra cuenta se comporta como inexistente (404): el repo
// filtra por `account_id` en lectura y escritura.
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const parsed = validateServiceUpdate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const service = await updateService(ctx.supabase, ctx.accountId, id, parsed.value)
    return NextResponse.json({ service })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
