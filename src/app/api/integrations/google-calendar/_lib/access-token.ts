import type { SupabaseClient } from '@supabase/supabase-js'

import {
  GoogleAuthError,
  GoogleError,
  refreshAccessToken,
} from '@/lib/google/calendar-api'
import { decrypt } from '@/lib/whatsapp/encryption'

import { readConnection } from './connection'
import { GOOGLE_API_TEXTS, readGoogleEnv } from './google-env'

// ============================================================
// Un access token fresco para hablar con Google en nombre de la
// cuenta. Las rutas que lo piden (hoy, la lista de calendarios)
// atrapan `ConnectionProblem` y contestan con su estado y mensaje.
// ============================================================

/** Texto que queda en la conexión cuando Google revoca el permiso (el mismo de la sincronización). */
const REVOKED_ERROR = 'Google revocó el permiso de Shift. Vuelve a conectar Google Calendar.'

/** Algo impide hablar con Google. `message` ya está listo para la pantalla. */
export class ConnectionProblem extends Error {
  readonly status: 409 | 502 | 503

  constructor(status: 409 | 502 | 503, message: string) {
    super(message)
    this.name = 'ConnectionProblem'
    this.status = status
  }
}

export async function getAccessToken(db: SupabaseClient, accountId: string): Promise<string> {
  const connection = await readConnection(db, accountId)
  if (!connection) throw new ConnectionProblem(409, GOOGLE_API_TEXTS.notConnected)
  if (connection.status === 'revoked') throw new ConnectionProblem(409, GOOGLE_API_TEXTS.revoked)

  const env = readGoogleEnv()
  if (!env) throw new ConnectionProblem(503, GOOGLE_API_TEXTS.notConfigured)

  let refreshToken: string
  try {
    refreshToken = decrypt(connection.refresh_token_encrypted)
  } catch {
    throw new ConnectionProblem(409, GOOGLE_API_TEXTS.cannotReadToken)
  }

  try {
    const access = await refreshAccessToken({
      refreshToken,
      clientId: env.clientId,
      clientSecret: env.clientSecret,
    })
    return access.accessToken
  } catch (err) {
    if (err instanceof GoogleAuthError && err.code === 'invalid_grant') {
      await markRevoked(db, accountId)
      throw new ConnectionProblem(409, GOOGLE_API_TEXTS.revoked)
    }
    // Los errores de calendar-api solo traen códigos cortos: seguros para el log.
    console.error(
      '[google-calendar] No se pudo renovar el acceso:',
      err instanceof GoogleError ? err.message : 'error desconocido',
    )
    throw new ConnectionProblem(502, GOOGLE_API_TEXTS.googleFailed)
  }
}

/** Pasa la conexión a `revoked` (solo si seguía activa), como hace la sincronización. */
async function markRevoked(db: SupabaseClient, accountId: string): Promise<void> {
  const { error } = await db
    .from('agenda_calendar_connections')
    .update({ status: 'revoked', last_error: REVOKED_ERROR })
    .eq('account_id', accountId)
    .eq('status', 'active')
  if (error) {
    console.error('[google-calendar] No se pudo marcar la conexión como revocada:', error.message)
  }
}
