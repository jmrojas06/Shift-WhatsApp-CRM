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
// POST /api/integrations/google-calendar/disconnect — borra la
// conexión y revoca el permiso en Google (lo mejor posible).
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

import { POST } from './route'

const REFRESH = 'refresh-secret-DO-NOT-LEAK'

let db: FakeDb
let calls: ReturnType<typeof makeFakeGoogle>['calls']

const okRevoke: FakeGoogleHandler = () => jsonResponse(200, {})

function installGoogle(handlers: Parameters<typeof makeFakeGoogle>[0] = {}) {
  const fake = makeFakeGoogle({ revoke: okRevoke, ...handlers })
  calls = fake.calls
  vi.stubGlobal('fetch', fake.fetchImpl)
}

function connectionRow(patch: Row = {}): Row {
  return {
    account_id: TEST_ACCOUNT,
    google_email: 'clinica@example.com',
    refresh_token_encrypted: encrypt(REFRESH),
    default_calendar_id: 'primary',
    status: 'active',
    ...patch,
  }
}

function seed(rows: Row[]) {
  db = makeFakeDb({
    agenda_calendar_connections: rows,
    booking_staff: [
      { id: 'st-1', account_id: TEST_ACCOUNT, google_calendar_id: 'andres@group.calendar.google.com' },
      { id: 'st-other', account_id: 'acc-2', google_calendar_id: 'otro@group.calendar.google.com' },
    ],
    booking_appointments: [
      { id: 'ap-1', account_id: TEST_ACCOUNT, google_dirty: false, google_calendar_id: 'primary' },
    ],
  })
  h.admin = db
  h.state.db = db
}

beforeEach(() => {
  h.state.role = 'owner'
  seed([connectionRow(), connectionRow({ account_id: 'acc-2' })])
  installGoogle()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const post = async () => (await POST()) as unknown as TestResponse

describe('POST /disconnect', () => {
  it('borra la conexión de la cuenta y revoca el permiso en Google', async () => {
    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(
      db._tables.agenda_calendar_connections.find((r) => r.account_id === TEST_ACCOUNT),
    ).toBeUndefined()
    const revoke = calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))
    expect(new URLSearchParams(revoke?.body).get('token')).toBe(REFRESH)
  })

  it('no toca la conexión de otra cuenta', async () => {
    await post()

    expect(db._tables.agenda_calendar_connections.map((r) => r.account_id)).toEqual(['acc-2'])
  })

  it('suelta los calendarios por profesional (eran de esa cuenta de Google), solo de esta cuenta', async () => {
    await post()

    const staff = db._tables.booking_staff
    expect(staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBeNull()
    expect(staff.find((r) => r.id === 'st-other')?.google_calendar_id).toBe(
      'otro@group.calendar.google.com',
    )
  })

  it('las citas y sus eventos ya creados se quedan como están', async () => {
    await post()

    expect(db._tables.booking_appointments[0]).toMatchObject({
      google_dirty: false,
      google_calendar_id: 'primary',
    })
    // Solo se pidió revocar el permiso: no hay llamadas al calendario.
    expect(calls.every((c) => c.url.includes('/revoke'))).toBe(true)
  })

  it('si Google no deja revocar, igual se desconecta', async () => {
    installGoogle({ revoke: () => jsonResponse(500, { error: 'server_error' }) })

    const res = await post()

    expect(res.status).toBe(200)
    expect(db._tables.agenda_calendar_connections.map((r) => r.account_id)).toEqual(['acc-2'])
  })

  it('si no hay red, igual se desconecta', async () => {
    installGoogle({
      revoke: () => {
        throw new TypeError('fetch failed')
      },
    })

    const res = await post()

    expect(res.status).toBe(200)
    expect(db._tables.agenda_calendar_connections.map((r) => r.account_id)).toEqual(['acc-2'])
  })

  it('el permiso nunca se escribe en el log', async () => {
    installGoogle({ revoke: () => jsonResponse(500, { error: 'server_error' }) })

    await post()

    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(REFRESH)
  })

  it('si el permiso guardado no se puede leer, borra la conexión sin llamar a Google', async () => {
    seed([connectionRow({ refresh_token_encrypted: 'no-es-un-cifrado' })])

    const res = await post()

    expect(res.status).toBe(200)
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('sin conexión no habla con Google y contesta ok', async () => {
    seed([])

    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(calls).toHaveLength(0)
  })

  it('sin conexión también suelta los calendarios por profesional de esta cuenta', async () => {
    seed([])

    await post()

    const staff = db._tables.booking_staff
    expect(staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBeNull()
    expect(staff.find((r) => r.id === 'st-other')?.google_calendar_id).toBe(
      'otro@group.calendar.google.com',
    )
  })

  it('una conexión ya revocada también se puede quitar', async () => {
    seed([connectionRow({ status: 'revoked' })])

    expect((await post()).status).toBe(200)
    expect(db._tables.agenda_calendar_connections).toHaveLength(0)
  })

  it('revoca el permiso antes de borrar la fila (después ya no hay de dónde leerlo)', async () => {
    let rowExistedWhenRevoking: boolean | null = null
    installGoogle({
      revoke: () => {
        rowExistedWhenRevoking = db._tables.agenda_calendar_connections.some(
          (r) => r.account_id === TEST_ACCOUNT,
        )
        return jsonResponse(200, {})
      },
    })

    await post()

    expect(rowExistedWhenRevoking).toBe(true)
  })

  it('si no se pueden soltar los calendarios del equipo, igual revoca el permiso en Google', async () => {
    db._failNext('update', 'booking_staff', { message: 'boom' })

    const res = await post()

    expect(res.status).toBe(500)
    const revoke = calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))
    expect(new URLSearchParams(revoke?.body).get('token')).toBe(REFRESH)
  })

  it('si no se pudo soltar los calendarios, volver a desconectar termina el trabajo', async () => {
    db._failNext('update', 'booking_staff', { message: 'boom' })
    await post()
    // La fila ya se borró, pero el calendario del profesional quedó.
    expect(db._tables.agenda_calendar_connections.map((r) => r.account_id)).toEqual(['acc-2'])
    expect(db._tables.booking_staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBe(
      'andres@group.calendar.google.com',
    )

    const retry = await post()

    expect(retry.status).toBe(200)
    expect(db._tables.booking_staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBeNull()
    expect(db._tables.booking_staff.find((r) => r.id === 'st-other')?.google_calendar_id).toBe(
      'otro@group.calendar.google.com',
    )
  })

  it('si no se puede borrar la fila contesta 500, la conexión sigue y se puede reintentar', async () => {
    db._failNext('delete', 'agenda_calendar_connections', { message: 'boom' })

    const res = await post()

    expect(res.status).toBe(500)
    expect(db._tables.agenda_calendar_connections).toHaveLength(2)
    // Los calendarios del equipo no se sueltan mientras la conexión siga.
    expect(db._tables.booking_staff.find((r) => r.id === 'st-1')?.google_calendar_id).toBe(
      'andres@group.calendar.google.com',
    )

    expect((await post()).status).toBe(200)
    expect(db._tables.agenda_calendar_connections.map((r) => r.account_id)).toEqual(['acc-2'])
  })

  it.each(['owner', 'admin'] as const)('deja pasar a %s', async (role) => {
    h.state.role = role
    expect((await post()).status).toBe(200)
  })

  it.each(['agent', 'viewer'] as const)('%s recibe 403 y no cambia nada', async (role) => {
    h.state.role = role

    const res = await post()

    expect(res.status).toBe(403)
    expect(db._tables.agenda_calendar_connections).toHaveLength(2)
    expect(calls).toHaveLength(0)
  })
})
