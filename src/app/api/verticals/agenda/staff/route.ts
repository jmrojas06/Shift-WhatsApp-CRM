import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateOrder, validateStaffCreate } from '@/verticals/agenda/config'
import {
  createStaff,
  listStaffIds,
  reorderStaff,
} from '@/verticals/agenda/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// ============================================================
// /api/verticals/agenda/staff
//
//   POST — crea un barbero (nombre único por cuenta).
//   PUT  — reordena el equipo: body `{ ids }` con la permutación
//          exacta de los barberos actuales.
//
// Guardas: owner/admin; validación en config.ts; escrituras acotadas
// a `ctx.accountId`. Desactivar es PATCH `is_active: false`: los
// bloqueos y el historial quedan intactos.
// ============================================================

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const parsed = validateStaffCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const staff = await createStaff(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      parsed.value,
    )
    return NextResponse.json({ staff })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const currentIds = await listStaffIds(ctx.supabase, ctx.accountId)
    const parsed = validateOrder(await readJsonBody(request), currentIds)
    if (!parsed.ok) return badRequest(parsed.message)

    await reorderStaff(ctx.supabase, ctx.accountId, parsed.value)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
