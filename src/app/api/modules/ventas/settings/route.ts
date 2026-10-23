import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { requireModule, toModuleErrorResponse } from '@/lib/modules/require-module'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { SALES_SETTING_KEYS, saveSalesSettings, type SalesSettings } from '@/modules/ventas/repo'

import { badRequest, isRecord, readJsonBody, salesErrorResponse } from '../_lib/http'

// ============================================================
// PATCH /api/modules/ventas/settings — interruptores de los avisos.
//
// Cuerpo: { notify_paid?, notify_shipped?, notify_delivered? }, todos
// booleanos y al menos uno. Lo que no se envía no se toca. Solo
// owner/admin (requireRole('admin')) y con el módulo Ventas activo.
// Las claves desconocidas se ignoran.
// ============================================================

const INVALID = 'Los ajustes no son válidos.'

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'ventas')

    const body = await readJsonBody(request)
    if (!isRecord(body)) return badRequest(INVALID)

    const patch: Partial<SalesSettings> = {}
    for (const key of SALES_SETTING_KEYS) {
      const value = body[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') {
        return badRequest('Cada aviso debe ser sí o no.')
      }
      patch[key] = value
    }
    if (Object.keys(patch).length === 0) {
      return badRequest('Indica al menos un aviso para cambiar.')
    }

    const settings = await saveSalesSettings(supabaseAdmin(), ctx.accountId, patch)
    return NextResponse.json({ settings })
  } catch (err) {
    return salesErrorResponse(err) ?? toModuleErrorResponse(err)
  }
}
