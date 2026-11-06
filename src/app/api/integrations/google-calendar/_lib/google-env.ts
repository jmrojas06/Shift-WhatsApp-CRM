import { randomBytes, timingSafeEqual } from 'node:crypto'

// ============================================================
// Piezas compartidas por las rutas de Google Calendar:
// variables de entorno, el `state` anti-CSRF del OAuth y la URL
// a la que se vuelve después de conectar.
// ============================================================

export const CALLBACK_PATH = '/api/integrations/google-calendar/callback'
export const SETTINGS_PAGE = '/agenda/configuracion'

/** Cookie con el `state` de la conexión en curso. */
export const STATE_COOKIE = 'gcal_state'
const STATE_TTL_SECONDS = 10 * 60

export interface GoogleEnv {
  clientId: string
  clientSecret: string
  /** Dirección pública de la app, sin barra final. */
  appUrl: string
  /** Debe ser idéntica a la que se registró en Google Cloud. */
  redirectUri: string
}

type EnvSource = Record<string, string | undefined>

/**
 * Lee las variables que hacen falta: el ID y el secreto de Google, y la
 * dirección pública de la app. Esa dirección es `NEXT_PUBLIC_SITE_URL` (la que
 * ya usan .env.local.example, el compose y las guías de despliegue) y, si no
 * está, `NEXT_PUBLIC_APP_URL`. Devuelve `null` si falta algo (las rutas
 * contestan 503 con un mensaje claro).
 */
export function readGoogleEnv(env: EnvSource = process.env): GoogleEnv | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim()
  const baseUrl = (name: string) => env[name]?.trim().replace(/\/+$/, '')
  const appUrl = baseUrl('NEXT_PUBLIC_SITE_URL') || baseUrl('NEXT_PUBLIC_APP_URL')
  if (!clientId || !clientSecret || !appUrl) return null
  return { clientId, clientSecret, appUrl, redirectUri: `${appUrl}${CALLBACK_PATH}` }
}

/** 32 bytes aleatorios en base64url (43 caracteres). */
export function newState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Compara el `state` de la URL con el de la cookie en tiempo constante.
 * Un valor ausente, vacío o de otro largo nunca coincide.
 */
export function statesMatch(
  fromCookie: string | undefined | null,
  fromUrl: string | undefined | null,
): boolean {
  if (!fromCookie || !fromUrl) return false
  const a = Buffer.from(fromCookie)
  const b = Buffer.from(fromUrl)
  // El largo no es secreto: timingSafeEqual exige que sea igual.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Opciones de la cookie del `state`: solo el servidor la lee, solo vale 10 minutos. */
export function stateCookie(value: string, maxAgeSeconds = STATE_TTL_SECONDS) {
  return {
    name: STATE_COOKIE,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds,
    // Solo viaja al callback.
    path: CALLBACK_PATH,
  }
}

/** Motivos cortos del error al volver. La pantalla los traduce a un mensaje. */
export const RETURN_REASONS = [
  'denied', // la persona canceló en la pantalla de Google
  'state', // el state no coincide o venció
  'code', // Google no mandó el código
  'scopes', // desmarcaron algún permiso de calendario
  'no_refresh_token', // Google no entregó el permiso permanente
  'google', // Google rechazó el código o no respondió
  'config', // faltan las variables en el servidor
  'save', // no se pudo guardar la conexión
] as const

export type ReturnReason = (typeof RETURN_REASONS)[number]

/** URL de la configuración con el resultado de conectar. */
export function returnUrl(appUrl: string, result: 'ok' | ReturnReason): string {
  const query = result === 'ok' ? 'google=ok' : `google=error&reason=${result}`
  return `${appUrl}${SETTINGS_PAGE}?${query}`
}

/** Mensajes de las rutas JSON (en español, para la pantalla). */
export const GOOGLE_API_TEXTS = {
  notConfigured:
    'Google Calendar todavía no está listo en este servidor. Falta configurar GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y NEXT_PUBLIC_SITE_URL.',
  notConnected: 'Primero conecta Google Calendar.',
  revoked: 'Google dejó de dar permiso. Vuelve a conectar Google Calendar.',
  cannotReadToken:
    'No se pudo leer el permiso guardado de Google. Vuelve a conectar Google Calendar.',
  googleFailed: 'No se pudo hablar con Google. Intenta de nuevo en un momento.',
  invalidCalendar: 'Elige un calendario de la lista.',
  invalidBody: 'Los datos no son válidos.',
  saveFailed: 'No se pudo guardar. Intenta de nuevo.',
} as const
