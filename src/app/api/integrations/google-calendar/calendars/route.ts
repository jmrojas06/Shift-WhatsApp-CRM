import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { GoogleError, listWritableCalendars } from '@/lib/google/calendar-api'

import { ConnectionProblem, getAccessToken } from '../_lib/access-token'
import { GOOGLE_API_TEXTS } from '../_lib/google-env'

// ============================================================
// GET /api/integrations/google-calendar/calendars
//
// Calendarios de Google donde se puede escribir (dueño o editor), con el
// principal primero. Sirve para elegir el calendario general y, si se
// quiere, uno por profesional. Solo owner/admin.
//
// Usa el permiso guardado para pedir un acceso nuevo; ni ese permiso ni
// el acceso salen en la respuesta.
// ============================================================

export async function GET() {
  try {
    const ctx = await requireRole('admin')

    const accessToken = await getAccessToken(supabaseAdmin(), ctx.accountId)
    const calendars = await listWritableCalendars({ accessToken })
    return NextResponse.json({ calendars })
  } catch (err) {
    if (err instanceof ConnectionProblem) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof GoogleError) {
      console.error('[google-calendar] No se pudieron listar los calendarios:', err.message)
      return NextResponse.json({ error: GOOGLE_API_TEXTS.googleFailed }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}
