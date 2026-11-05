import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  GOOGLE_OAUTH_SCOPES,
  GoogleApiError,
  GoogleAuthError,
  GoogleNetworkError,
  buildAuthUrl,
  buildEventBody,
  deleteEvent,
  eventIdForAppointment,
  exchangeCode,
  fetchUserEmail,
  hasCalendarScopes,
  listWritableCalendars,
  putEvent,
  refreshAccessToken,
  revokeToken,
} from './calendar-api'

// Todas las pruebas usan un `fetch` falso: jamás se toca la red de Google.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const empty = (status: number) => new Response(null, { status })

function fakeFetch() {
  return vi.fn<typeof fetch>()
}

/** URL, método, cabeceras y cuerpo de la llamada n-ésima. */
function callAt(fetchImpl: ReturnType<typeof fakeFetch>, n: number) {
  const [input, init] = fetchImpl.mock.calls[n]
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body as string | undefined,
    signal: init?.signal,
  }
}

const CAL = 'clinica@group.calendar.google.com'
const EVENT_ID = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'

describe('buildAuthUrl', () => {
  it('arma la URL de consentimiento con acceso sin conexión y los permisos justos', () => {
    const url = new URL(
      buildAuthUrl({
        clientId: 'client-1',
        redirectUri: 'https://app.test/api/integrations/google-calendar/callback',
        state: 'state-abc',
      }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    const p = url.searchParams
    expect(p.get('client_id')).toBe('client-1')
    expect(p.get('redirect_uri')).toBe(
      'https://app.test/api/integrations/google-calendar/callback',
    )
    expect(p.get('response_type')).toBe('code')
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
    expect(p.get('include_granted_scopes')).toBe('true')
    expect(p.get('state')).toBe('state-abc')
    expect(p.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    )
    expect(GOOGLE_OAUTH_SCOPES).toHaveLength(4)
  })
})

describe('hasCalendarScopes', () => {
  it('exige los dos permisos de calendario (el usuario puede desmarcarlos)', () => {
    const both =
      'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly'
    expect(hasCalendarScopes(both)).toBe(true)
    expect(
      hasCalendarScopes('openid https://www.googleapis.com/auth/calendar.events'),
    ).toBe(false)
    expect(hasCalendarScopes('')).toBe(false)
  })
})

describe('exchangeCode', () => {
  const args = {
    code: 'auth-code-xyz',
    clientId: 'client-1',
    clientSecret: 'client-secret-1',
    redirectUri: 'https://app.test/callback',
  }

  it('cambia el código por tokens con un POST de formulario', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3599,
        scope: 'openid https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
      }),
    )
    const out = await exchangeCode({ ...args, fetchImpl })
    expect(out).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresInSec: 3599,
      scope: 'openid https://www.googleapis.com/auth/calendar.events',
    })
    const call = callAt(fetchImpl, 0)
    expect(call.url).toBe('https://oauth2.googleapis.com/token')
    expect(call.method).toBe('POST')
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(call.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('auth-code-xyz')
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('client_secret')).toBe('client-secret-1')
    expect(form.get('redirect_uri')).toBe('https://app.test/callback')
    expect(call.signal).toBeInstanceOf(AbortSignal)
  })

  it('devuelve refreshToken null cuando Google no lo entrega', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ access_token: 'access-1', expires_in: 3600 }),
    )
    const out = await exchangeCode({ ...args, fetchImpl })
    expect(out.refreshToken).toBeNull()
    expect(out.scope).toBe('')
  })

  it('lanza GoogleAuthError tipado y sin secretos en el mensaje', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json(
        {
          error: 'invalid_grant',
          error_description: 'Bad code auth-code-xyz for client-secret-1',
        },
        400,
      ),
    )
    const err = await exchangeCode({ ...args, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.code).toBe('invalid_grant')
    expect(err.httpStatus).toBe(400)
    expect(err.message).not.toContain('auth-code-xyz')
    expect(err.message).not.toContain('client-secret-1')
  })

  it('lanza GoogleApiError si la respuesta exitosa no trae access_token', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({ hola: 'mundo' }))
    const err = await exchangeCode({ ...args, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.reason).toBe('bad_response')
  })
})

describe('refreshAccessToken', () => {
  const args = {
    refreshToken: 'refresh-secret-1',
    clientId: 'client-1',
    clientSecret: 'client-secret-1',
  }

  it('pide un access token nuevo con el refresh token', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ access_token: 'access-2', expires_in: 3599, scope: 'a b' }),
    )
    const out = await refreshAccessToken({ ...args, fetchImpl })
    expect(out).toEqual({ accessToken: 'access-2', expiresInSec: 3599, scope: 'a b' })
    const call = callAt(fetchImpl, 0)
    expect(call.url).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(call.body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('refresh-secret-1')
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('client_secret')).toBe('client-secret-1')
  })

  it('invalid_grant llega como GoogleAuthError con code === "invalid_grant"', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json(
        {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        },
        400,
      ),
    )
    const err = await refreshAccessToken({ ...args, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.code).toBe('invalid_grant')
    expect(err.message).not.toContain('refresh-secret-1')
    expect(err.message).not.toContain('client-secret-1')
  })

  it('un 503 con cuerpo que no es JSON no es invalid_grant', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      new Response('<html>Service Unavailable</html>', { status: 503 }),
    )
    const err = await refreshAccessToken({ ...args, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.code).toBe('http_503')
    expect(err.code).not.toBe('invalid_grant')
  })

  it('descarta códigos de error con formato raro (no se cuela texto libre)', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ error: 'token refresh-secret-1 mal' }, 400),
    )
    const err = await refreshAccessToken({ ...args, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.code).toBe('http_400')
    expect(err.message).not.toContain('refresh-secret-1')
  })
})

describe('revokeToken', () => {
  it('manda el token a /revoke', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({}))
    await revokeToken({ token: 'refresh-1', fetchImpl })
    const call = callAt(fetchImpl, 0)
    expect(call.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(call.method).toBe('POST')
    expect(new URLSearchParams(call.body).get('token')).toBe('refresh-1')
  })

  it('un token que ya estaba vencido o revocado (400 invalid_token) no es error', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ error: 'invalid_token', error_description: 'Token expired or revoked' }, 400),
    )
    await expect(revokeToken({ token: 'refresh-1', fetchImpl })).resolves.toBeUndefined()
  })

  it('otros fallos lanzan GoogleApiError sin el token', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({}, 500))
    const err = await revokeToken({ token: 'refresh-secret-2', fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(500)
    expect(err.message).not.toContain('refresh-secret-2')
  })
})

describe('fetchUserEmail', () => {
  it('lee el correo de userinfo con el access token', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ sub: '123', email: 'dueno@clinica.test', email_verified: true }),
    )
    const email = await fetchUserEmail({ accessToken: 'access-1', fetchImpl })
    expect(email).toBe('dueno@clinica.test')
    const call = callAt(fetchImpl, 0)
    expect(call.url).toBe('https://openidconnect.googleapis.com/v1/userinfo')
    expect(call.method).toBe('GET')
    expect(call.headers.Authorization).toBe('Bearer access-1')
  })

  it('devuelve null si no hay correo', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({ sub: '123' }))
    expect(await fetchUserEmail({ accessToken: 'access-1', fetchImpl })).toBeNull()
  })

  it('lanza GoogleApiError con 401', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ error: { code: 401, message: 'Invalid Credentials access-1', status: 'UNAUTHENTICATED' } }, 401),
    )
    const err = await fetchUserEmail({ accessToken: 'access-1', fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(401)
    expect(err.message).not.toContain('access-1')
  })
})

describe('listWritableCalendars', () => {
  it('pide solo calendarios con permiso de escritura y pone el principal primero', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({
        items: [
          { id: 'otro@group.calendar.google.com', summary: 'Sede norte', accessRole: 'writer' },
          {
            id: 'dueno@clinica.test',
            summary: 'dueno@clinica.test',
            summaryOverride: 'Mi agenda',
            primary: true,
            accessRole: 'owner',
          },
        ],
      }),
    )
    const out = await listWritableCalendars({ accessToken: 'access-1', fetchImpl })
    expect(out).toEqual([
      { id: 'dueno@clinica.test', name: 'Mi agenda', primary: true },
      { id: 'otro@group.calendar.google.com', name: 'Sede norte', primary: false },
    ])
    const call = callAt(fetchImpl, 0)
    const url = new URL(call.url)
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    )
    expect(url.searchParams.get('minAccessRole')).toBe('writer')
    expect(call.headers.Authorization).toBe('Bearer access-1')
  })

  it('sigue las páginas hasta que no hay nextPageToken', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(
        json({ items: [{ id: 'a', summary: 'A' }], nextPageToken: 'page-2' }),
      )
      .mockResolvedValueOnce(json({ items: [{ id: 'b', summary: 'B' }] }))
    const out = await listWritableCalendars({ accessToken: 'access-1', fetchImpl })
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(new URL(callAt(fetchImpl, 1).url).searchParams.get('pageToken')).toBe('page-2')
  })

  it('sin items devuelve lista vacía', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({}))
    expect(await listWritableCalendars({ accessToken: 'access-1', fetchImpl })).toEqual([])
  })

  it('no se queda en bucle si Google repite el nextPageToken', async () => {
    const fetchImpl = fakeFetch().mockImplementation(async () =>
      json({ items: [{ id: 'a', summary: 'A' }], nextPageToken: 'siempre' }),
    )
    const out = await listWritableCalendars({ accessToken: 'access-1', fetchImpl })
    expect(out.length).toBeGreaterThan(0)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(10)
  })
})

describe('eventIdForAppointment', () => {
  it('quita los guiones y pasa a minúsculas', () => {
    expect(eventIdForAppointment('0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9')).toBe(EVENT_ID)
  })

  it('rechaza ids que Google no aceptaría (base32hex: 0-9 a-v)', () => {
    expect(() => eventIdForAppointment('')).toThrow()
    expect(() => eventIdForAppointment('zzzzzzzz')).toThrow()
    expect(() => eventIdForAppointment('abc')).toThrow() // menos de 5 caracteres
  })
})

describe('buildEventBody', () => {
  it('arma el cuerpo con zona horaria y estado', () => {
    const body = buildEventBody({
      title: 'Limpieza · Ana Pérez',
      description: 'Profesional: Dr. Gómez\nCreada desde Shift',
      startIso: '2026-11-10T15:00:00+00:00',
      endIso: '2026-11-10T15:45:00Z',
      status: 'tentative',
      timeZone: 'America/Bogota',
    })
    expect(body).toEqual({
      summary: 'Limpieza · Ana Pérez',
      description: 'Profesional: Dr. Gómez\nCreada desde Shift',
      status: 'tentative',
      start: { dateTime: '2026-11-10T15:00:00.000Z', timeZone: 'America/Bogota' },
      end: { dateTime: '2026-11-10T15:45:00.000Z', timeZone: 'America/Bogota' },
    })
  })

  it('acepta el formato de Postgres con espacio y lo normaliza', () => {
    const body = buildEventBody({
      title: 't',
      description: 'd',
      startIso: '2026-11-10 15:00:00+00',
      endIso: '2026-11-10 16:00:00+00',
      status: 'confirmed',
      timeZone: 'America/Bogota',
    })
    expect(body.start.dateTime).toBe('2026-11-10T15:00:00.000Z')
    expect(body.status).toBe('confirmed')
  })

  it('lanza si una fecha es inválida', () => {
    expect(() =>
      buildEventBody({
        title: 't',
        description: 'd',
        startIso: 'no-es-fecha',
        endIso: '2026-11-10T16:00:00Z',
        status: 'confirmed',
        timeZone: 'America/Bogota',
      }),
    ).toThrow(RangeError)
  })
})

describe('putEvent', () => {
  const body = buildEventBody({
    title: 'Limpieza · Ana',
    description: 'Creada desde Shift',
    startIso: '2026-11-10T15:00:00Z',
    endIso: '2026-11-10T15:45:00Z',
    status: 'confirmed',
    timeZone: 'America/Bogota',
  })

  it('actualiza con PUT cuando el evento ya existe (una sola llamada)', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({ id: EVENT_ID }))
    const out = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      fetchImpl,
    })
    expect(out).toEqual({ id: EVENT_ID, created: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const call = callAt(fetchImpl, 0)
    expect(call.method).toBe('PUT')
    expect(call.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${EVENT_ID}`,
    )
    expect(call.url).toContain('clinica%40group.calendar.google.com')
    expect(call.headers.Authorization).toBe('Bearer access-1')
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(call.body as string)).toEqual(body)
  })

  it('PUT 404 → POST a /events con el id del evento', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404))
      .mockResolvedValueOnce(json({ id: EVENT_ID }))
    const out = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      fetchImpl,
    })
    expect(out).toEqual({ id: EVENT_ID, created: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(callAt(fetchImpl, 0).method).toBe('PUT')
    const post = callAt(fetchImpl, 1)
    expect(post.method).toBe('POST')
    expect(post.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`,
    )
    expect(JSON.parse(post.body as string)).toEqual({ ...body, id: EVENT_ID })
  })

  it('si el POST choca (409, otro proceso lo creó), vuelve a hacer PUT una vez', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ error: { errors: [{ reason: 'duplicate' }] } }, 409))
      .mockResolvedValueOnce(json({ id: EVENT_ID }))
    const out = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      fetchImpl,
    })
    expect(out).toEqual({ id: EVENT_ID, created: false })
    expect(fetchImpl.mock.calls.map((_, i) => callAt(fetchImpl, i).method)).toEqual([
      'PUT',
      'POST',
      'PUT',
    ])
  })

  it('no entra en bucle: PUT→404, POST→409, PUT→404 lanza error', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({}, 404))
    const err = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(404)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('un error distinto de 404 en el PUT lanza GoogleApiError y no intenta POST', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json(
        {
          error: {
            code: 403,
            message: 'Rate Limit Exceeded for access-1',
            errors: [{ reason: 'rateLimitExceeded' }],
          },
        },
        403,
      ),
    )
    const err = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(403)
    expect(err.reason).toBe('rateLimitExceeded')
    expect(err.message).not.toContain('access-1')
    expect(err.message).not.toContain(CAL)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('con createIfMissing: false, un 404 del PUT lanza y no crea nada (sin POST)', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ error: { errors: [{ reason: 'notFound' }] } }, 404),
    )
    const err = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      createIfMissing: false,
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(404)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(callAt(fetchImpl, 0).method).toBe('PUT')
  })

  it('con createIfMissing: false, si el evento existe lo actualiza igual', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({ id: EVENT_ID }))
    const out = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      createIfMissing: false,
      fetchImpl,
    })
    expect(out).toEqual({ id: EVENT_ID, created: false })
  })

  it('acepta el estado cancelled (Google lo trata como borrado pero se puede restaurar)', async () => {
    const cancelled = buildEventBody({
      title: 'Limpieza · Ana',
      description: 'Creada desde Shift',
      startIso: '2026-11-10T15:00:00Z',
      endIso: '2026-11-10T15:45:00Z',
      status: 'cancelled',
      timeZone: 'America/Bogota',
    })
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({ id: EVENT_ID }))
    await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body: cancelled,
      fetchImpl,
    })
    expect(JSON.parse(callAt(fetchImpl, 0).body as string).status).toBe('cancelled')
  })

  it('un error del POST (por ejemplo 400) también es GoogleApiError', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ error: { errors: [{ reason: 'invalid' }] } }, 400))
    const err = await putEvent({
      accessToken: 'access-1',
      calendarId: CAL,
      eventId: EVENT_ID,
      body,
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(400)
    expect(err.reason).toBe('invalid')
  })
})

describe('deleteEvent', () => {
  const args = { accessToken: 'access-1', calendarId: CAL, eventId: EVENT_ID }

  it('borra con DELETE y devuelve true', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(empty(204))
    expect(await deleteEvent({ ...args, fetchImpl })).toBe(true)
    const call = callAt(fetchImpl, 0)
    expect(call.method).toBe('DELETE')
    expect(call.url).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events/${EVENT_ID}`,
    )
    expect(call.headers.Authorization).toBe('Bearer access-1')
  })

  it.each([404, 410])('%i significa que ya no está: no es error y devuelve false', async (status) => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(json({ error: { code: status } }, status))
    expect(await deleteEvent({ ...args, fetchImpl })).toBe(false)
  })

  it('otros errores (403) lanzan GoogleApiError', async () => {
    const fetchImpl = fakeFetch().mockResolvedValueOnce(
      json({ error: { errors: [{ reason: 'forbidden' }] } }, 403),
    )
    const err = await deleteEvent({ ...args, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect(err.httpStatus).toBe(403)
    expect(err.reason).toBe('forbidden')
  })
})

describe('red y seguridad', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('un timeout se convierte en GoogleNetworkError("timeout")', async () => {
    const fetchImpl = fakeFetch().mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )
    const err = await fetchUserEmail({ accessToken: 'access-1', fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleNetworkError)
    expect(err.kind).toBe('timeout')
  })

  it('un fallo de red no filtra el texto original (puede traer cabeceras)', async () => {
    const fetchImpl = fakeFetch().mockRejectedValueOnce(
      new TypeError('fetch failed: Bearer access-secret-9'),
    )
    const err = await deleteEvent({
      accessToken: 'access-secret-9',
      calendarId: CAL,
      eventId: EVENT_ID,
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleNetworkError)
    expect(err.kind).toBe('network')
    expect(err.message).not.toContain('access-secret-9')
  })

  it('todas las llamadas llevan un timeout de 10 s (AbortSignal)', async () => {
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(json({ email: 'a@b.test' }))
      .mockResolvedValueOnce(empty(204))
    await fetchUserEmail({ accessToken: 'access-1', fetchImpl })
    await deleteEvent({ accessToken: 'access-1', calendarId: CAL, eventId: EVENT_ID, fetchImpl })
    expect(callAt(fetchImpl, 0).signal).toBeInstanceOf(AbortSignal)
    expect(callAt(fetchImpl, 1).signal).toBeInstanceOf(AbortSignal)
  })

  it('sin fetchImpl usa el fetch global', async () => {
    const globalFetch = fakeFetch().mockResolvedValueOnce(json({ email: 'a@b.test' }))
    vi.stubGlobal('fetch', globalFetch)
    expect(await fetchUserEmail({ accessToken: 'access-1' })).toBe('a@b.test')
    expect(globalFetch).toHaveBeenCalledTimes(1)
  })

  it('nunca escribe en la consola (ni siquiera cuando falla)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    const fetchImpl = fakeFetch()
      .mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
      .mockRejectedValueOnce(new TypeError('boom'))
    await refreshAccessToken({
      refreshToken: 'r',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    }).catch(() => {})
    await fetchUserEmail({ accessToken: 'a', fetchImpl }).catch(() => {})
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})
