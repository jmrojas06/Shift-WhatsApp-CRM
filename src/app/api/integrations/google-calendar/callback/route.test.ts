import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

import { CALLBACK_PATH, STATE_COOKIE } from '../_lib/google-env'
import {
  TEST_ACCOUNT,
  TEST_USER,
  getRequest,
  jsonResponse,
  makeFakeGoogle,
  type FakeGoogleHandler,
  type RedirectResponse,
  type TestResponse,
} from '../_lib/route-testing'

// ============================================================
// GET /api/integrations/google-calendar/callback — Google vuelve aquí.
// Google se simula con un `fetch` falso: no se toca la red.
// ============================================================

const h = vi.hoisted(() => ({
  state: { role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer', db: null as unknown },
  admin: null as unknown,
}))

vi.mock('next/server', async () => {
  const { nextServerWithRedirectMock } = await import(
    '@/app/api/integrations/google-calendar/_lib/route-testing'
  )
  return nextServerWithRedirectMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import(
    '@/app/api/integrations/google-calendar/_lib/route-testing'
  )
  return authMockModule(h.state)
})

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.admin }))

import { GET } from './route'

const STATE = 'a'.repeat(43)
const SCOPE =
  'openid https://www.googleapis.com/auth/userinfo.email ' +
  'https://www.googleapis.com/auth/calendar.events ' +
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
const DAY = 24 * 60 * 60 * 1000

let db: FakeDb
let googleCalls: ReturnType<typeof makeFakeGoogle>['calls']

const okToken: FakeGoogleHandler = () =>
  jsonResponse(200, {
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    expires_in: 3600,
    scope: SCOPE,
  })
const okUserinfo: FakeGoogleHandler = () => jsonResponse(200, { email: 'clinica@example.com' })

function installGoogle(handlers: Parameters<typeof makeFakeGoogle>[0] = {}) {
  const fake = makeFakeGoogle({ token: okToken, userinfo: okUserinfo, ...handlers })
  googleCalls = fake.calls
  vi.stubGlobal('fetch', fake.fetchImpl)
}

function appointment(id: string, patch: Row = {}): Row {
  return {
    id,
    account_id: TEST_ACCOUNT,
    status: 'confirmed',
    starts_at: new Date(Date.now() + 2 * DAY).toISOString(),
    google_dirty: false,
    ...patch,
  }
}

function seed(extra: Record<string, Row[]> = {}) {
  db = makeFakeDb({
    agenda_calendar_connections: [],
    booking_appointments: [
      appointment('a-future'),
      appointment('a-pending', { status: 'pending' }),
      appointment('a-yesterday-ish', {
        status: 'completed',
        starts_at: new Date(Date.now() - 0.5 * DAY).toISOString(),
      }),
      appointment('a-cancelled', { status: 'cancelled' }),
      appointment('a-too-old', { starts_at: new Date(Date.now() - 3 * DAY).toISOString() }),
      appointment('a-too-far', { starts_at: new Date(Date.now() + 200 * DAY).toISOString() }),
      appointment('a-other-account', { account_id: 'acc-2' }),
    ],
    booking_staff: [
      { id: 'st-1', account_id: TEST_ACCOUNT, google_calendar_id: 'andres@group.calendar.google.com' },
      { id: 'st-2', account_id: TEST_ACCOUNT, google_calendar_id: null },
      { id: 'st-other', account_id: 'acc-2', google_calendar_id: 'otro@group.calendar.google.com' },
    ],
    ...extra,
  })
  h.admin = db
  h.state.db = db
}

function setEnv() {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id-123')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-456')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
}

beforeEach(() => {
  h.state.role = 'owner'
  setEnv()
  seed()
  installGoogle()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function callback(
  query: Record<string, string> = { code: 'auth-code-1', state: STATE },
  cookies: Record<string, string> = { [STATE_COOKIE]: STATE },
) {
  return (await GET(getRequest({ query, cookies }))) as unknown as RedirectResponse
}

const connection = () => db._tables.agenda_calendar_connections[0]
const dirtyIds = () =>
  db._tables.booking_appointments.filter((r) => r.google_dirty === true).map((r) => r.id)

function expectCookieCleared(res: RedirectResponse) {
  expect(res.cookieCalls).toContainEqual(
    expect.objectContaining({ name: STATE_COOKIE, value: '', maxAge: 0, path: CALLBACK_PATH }),
  )
}

describe('GET /callback: conexión nueva', () => {
  it('cambia el código, guarda la conexión y vuelve a la configuración con google=ok', async () => {
    const res = await callback()

    expect(res.status).toBe(307)
    expect(res.location).toBe('https://crm.example.com/agenda/configuracion?google=ok')
    expectCookieCleared(res)

    expect(db._tables.agenda_calendar_connections).toHaveLength(1)
    expect(connection()).toMatchObject({
      account_id: TEST_ACCOUNT,
      provider: 'google',
      google_email: 'clinica@example.com',
      default_calendar_id: 'primary',
      status: 'active',
      last_error: null,
      connected_by: TEST_USER,
    })
  })

  it('el permiso permanente se guarda cifrado y nunca sale en la respuesta', async () => {
    const res = await callback()

    const stored = String(connection().refresh_token_encrypted)
    expect(stored).not.toContain('refresh-secret')
    expect(decrypt(stored)).toBe('refresh-secret')
    expect(JSON.stringify(res)).not.toContain('refresh-secret')
    expect(JSON.stringify(res)).not.toContain('access-secret')
    expect(res.location).not.toContain('auth-code-1')
  })

  it('manda a Google el código y la misma URL de retorno que se registró', async () => {
    await callback()

    const token = googleCalls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))
    const body = new URLSearchParams(token?.body)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code-1')
    expect(body.get('redirect_uri')).toBe(`https://crm.example.com${CALLBACK_PATH}`)
    expect(body.get('client_id')).toBe('client-id-123')
  })

  it('marca para copiar las citas de hace 1 día a 180 días adelante, solo las de la cuenta y no canceladas', async () => {
    await callback()

    expect(dirtyIds().sort()).toEqual(['a-future', 'a-pending', 'a-yesterday-ish'].sort())
  })

  it('si Google no da el correo, conecta igual sin correo', async () => {
    installGoogle({ userinfo: () => jsonResponse(500, {}) })

    const res = await callback()

    expect(res.location).toContain('google=ok')
    expect(connection().google_email).toBeNull()
  })

  it('un admin también puede completar la conexión', async () => {
    h.state.role = 'admin'
    expect((await callback()).location).toContain('google=ok')
  })
})

describe('GET /callback: reconexión', () => {
  function seedConnection(patch: Row = {}) {
    db._tables.agenda_calendar_connections.push({
      account_id: TEST_ACCOUNT,
      provider: 'google',
      google_email: 'clinica@example.com',
      refresh_token_encrypted: encrypt('old-refresh'),
      default_calendar_id: 'sala-1@group.calendar.google.com',
      status: 'revoked',
      last_error: 'Google revocó el permiso de Shift.',
      ...patch,
    })
  }

  it('con la misma cuenta de Google deja activa la conexión y conserva los calendarios elegidos', async () => {
    seedConnection()

    const res = await callback()

    expect(res.location).toContain('google=ok')
    expect(db._tables.agenda_calendar_connections).toHaveLength(1)
    expect(connection()).toMatchObject({
      status: 'active',
      last_error: null,
      default_calendar_id: 'sala-1@group.calendar.google.com',
    })
    expect(decrypt(String(connection().refresh_token_encrypted))).toBe('refresh-secret')
    expect(db._tables.booking_staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBe(
      'andres@group.calendar.google.com',
    )
  })

  it('con otra cuenta de Google vuelve al calendario principal y suelta los calendarios de la anterior', async () => {
    seedConnection({ google_email: 'otra@example.com' })

    await callback()

    expect(connection()).toMatchObject({
      google_email: 'clinica@example.com',
      default_calendar_id: 'primary',
    })
    const staff = db._tables.booking_staff
    expect(staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBeNull()
    // Otra cuenta del CRM no se toca.
    expect(staff.find((r) => r.id === 'st-other')?.google_calendar_id).toBe(
      'otro@group.calendar.google.com',
    )
  })
})

describe('GET /callback: state inválido', () => {
  it('un state distinto al de la cookie vuelve con error y no habla con Google', async () => {
    const res = await callback({ code: 'auth-code-1', state: 'b'.repeat(43) })

    expect(res.location).toBe(
      'https://crm.example.com/agenda/configuracion?google=error&reason=state',
    )
    expectCookieCleared(res)
    expect(googleCalls).toHaveLength(0)
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
    expect(dirtyIds()).toEqual([])
  })

  it('sin cookie (venció o nunca se pidió) es el mismo error', async () => {
    const res = await callback({ code: 'auth-code-1', state: STATE }, {})
    expect(res.location).toContain('reason=state')
    expect(googleCalls).toHaveLength(0)
  })

  it('sin state en la URL es el mismo error', async () => {
    const res = await callback({ code: 'auth-code-1' })
    expect(res.location).toContain('reason=state')
    expect(googleCalls).toHaveLength(0)
  })
})

describe('GET /callback: roles', () => {
  it.each(['agent', 'viewer'] as const)('%s recibe 403 aunque el state sea válido', async (role) => {
    h.state.role = role

    const res = (await GET(
      getRequest({ query: { code: 'auth-code-1', state: STATE }, cookies: { [STATE_COOKIE]: STATE } }),
    )) as unknown as TestResponse

    expect(res.status).toBe(403)
    expect(googleCalls).toHaveLength(0)
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
  })
})

describe('GET /callback: Google no deja conectar', () => {
  it('si la persona cancela en Google, vuelve con el motivo denied', async () => {
    const res = await callback({ error: 'access_denied', state: STATE })
    expect(res.location).toContain('google=error&reason=denied')
    expectCookieCleared(res)
    expect(googleCalls).toHaveLength(0)
  })

  it('sin código vuelve con error', async () => {
    const res = await callback({ state: STATE })
    expect(res.location).toContain('reason=code')
    expect(googleCalls).toHaveLength(0)
  })

  it('si Google no entrega el permiso permanente, no guarda nada y explica el motivo', async () => {
    installGoogle({
      token: () =>
        jsonResponse(200, { access_token: 'access-secret', expires_in: 3600, scope: SCOPE }),
    })

    const res = await callback()

    expect(res.location).toContain('google=error&reason=no_refresh_token')
    expectCookieCleared(res)
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
    expect(dirtyIds()).toEqual([])
  })

  it('si falta algún permiso de calendario, no guarda nada', async () => {
    installGoogle({
      token: () =>
        jsonResponse(200, {
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3600,
          scope: 'openid email https://www.googleapis.com/auth/calendar.events',
        }),
    })

    const res = await callback()

    expect(res.location).toContain('reason=scopes')
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
  })

  it('si Google rechaza el código, vuelve con error y no deja rastro del código en los logs', async () => {
    installGoogle({ token: () => jsonResponse(400, { error: 'invalid_grant' }) })

    const res = await callback()

    expect(res.location).toContain('reason=google')
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(logged).not.toContain('auth-code-1')
    expect(logged).not.toContain('client-secret-456')
  })

  it('una reconexión fallida no daña la conexión que ya existía', async () => {
    db._tables.agenda_calendar_connections.push({
      account_id: TEST_ACCOUNT,
      status: 'active',
      refresh_token_encrypted: encrypt('old-refresh'),
    })
    installGoogle({ token: () => jsonResponse(400, { error: 'invalid_grant' }) })

    await callback()

    expect(connection().status).toBe('active')
    expect(decrypt(String(connection().refresh_token_encrypted))).toBe('old-refresh')
  })
})

describe('GET /callback: fallas del servidor', () => {
  it('sin las variables de Google vuelve con error de configuración', async () => {
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '')

    const res = await callback()

    expect(res.location).toContain('reason=config')
    expect(googleCalls).toHaveLength(0)
  })

  it('si no se puede guardar la conexión, vuelve con error y no marca citas', async () => {
    db._failNext('upsert', 'agenda_calendar_connections', { message: 'boom' })

    const res = await callback()

    expect(res.location).toContain('reason=save')
    expect(dirtyIds()).toEqual([])
    expectCookieCleared(res)
  })

  it('si no se pueden marcar las citas, la conexión queda guardada y se avisa solo en el log', async () => {
    db._failNext('update', 'booking_appointments', { message: 'boom' })

    const res = await callback()

    expect(res.location).toContain('google=ok')
    expect(db._tables.agenda_calendar_connections).toHaveLength(1)
    expect(console.error).toHaveBeenCalled()
  })
})
