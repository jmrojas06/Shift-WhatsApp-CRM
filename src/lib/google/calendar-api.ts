/**
 * Cliente mínimo de Google (OAuth + Calendar), sin SDK.
 *
 * - Cada función recibe un solo objeto con nombres (como `meta-api.ts`) y un
 *   `fetchImpl` opcional: en las pruebas se inyecta un `fetch` falso, en
 *   producción se usa el `fetch` global.
 * - Todas las llamadas tienen un tope de 10 segundos.
 * - Los errores son tipados y su mensaje NUNCA incluye tokens, códigos,
 *   secretos, correos ni lo que Google escriba en `message` o
 *   `error_description`: solo el código corto (`invalid_grant`,
 *   `rateLimitExceeded`...) y el estado HTTP. Este módulo no escribe en la
 *   consola.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

const REQUEST_TIMEOUT_MS = 10_000
/** Tope de páginas al listar calendarios (250 por página: de sobra). */
const MAX_CALENDAR_PAGES = 10

const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const CALENDAR_LIST_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'

/** Permisos que pedimos: correo de quien conecta, eventos y lista de calendarios. */
export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  EVENTS_SCOPE,
  CALENDAR_LIST_SCOPE,
] as const

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

/** Base de todos los fallos de este módulo. */
export class GoogleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * Falla del servidor de tokens (cambiar código, renovar token).
 * `code === 'invalid_grant'` significa que el permiso fue revocado o venció:
 * hay que reconectar. Sin código reconocible, `code` es `http_<estado>`.
 */
export class GoogleAuthError extends GoogleError {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus: number) {
    super(`Google OAuth error: ${code} (HTTP ${httpStatus})`)
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** Respuesta no exitosa de la API de Google (calendario, userinfo, revoke). */
export class GoogleApiError extends GoogleError {
  readonly httpStatus: number
  /** Motivo corto de Google (`notFound`, `rateLimitExceeded`...), si lo hay. */
  readonly reason: string | null

  constructor(httpStatus: number, reason: string | null) {
    super(`Google API error (HTTP ${httpStatus}${reason ? `, ${reason}` : ''})`)
    this.httpStatus = httpStatus
    this.reason = reason
  }
}

/** No hubo respuesta: tiempo agotado o red caída. */
export class GoogleNetworkError extends GoogleError {
  readonly kind: 'timeout' | 'network'

  constructor(kind: 'timeout' | 'network') {
    super(
      kind === 'timeout'
        ? 'Google did not respond in time'
        : 'Could not reach Google',
    )
    this.kind = kind
  }
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

interface WithFetch {
  /** Para pruebas. Por defecto, el `fetch` global. */
  fetchImpl?: typeof fetch
}

/**
 * Señal que se aborta a los `REQUEST_TIMEOUT_MS`, con `TimeoutError` como motivo
 * (igual que `AbortSignal.timeout`). Se arma con `setTimeout` y no con
 * `AbortSignal.timeout` porque este último usa un reloj interno de Node que los
 * relojes falsos de las pruebas no controlan. El temporizador no retiene el
 * proceso (`unref`) y se deja armado a propósito: así el tope también cubre la
 * lectura del cuerpo de la respuesta, y abortar una llamada ya terminada no hace
 * nada.
 */
function timeoutSignal(): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  }, REQUEST_TIMEOUT_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return controller.signal
}

async function send(
  fetchImpl: typeof fetch | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const doFetch = fetchImpl ?? fetch
  try {
    return await doFetch(url, { ...init, signal: timeoutSignal() })
  } catch (err) {
    // No se conserva el error original: puede traer cabeceras o URLs.
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw new GoogleNetworkError(timedOut ? 'timeout' : 'network')
  }
}

/** Solo deja pasar códigos cortos y sin espacios; así no se cuela texto libre. */
function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null
}

/**
 * Lee el código corto de un error de Google. Sirve para los dos formatos:
 * `{ error: 'invalid_grant', ... }` (OAuth) y
 * `{ error: { errors: [{ reason }], status } }` (APIs de Google).
 */
async function readErrorCode(res: Response): Promise<string | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await res.text())
  } catch {
    return null // cuerpo vacío o que no es JSON
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const error = (parsed as { error?: unknown }).error
  if (typeof error === 'string') return safeCode(error)
  if (typeof error === 'object' && error !== null) {
    const { errors, status } = error as { errors?: unknown; status?: unknown }
    const first = Array.isArray(errors) ? (errors[0] as { reason?: unknown } | undefined) : undefined
    return safeCode(first?.reason) ?? safeCode(status)
  }
  return null
}

async function apiError(res: Response): Promise<GoogleApiError> {
  return new GoogleApiError(res.status, await readErrorCode(res))
}

async function authError(res: Response): Promise<GoogleAuthError> {
  return new GoogleAuthError((await readErrorCode(res)) ?? `http_${res.status}`, res.status)
}

/** Lee y descarta el cuerpo para liberar la conexión. */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer()
  } catch {
    // no importa
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json()
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    // cae al error de abajo
  }
  throw new GoogleApiError(res.status, 'bad_response')
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
}

function formRequest(params: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  }
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** URL de consentimiento de Google. `state` lo genera y verifica quien llama. */
export function buildAuthUrl(args: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(AUTH_URL)
  url.search = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    // offline + consent: Google siempre entrega un refresh token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: args.state,
  }).toString()
  return url.toString()
}

/**
 * Google deja desmarcar permisos sueltos en la pantalla de consentimiento.
 * Dice si el texto `scope` de la respuesta trae los dos permisos de calendario.
 */
export function hasCalendarScopes(scope: string): boolean {
  const granted = scope.split(/\s+/)
  return granted.includes(EVENTS_SCOPE) && granted.includes(CALENDAR_LIST_SCOPE)
}

export interface GoogleAccessToken {
  accessToken: string
  expiresInSec: number
  /** Permisos concedidos, separados por espacios. */
  scope: string
}

export interface GoogleTokenExchange extends GoogleAccessToken {
  /** `null` si Google no lo entregó (pasa si ya había uno vigente). */
  refreshToken: string | null
}

/** Lee la respuesta del servidor de tokens; devuelve también el JSON crudo. */
async function parseTokenResponse(
  res: Response,
): Promise<{ token: GoogleAccessToken; raw: Record<string, unknown> }> {
  const raw = await readJson(res)
  if (typeof raw.access_token !== 'string' || raw.access_token === '') {
    throw new GoogleApiError(res.status, 'bad_response')
  }
  const expires =
    typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in) ? raw.expires_in : 3600
  return {
    token: {
      accessToken: raw.access_token,
      expiresInSec: expires,
      scope: typeof raw.scope === 'string' ? raw.scope : '',
    },
    raw,
  }
}

/** Cambia el código del callback por access token y refresh token. */
export async function exchangeCode(
  args: {
    code: string
    clientId: string
    clientSecret: string
    redirectUri: string
  } & WithFetch,
): Promise<GoogleTokenExchange> {
  const res = await send(
    args.fetchImpl,
    TOKEN_URL,
    formRequest({
      grant_type: 'authorization_code',
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
    }),
  )
  if (!res.ok) throw await authError(res)
  const { token, raw } = await parseTokenResponse(res)
  return {
    ...token,
    refreshToken:
      typeof raw.refresh_token === 'string' && raw.refresh_token !== '' ? raw.refresh_token : null,
  }
}

/**
 * Pide un access token nuevo. Si el permiso fue revocado, lanza
 * `GoogleAuthError` con `code === 'invalid_grant'`.
 */
export async function refreshAccessToken(
  args: { refreshToken: string; clientId: string; clientSecret: string } & WithFetch,
): Promise<GoogleAccessToken> {
  const res = await send(
    args.fetchImpl,
    TOKEN_URL,
    formRequest({
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    }),
  )
  if (!res.ok) throw await authError(res)
  return (await parseTokenResponse(res)).token
}

/**
 * Revoca un token en Google. Un token que ya estaba vencido o revocado
 * (400 `invalid_token`) cuenta como hecho. Otros fallos lanzan: quien
 * desconecta debe atraparlos (revocar es "lo mejor posible").
 */
export async function revokeToken(args: { token: string } & WithFetch): Promise<void> {
  const res = await send(args.fetchImpl, REVOKE_URL, formRequest({ token: args.token }))
  if (res.ok) {
    await drain(res)
    return
  }
  const code = await readErrorCode(res)
  if (res.status === 400 && code === 'invalid_token') return
  throw new GoogleApiError(res.status, code)
}

/** Correo de la cuenta de Google que conectó (o `null` si no viene). */
export async function fetchUserEmail(
  args: { accessToken: string } & WithFetch,
): Promise<string | null> {
  const res = await send(args.fetchImpl, USERINFO_URL, {
    method: 'GET',
    headers: bearer(args.accessToken),
  })
  if (!res.ok) throw await apiError(res)
  const data = await readJson(res)
  return typeof data.email === 'string' && data.email !== '' ? data.email : null
}

// ---------------------------------------------------------------------------
// Calendarios y eventos
// ---------------------------------------------------------------------------

export interface GoogleCalendarSummary {
  id: string
  name: string
  primary: boolean
}

/** Calendarios donde se puede escribir (dueño o editor). El principal va primero. */
export async function listWritableCalendars(
  args: { accessToken: string } & WithFetch,
): Promise<GoogleCalendarSummary[]> {
  const found: GoogleCalendarSummary[] = []
  let pageToken: string | undefined

  for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
    const url = new URL(`${CALENDAR_API}/users/me/calendarList`)
    url.searchParams.set('minAccessRole', 'writer')
    url.searchParams.set('maxResults', '250')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await send(args.fetchImpl, url.toString(), {
      method: 'GET',
      headers: bearer(args.accessToken),
    })
    if (!res.ok) throw await apiError(res)
    const data = await readJson(res)

    const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : []
    for (const item of items) {
      if (typeof item.id !== 'string' || item.id === '') continue
      const name =
        (typeof item.summaryOverride === 'string' && item.summaryOverride) ||
        (typeof item.summary === 'string' && item.summary) ||
        item.id
      found.push({ id: item.id, name, primary: item.primary === true })
    }

    const next = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined
    if (!next || next === pageToken) break
    pageToken = next
  }

  return [...found.filter((c) => c.primary), ...found.filter((c) => !c.primary)]
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Id del evento de Google para una cita: el uuid sin guiones y en minúsculas.
 * Es base32hex válido (0-9, a-v) y siempre da el mismo id para la misma cita,
 * así reintentar no duplica el evento. Solo acepta un uuid completo
 * (8-4-4-4-12): quitar los guiones de un texto cualquiera juntaría ids distintos
 * en un mismo evento ('ab-cde' y 'a-bcde').
 */
export function eventIdForAppointment(appointmentId: string): string {
  if (!UUID_SHAPE.test(appointmentId)) {
    throw new RangeError('The appointment id cannot be used as a Google event id')
  }
  return appointmentId.replace(/-/g, '').toLowerCase()
}

/**
 * Estados de evento que usamos. `cancelled` es lo que Google llama "borrado":
 * el evento deja de verse pero se puede restaurar con otro PUT, y el id sigue
 * siendo usable (con DELETE el id queda quemado: PUT da 404 y POST da 409).
 */
export type GoogleEventStatus = 'tentative' | 'confirmed' | 'cancelled'

export interface GoogleEventBody {
  summary: string
  description: string
  status: GoogleEventStatus
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
}

function toRfc3339(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date for the Google event')
  }
  return date.toISOString()
}

/** Cuerpo del evento. El texto (sin teléfonos ni notas) lo decide quien llama. */
export function buildEventBody(args: {
  title: string
  description: string
  startIso: string
  endIso: string
  status: GoogleEventStatus
  timeZone: string
}): GoogleEventBody {
  return {
    summary: args.title,
    description: args.description,
    status: args.status,
    start: { dateTime: toRfc3339(args.startIso), timeZone: args.timeZone },
    end: { dateTime: toRfc3339(args.endIso), timeZone: args.timeZone },
  }
}

function eventsUrl(calendarId: string): string {
  return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`
}

export interface PutEventResult {
  id: string
  /** `true` si hubo que crearlo; `false` si ya existía y se actualizó. */
  created: boolean
}

/**
 * Crea o actualiza el evento con un id fijo, sin duplicar:
 * PUT → si no existe (404) → POST con ese id → si otro proceso lo creó en
 * medio (409) → un último PUT.
 *
 * Con `createIfMissing: false` solo actualiza: un 404 del PUT lanza
 * `GoogleApiError` y no se crea nada (sirve para cancelar un evento que quizá
 * ya no existe).
 */
export async function putEvent(
  args: {
    accessToken: string
    calendarId: string
    eventId: string
    body: GoogleEventBody
    /** Por defecto `true`. */
    createIfMissing?: boolean
  } & WithFetch,
): Promise<PutEventResult> {
  const headers = { ...bearer(args.accessToken), 'Content-Type': 'application/json' }
  const update = () =>
    send(args.fetchImpl, eventUrl(args.calendarId, args.eventId), {
      method: 'PUT',
      headers,
      body: JSON.stringify(args.body),
    })

  const first = await update()
  if (first.ok) {
    await drain(first)
    return { id: args.eventId, created: false }
  }
  if (first.status !== 404 || args.createIfMissing === false) throw await apiError(first)
  await drain(first)

  const insert = await send(args.fetchImpl, eventsUrl(args.calendarId), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...args.body, id: args.eventId }),
  })
  if (insert.ok) {
    await drain(insert)
    return { id: args.eventId, created: true }
  }
  if (insert.status !== 409) throw await apiError(insert)
  await drain(insert)

  const retry = await update()
  if (retry.ok) {
    await drain(retry)
    return { id: args.eventId, created: false }
  }
  throw await apiError(retry)
}

/**
 * Borra el evento. 404 y 410 significan que ya no está: no es error.
 * Devuelve `true` si Google lo borró ahora y `false` si ya no existía.
 */
export async function deleteEvent(
  args: { accessToken: string; calendarId: string; eventId: string } & WithFetch,
): Promise<boolean> {
  const res = await send(args.fetchImpl, eventUrl(args.calendarId, args.eventId), {
    method: 'DELETE',
    headers: bearer(args.accessToken),
  })
  if (res.ok) {
    await drain(res)
    return true
  }
  if (res.status === 404 || res.status === 410) {
    await drain(res)
    return false
  }
  throw await apiError(res)
}
