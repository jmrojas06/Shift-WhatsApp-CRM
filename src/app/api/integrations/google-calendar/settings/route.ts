import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

import {
  MAX_CALENDAR_ID_LENGTH,
  readConnection,
  toSafeSettings,
  type ConnectionRow,
} from '../_lib/connection'
import { GOOGLE_API_TEXTS, readGoogleEnv } from '../_lib/google-env'

// ============================================================
// /api/integrations/google-calendar/settings
//
//   GET   — estado de la conexión para la pantalla: si el servidor
//           tiene Google configurado, si hay conexión, correo, estado,
//           último error, última copia y calendario general.
//   PATCH — guarda el calendario general: body `{ default_calendar_id }`.
//
// Solo owner/admin. La tabla no tiene políticas para clientes, así que
// se lee con el service role, siempre acotado a la cuenta de la sesión.
// La respuesta se arma campo por campo (`toSafeSettings`): el permiso
// permanente cifrado nunca sale de aquí.
// ============================================================

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const row = await readConnection(supabaseAdmin(), ctx.accountId)
    return NextResponse.json(toSafeSettings(row, readGoogleEnv() !== null))
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const calendarId = parseCalendarId(await readBody(request))
    if (!calendarId) {
      return NextResponse.json({ error: GOOGLE_API_TEXTS.invalidCalendar }, { status: 400 })
    }

    const db = supabaseAdmin()
    if (!(await readConnection(db, ctx.accountId))) {
      return NextResponse.json({ error: GOOGLE_API_TEXTS.notConnected }, { status: 409 })
    }

    const { data, error } = await db
      .from('agenda_calendar_connections')
      .update({ default_calendar_id: calendarId, updated_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
      .select('account_id, google_email, default_calendar_id, status, last_error, last_sync_at')
      .maybeSingle()
    if (error) throw new Error(`No se pudo guardar el calendario: ${error.message}`)
    if (!data) {
      return NextResponse.json({ error: GOOGLE_API_TEXTS.notConnected }, { status: 409 })
    }

    return NextResponse.json(
      toSafeSettings(data as ConnectionRow, readGoogleEnv() !== null),
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

/** El id de un calendario de Google: texto de una línea, de 1 a 300 caracteres. */
function parseCalendarId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = (body as { default_calendar_id?: unknown }).default_calendar_id
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (id === '' || id.length > MAX_CALENDAR_ID_LENGTH || CONTROL_CHARS.test(id)) return null
  return id
}
