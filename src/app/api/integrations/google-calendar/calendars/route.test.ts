import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt } from '@/lib/whatsapp/encryption'
import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import {
  TEST_ACCOUNT,
  jsonResponse,
  makeFakeGoogle,
  type FakeGoogleHandler,
  type TestResponse,
} from '../_lib/route-testing'

// ============================================================
// GET /api/integrations/google-calendar/calendars — calendarios
// donde se puede escribir. Google se simula con un `fetch` falso.
// ============================================================

const h = vi.hoisted(() => ({
  state: { role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer', db: null as unknown },
  admin: null as unknown,
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.admin }))

import { GET } from './route'

const REFRESH = 'refresh-secret-DO-NOT-LEAK'
const ACCESS = 'access-secret-DO-NOT-LEAK'

let db: FakeDb
let calls: ReturnType<typeof makeFakeGoogle>['calls']

const okToken: FakeGoogleHandler = () =>
  jsonResponse(200, { access_token: ACCESS, expires_in: 3600, scope: 'openid' })
const okList: FakeGoogleHandler = () =>
  jsonResponse(200, {
    items: [
      { id: 'sala-1@group.calendar.google.com', summary: 'Sala 1' },
      { id: 'clinica@example.com', summary: 'clinica@example.com', primary: true },
    ],
  })

function installGoogle(handlers: Parameters<typeof makeFakeGoogle>[0] = {}) {
  const fake = makeFakeGoogle({ token: okToken, calendarList: okList, ...handlers })
  calls = fake.calls
  vi.stubGlobal('fetch', fake.fetchImpl)
}

function seed(rows: Row[]) {
  db = makeFakeDb({ agenda_calendar_connections: rows })
  h.admin = db
  h.state.db = db
}

function connectionRow(patch: Row = {}): Row {
  return {
    account_id: TEST_ACCOUNT,
    google_email: 'clinica@example.com',
    refresh_token_encrypted: encrypt(REFRESH),
    default_calendar_id: 'primary',
    status: 'active',
    last_error: null,
    ...patch,
  }
}

beforeEach(() => {
  h.state.role = 'owner'
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id-123')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-456')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
  seed([connectionRow()])
  installGoogle()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const get = async () => (await GET()) as unknown as TestResponse

describe('GET /calendars', () => {
  it('lista los calendarios con permiso de escritura, el principal primero', async () => {
    const res = await get()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      calendars: [
        { id: 'clinica@example.com', name: 'clinica@example.com', primary: true },
        { id: 'sala-1@group.calendar.google.com', name: 'Sala 1', primary: false },
      ],
    })
  })

  it('renueva el acceso con el permiso guardado (descifrado) y pide solo calendarios editables', async () => {
    await get()

    const refresh = calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))
    const body = new URLSearchParams(refresh?.body)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe(REFRESH)
    const list = calls.find((c) => c.url.includes('/calendarList'))
    expect(new URL(list?.url ?? '').searchParams.get('minAccessRole')).toBe('writer')
  })

  it('la respuesta no trae ningún token', async () => {
    const text = JSON.stringify((await get()).body)

    expect(text).not.toContain(REFRESH)
    expect(text).not.toContain(ACCESS)
    expect(text).not.toContain('refresh_token')
  })

  it('sin conexión contesta 409 y no llama a Google', async () => {
    seed([])

    const res = await get()

    expect(res.status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('con la conexión revocada contesta 409 sin llamar a Google', async () => {
    seed([connectionRow({ status: 'revoked' })])

    const res = await get()

    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('Vuelve a conectar')
    expect(calls).toHaveLength(0)
  })

  it('sin las variables de Google contesta 503', async () => {
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '')

    const res = await get()

    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('si Google revocó el permiso (invalid_grant), marca la conexión como revocada', async () => {
    installGoogle({ token: () => jsonResponse(400, { error: 'invalid_grant' }) })

    const res = await get()

    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('Vuelve a conectar')
    expect(db._tables.agenda_calendar_connections[0]).toMatchObject({ status: 'revoked' })
    expect(String(db._tables.agenda_calendar_connections[0].last_error)).toContain('revocó')
  })

  it('si Google falla por otra razón contesta 502 sin tocar la conexión', async () => {
    installGoogle({ calendarList: () => jsonResponse(500, { error: { message: 'dato interno' } }) })

    const res = await get()

    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain('dato interno')
    expect(db._tables.agenda_calendar_connections[0].status).toBe('active')
  })

  it('si Google no responde contesta 502', async () => {
    installGoogle({
      token: () => {
        throw new TypeError('fetch failed')
      },
    })

    const res = await get()

    expect(res.status).toBe(502)
    expect(db._tables.agenda_calendar_connections[0].status).toBe('active')
  })

  it('si el permiso guardado no se puede leer pide reconectar', async () => {
    seed([connectionRow({ refresh_token_encrypted: 'no-es-un-cifrado' })])

    const res = await get()

    expect(res.status).toBe(409)
    expect(String(res.body.error)).toContain('Vuelve a conectar')
    expect(calls).toHaveLength(0)
  })

  it('solo usa la conexión de la cuenta de la sesión', async () => {
    seed([connectionRow({ account_id: 'acc-2' })])

    expect((await get()).status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it.each(['owner', 'admin'] as const)('deja pasar a %s', async (role) => {
    h.state.role = role
    expect((await get()).status).toBe(200)
  })

  it.each(['agent', 'viewer'] as const)('%s recibe 403 y no llama a Google', async (role) => {
    h.state.role = role

    expect((await get()).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
