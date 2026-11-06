import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { buildAuthUrl } from '@/lib/google/calendar-api'

import {
  GOOGLE_API_TEXTS,
  newState,
  readGoogleEnv,
  stateCookie,
} from '../_lib/google-env'

// ============================================================
// GET /api/integrations/google-calendar/connect
//
// Empieza la conexión: solo owner/admin. Crea un `state` aleatorio, lo
// deja en una cookie httpOnly de 10 minutos (solo viaja al callback) y
// manda a la persona a la pantalla de permisos de Google. El callback
// compara el `state` de la URL con el de la cookie.
//
// Es un GET porque el navegador llega aquí con un enlace normal; si
// faltan las variables de Google contesta 503 (la pantalla ya lo avisa
// antes de mostrar el botón, con `configured` de /settings).
// ============================================================

export async function GET() {
  try {
    await requireRole('admin')

    const env = readGoogleEnv()
    if (!env) {
      return NextResponse.json({ error: GOOGLE_API_TEXTS.notConfigured }, { status: 503 })
    }

    const state = newState()
    const response = NextResponse.redirect(
      buildAuthUrl({ clientId: env.clientId, redirectUri: env.redirectUri, state }),
    )
    response.cookies.set(stateCookie(state))
    return response
  } catch (err) {
    return toErrorResponse(err)
  }
}
