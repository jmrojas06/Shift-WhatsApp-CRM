import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateOrder, validateServiceCreate } from '@/verticals/agenda/config'
import {
  createService,
  listServiceIds,
  reorderServices,
} from '@/verticals/agenda/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// ============================================================
// /api/verticals/agenda/services
//
//   POST — crea un servicio (nombre único por cuenta, case-insensitive).
//   PUT  — reordena el catálogo: body `{ ids }` con la permutación
//          exacta de los servicios actuales (idempotente).
//
// Guardas: owner/admin; validación en config.ts; escrituras acotadas
// a `ctx.accountId` con el cliente RLS del usuario. Desactivar es un
// PATCH (`is_active: false`), nunca un DELETE: el historial de citas
// referencia estas filas.
// ============================================================

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const parsed = validateServiceCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const service = await createService(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      parsed.value,
    )
    return NextResponse.json({ service })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')

    // La permutación se valida contra los ids reales de la cuenta:
    // un id ajeno o faltante se rechaza antes de tocar nada.
    const currentIds = await listServiceIds(ctx.supabase, ctx.accountId)
    const parsed = validateOrder(await readJsonBody(request), currentIds)
    if (!parsed.ok) return badRequest(parsed.message)

    await reorderServices(ctx.supabase, ctx.accountId, parsed.value)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
