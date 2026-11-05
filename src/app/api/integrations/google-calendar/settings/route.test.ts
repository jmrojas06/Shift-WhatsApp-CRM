import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt } from '@/lib/whatsapp/encryption'
import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'
import { brokenJsonRequest, jsonRequest } from '@/app/api/verticals/agenda/_lib/route-testing'

import { TEST_ACCOUNT, type TestResponse } from '../_lib/route-testing'

// ============================================================
// GET/PATCH /api/integrations/google-calendar/settings — estado de
// la conexión (nunca con el token) y calendario general.
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

import { GET, PATCH } from './route'

const SECRET = 'refresh-secret-DO-NOT-LEAK'

let db: FakeDb

function connectionRow(patch: Row = {}): Row {
  return {
    account_id: TEST_ACCOUNT,
    provider: 'google',
    google_email: 'clinica@example.com',
    refresh_token_encrypted: encrypt(SECRET),
    default_calendar_id: 'primary',
    status: 'active',
    last_error: null,
    last_sync_at: '2026-11-05T15:00:00.000Z',
    connected_by: 'user-1',
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-05T15:00:00.000Z',
    ...patch,
  }
}

function seed(rows: Row[]) {
  db = makeFakeDb({ agenda_calendar_connections: rows })
  h.admin = db
  h.state.db = db
}

const get = async () => (await GET()) as unknown as TestResponse
const patch = async (body: unknown) =>
  (await PATCH(jsonRequest(body))) as unknown as TestResponse

beforeEach(() => {
  h.state.role = 'owner'
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id-123')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-456')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
  seed([connectionRow()])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /settings', () => {
  it('devuelve el estado de la conexión', async () => {
    const res = await get()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      configured: true,
      connected: true,
      google_email: 'clinica@example.com',
      status: 'active',
      last_error: null,
      last_sync_at: '2026-11-05T15:00:00.000Z',
      default_calendar_id: 'primary',
    })
  })

  it('la respuesta nunca trae el token ni otros datos internos', async () => {
    const text = JSON.stringify((await get()).body)

    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('refresh_token')
    expect(text).not.toContain('connected_by')
    expect(text).not.toContain('account_id')
    expect(Object.keys((await get()).body).sort()).toEqual([
      'configured',
      'connected',
      'default_calendar_id',
      'google_email',
      'last_error',
      'last_sync_at',
      'status',
    ])
  })

  it('sin conexión dice que no está conectado', async () => {
    seed([])

    expect((await get()).body).toEqual({
      configured: true,
      connected: false,
      google_email: null,
      status: null,
      last_error: null,
      last_sync_at: null,
      default_calendar_id: null,
    })
  })

  it('una conexión revocada ya no cuenta como conectada y trae su motivo', async () => {
    seed([connectionRow({ status: 'revoked', last_error: 'Google revocó el permiso.' })])

    const res = await get()

    expect(res.body).toMatchObject({
      connected: false,
      status: 'revoked',
      last_error: 'Google revocó el permiso.',
    })
  })

  it('avisa si el servidor no tiene las variables de Google', async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '')

    expect((await get()).body.configured).toBe(false)
  })

  it('solo mira la conexión de la cuenta de la sesión', async () => {
    seed([connectionRow({ account_id: 'acc-2', google_email: 'ajena@example.com' })])

    const res = await get()

    expect(res.body.connected).toBe(false)
    expect(JSON.stringify(res.body)).not.toContain('ajena@example.com')
  })

  it.each(['owner', 'admin'] as const)('deja pasar a %s', async (role) => {
    h.state.role = role
    expect((await get()).status).toBe(200)
  })

  it.each(['agent', 'viewer'] as const)('%s recibe 403', async (role) => {
    h.state.role = role
    const res = await get()
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })

  it('si falla la base contesta 500 genérico, sin detalles', async () => {
    db._failNext('select', 'agenda_calendar_connections', { message: 'secreto interno' })

    const res = await get()

    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('secreto interno')
  })
})

describe('PATCH /settings', () => {
  it('guarda el calendario general y devuelve el estado sin el token', async () => {
    const res = await patch({ default_calendar_id: '  sala-1@group.calendar.google.com ' })

    expect(res.status).toBe(200)
    expect(res.body.default_calendar_id).toBe('sala-1@group.calendar.google.com')
    expect(db._tables.agenda_calendar_connections[0].default_calendar_id).toBe(
      'sala-1@group.calendar.google.com',
    )
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    expect(JSON.stringify(res.body)).not.toContain('refresh_token')
  })

  it('no toca el permiso guardado ni el estado', async () => {
    const before = db._tables.agenda_calendar_connections[0].refresh_token_encrypted

    await patch({ default_calendar_id: 'otro' })

    const row = db._tables.agenda_calendar_connections[0]
    expect(row.refresh_token_encrypted).toBe(before)
    expect(row.status).toBe('active')
  })

  it('solo cambia la conexión de la cuenta de la sesión', async () => {
    seed([connectionRow(), connectionRow({ account_id: 'acc-2', default_calendar_id: 'ajeno' })])

    await patch({ default_calendar_id: 'otro' })

    const other = db._tables.agenda_calendar_connections.find((r) => r.account_id === 'acc-2')
    expect(other?.default_calendar_id).toBe('ajeno')
  })

  it.each([
    ['sin el campo', {}],
    ['vacío', { default_calendar_id: '   ' }],
    ['que no es texto', { default_calendar_id: 42 }],
    ['nulo', { default_calendar_id: null }],
    ['demasiado largo', { default_calendar_id: 'x'.repeat(301) }],
    ['con saltos de línea', { default_calendar_id: 'a\nb' }],
  ])('rechaza un calendario %s con 400', async (_name, body) => {
    const res = await patch(body)

    expect(res.status).toBe(400)
    expect(db._tables.agenda_calendar_connections[0].default_calendar_id).toBe('primary')
  })

  it('rechaza un cuerpo que no es JSON con 400', async () => {
    const res = (await PATCH(brokenJsonRequest())) as unknown as TestResponse
    expect(res.status).toBe(400)
  })

  it('sin conexión contesta 409 y no crea nada', async () => {
    seed([])

    const res = await patch({ default_calendar_id: 'primary' })

    expect(res.status).toBe(409)
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
  })

  it.each(['agent', 'viewer'] as const)('%s recibe 403 y no cambia nada', async (role) => {
    h.state.role = role

    const res = await patch({ default_calendar_id: 'otro' })

    expect(res.status).toBe(403)
    expect(db._tables.agenda_calendar_connections[0].default_calendar_id).toBe('primary')
  })

  it('si falla el guardado contesta 500 y no dice que se guardó', async () => {
    db._failNext('update', 'agenda_calendar_connections', { message: 'boom' })

    const res = await patch({ default_calendar_id: 'otro' })

    expect(res.status).toBe(500)
    expect(db._tables.agenda_calendar_connections[0].default_calendar_id).toBe('primary')
  })
})
