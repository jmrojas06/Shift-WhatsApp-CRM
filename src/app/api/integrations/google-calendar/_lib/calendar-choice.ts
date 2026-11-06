import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import { GoogleError, listWritableCalendars } from '@/lib/google/calendar-api'

import { ConnectionProblem, getAccessToken } from './access-token'
import { DEFAULT_CALENDAR_ID } from './connection'
import { GOOGLE_API_TEXTS } from './google-env'

// ============================================================
// Elegir un calendario de Google (el general o el de un profesional).
//
// El navegador manda un id como texto: no se confía en él. Antes de
// guardarlo se comprueba, desde el servidor y con el permiso guardado,
// que sea uno de los calendarios donde la conexión activa puede escribir.
// Sin conexión activa no se puede elegir ninguno.
//
// `primary` es el nombre que Google le da al calendario principal de la
// cuenta conectada: siempre vale (es el que queda por defecto).
// ============================================================

/** El calendario elegido no está entre los que la cuenta conectada puede editar. */
export class CalendarNotAllowed extends Error {
  constructor() {
    super('The calendar is not one of the connected account writable calendars')
    this.name = 'CalendarNotAllowed'
  }
}

/**
 * Lanza `ConnectionProblem` (sin conexión activa, sin variables de Google, permiso
 * revocado, Google no responde), `GoogleError` (falla al listar) o
 * `CalendarNotAllowed` (el id no es de esa cuenta). Si no lanza, el id es válido.
 */
export async function ensureWritableCalendar(
  db: SupabaseClient,
  accountId: string,
  calendarId: string,
): Promise<void> {
  const accessToken = await getAccessToken(db, accountId)
  if (calendarId === DEFAULT_CALENDAR_ID) return

  const calendars = await listWritableCalendars({ accessToken })
  if (!calendars.some((calendar) => calendar.id === calendarId)) throw new CalendarNotAllowed()
}

/** Respuesta lista para los errores de `ensureWritableCalendar`; `null` si el error es otro. */
export function calendarChoiceErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ConnectionProblem) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  if (err instanceof CalendarNotAllowed) {
    return NextResponse.json({ error: GOOGLE_API_TEXTS.invalidCalendar }, { status: 400 })
  }
  if (err instanceof GoogleError) {
    // Los errores de calendar-api solo traen códigos cortos: seguros para el log.
    console.error('[google-calendar] No se pudieron listar los calendarios:', err.message)
    return NextResponse.json({ error: GOOGLE_API_TEXTS.googleFailed }, { status: 502 })
  }
  return null
}
