import { NextResponse } from 'next/server'

import {
  calendarChoiceErrorResponse,
  ensureWritableCalendar,
} from '@/app/api/integrations/google-calendar/_lib/calendar-choice'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { validateStaffUpdate } from '@/verticals/agenda/config'
import { updateStaff } from '@/verticals/agenda/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../../_lib/http'

// ============================================================
// PATCH /api/verticals/agenda/staff/[id]
//
// Edita un barbero: nombre, descripción, activo/inactivo y su
// calendario de Google. Sin DELETE: un barbero desactivado deja de
// ofrecerse en nuevas reservas y su historial (citas, bloqueos,
// horario) se conserva.
//
// El calendario de Google solo puede ser uno de la lista de la
// conexión activa (se comprueba en el servidor con el permiso
// guardado; la tabla de la conexión no se lee con la sesión del
// navegador). Quitarlo (`null`) siempre se puede.
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

    if (typeof parsed.value.googleCalendarId === 'string') {
      await ensureWritableCalendar(supabaseAdmin(), ctx.accountId, parsed.value.googleCalendarId)
    }

    const staff = await updateStaff(ctx.supabase, ctx.accountId, id, parsed.value)
    return NextResponse.json({ staff })
  } catch (err) {
    return (
      calendarChoiceErrorResponse(err) ?? configErrorResponse(err) ?? toErrorResponse(err)
    )
  }
}
