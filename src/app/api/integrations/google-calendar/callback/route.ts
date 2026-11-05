import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { exchangeCode, fetchUserEmail, hasCalendarScopes } from '@/lib/google/calendar-api'

import { markAppointmentsDirty, saveConnection } from '../_lib/connection'
import {
  STATE_COOKIE,
  readGoogleEnv,
  returnUrl,
  stateCookie,
  statesMatch,
  type ReturnReason,
} from '../_lib/google-env'

// ============================================================
// GET /api/integrations/google-calendar/callback
//
// Google vuelve aquí con `code` y `state`. Orden (diseño §5):
//   1. El `state` de la URL debe ser igual al de la cookie (tiempo
//      constante). La cookie se borra siempre: sirve una sola vez.
//   2. Exige admin otra vez (la sesión pudo cambiar en el camino).
//   3. Cambia el código por tokens y revisa que Google haya dado el
//      permiso permanente y los dos permisos de calendario.
//   4. Guarda la conexión con el service role (el permiso va cifrado)
//      y marca para copiar las citas de la ventana.
//   5. Vuelve a /agenda/configuracion?google=ok (o ?google=error con
//      un motivo corto que la pantalla traduce a un mensaje).
//
// Nada que Google mande (código, tokens, correo) se escribe en logs.
// ============================================================

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const env = readGoogleEnv()
  // Sin la dirección configurada, se vuelve a donde llegó la petición.
  const appUrl = env?.appUrl ?? url.origin

  const finish = (result: 'ok' | ReturnReason) => {
    const response = NextResponse.redirect(returnUrl(appUrl, result))
    // El state sirve una sola vez: se borra pase lo que pase.
    response.cookies.set(stateCookie('', 0))
    return response
  }

  try {
    const fromCookie = request.cookies.get(STATE_COOKIE)?.value
    if (!statesMatch(fromCookie, url.searchParams.get('state'))) return finish('state')

    const ctx = await requireRole('admin')

    if (url.searchParams.get('error')) return finish('denied')
    const code = url.searchParams.get('code')
    if (!code) return finish('code')
    if (!env) return finish('config')

    let tokens
    try {
      tokens = await exchangeCode({
        code,
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        redirectUri: env.redirectUri,
      })
    } catch (err) {
      // Los errores de calendar-api solo traen un código corto y el estado HTTP.
      console.error('[google-calendar] No se pudo cambiar el código:', errorText(err))
      return finish('google')
    }

    if (!hasCalendarScopes(tokens.scope)) return finish('scopes')
    if (!tokens.refreshToken) return finish('no_refresh_token')

    // El correo es solo informativo: si falla, se conecta igual.
    const email = await fetchUserEmail({ accessToken: tokens.accessToken }).catch(() => null)

    const db = supabaseAdmin()
    try {
      await saveConnection(db, {
        accountId: ctx.accountId,
        userId: ctx.userId,
        email,
        refreshToken: tokens.refreshToken,
      })
    } catch (err) {
      console.error('[google-calendar] No se pudo guardar la conexión:', errorText(err))
      return finish('save')
    }

    // Ya conectado: si esto falla, el cron igual copia las citas sucias.
    try {
      await markAppointmentsDirty(db, ctx.accountId)
    } catch (err) {
      console.error('[google-calendar] No se pudieron marcar las citas:', errorText(err))
    }

    return finish('ok')
  } catch (err) {
    // Sin sesión o sin permiso (401/403), o una falla inesperada (500 genérico).
    return toErrorResponse(err)
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'error desconocido'
}
