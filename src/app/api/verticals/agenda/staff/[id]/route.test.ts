import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  jsonResponse,
  makeFakeGoogle,
  type FakeGoogleHandler,
} from '@/app/api/integrations/google-calendar/_lib/route-testing'
import { encrypt } from '@/lib/whatsapp/encryption'
import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// PATCH /api/verticals/agenda/staff/[id] — editar/desactivar
// barberos con aislamiento por cuenta. El calendario de Google de
// cada persona se valida contra la lista de la conexión activa
// (Google se simula con un `fetch` falso: no se toca la red).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
  admin: null as unknown,
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import(
    '@/app/api/verticals/agenda/_lib/route-testing'
  )
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import(
    '@/app/api/verticals/agenda/_lib/route-testing'
  )
  return authMockModule(h.state)
})

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.admin }))

import { PATCH } from './route'

const SALA = 'sala-1@group.calendar.google.com'

let googleCalls: ReturnType<typeof makeFakeGoogle>['calls']

const okToken: FakeGoogleHandler = () =>
  jsonResponse(200, { access_token: 'access-secret', expires_in: 3600, scope: 'openid' })
const okList: FakeGoogleHandler = () =>
  jsonResponse(200, {
    items: [
      { id: SALA, summary: 'Sala 1' },
      { id: 'clinica@example.com', summary: 'clinica@example.com', primary: true },
    ],
  })

function installGoogle(handlers: Parameters<typeof makeFakeGoogle>[0] = {}) {
  const fake = makeFakeGoogle({ token: okToken, calendarList: okList, ...handlers })
  googleCalls = fake.calls
  vi.stubGlobal('fetch', fake.fetchImpl)
}

function connectionRow(patch: Row = {}): Row {
  return {
    account_id: TEST_ACCOUNT,
    google_email: 'clinica@example.com',
    refresh_token_encrypted: encrypt('refresh-secret-DO-NOT-LEAK'),
    default_calendar_id: 'primary',
    status: 'active',
    ...patch,
  }
}

function baseSeed(): Record<string, Row[]> {
  return {
    agenda_calendar_connections: [connectionRow(), connectionRow({ account_id: 'acc-2' })],
    booking_staff: [
      {
        id: 'st-1',
        account_id: TEST_ACCOUNT,
        name: 'Andrés',
        bio: null,
        is_active: true,
        position: 0,
      },
      {
        id: 'st-2',
        account_id: TEST_ACCOUNT,
        name: 'Beto',
        bio: null,
        is_active: true,
        position: 1,
      },
      {
        id: 'st-other',
        account_id: 'acc-2',
        name: 'Ajeno',
        bio: null,
        is_active: true,
        position: 0,
      },
    ],
  }
}

function boot(seed: Record<string, Row[]> = baseSeed()) {
  const db = makeFakeDb(seed)
  h.state.db = db
  h.admin = db
  return db
}

async function patch(id: string, body: unknown) {
  return (await PATCH(jsonRequest(body), {
    params: Promise.resolve({ id }),
  })) as unknown as TestResponse
}

const staff = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_staff.find((row) => row.id === id)

beforeEach(() => {
  h.state.role = 'owner'
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id-123')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-456')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.com')
  installGoogle()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PATCH /api/verticals/agenda/staff/[id]', () => {
  it('edita nombre y bio, y desactiva sin borrar la fila', async () => {
    const db = boot()

    const res = await patch('st-1', {
      name: 'Andrés Pérez',
      bio: 'Especialista en fades',
    })
    expect(res.status).toBe(200)
    expect(res.body.staff).toMatchObject({
      name: 'Andrés Pérez',
      bio: 'Especialista en fades',
      isActive: true,
    })

    const off = await patch('st-1', { is_active: false })
    expect(off.status).toBe(200)
    expect(staff(db, 'st-1')?.is_active).toBe(false)
    expect(staff(db, 'st-1')).toBeDefined()
  })

  it('guarda y quita el calendario de Google del barbero', async () => {
    const db = boot()

    const set = await patch('st-1', { google_calendar_id: SALA })
    expect(set.status).toBe(200)
    expect(set.body.staff).toMatchObject({ googleCalendarId: SALA })
    expect(staff(db, 'st-1')?.google_calendar_id).toBe(SALA)

    const cleared = await patch('st-1', { google_calendar_id: null })
    expect(cleared.status).toBe(200)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeNull()
  })

  it('el calendario se valida con la lista de Google de la conexión de la cuenta', async () => {
    boot()

    await patch('st-1', { google_calendar_id: SALA })

    const refresh = googleCalls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'))
    expect(new URLSearchParams(refresh?.body).get('refresh_token')).toBe(
      'refresh-secret-DO-NOT-LEAK',
    )
    const list = googleCalls.find((c) => c.url.includes('/calendarList'))
    expect(new URL(list?.url ?? '').searchParams.get('minAccessRole')).toBe('writer')
  })

  it('400 si el calendario no está en la lista de Google y no cambia nada', async () => {
    const db = boot()

    const res = await patch('st-1', { google_calendar_id: 'ajeno@group.calendar.google.com' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Elige un calendario de la lista.')
    expect(staff(db, 'st-1')?.google_calendar_id).toBeUndefined()
  })

  it('acepta el alias primary de Google', async () => {
    const db = boot()

    const res = await patch('st-1', { google_calendar_id: 'primary' })

    expect(res.status).toBe(200)
    expect(staff(db, 'st-1')?.google_calendar_id).toBe('primary')
  })

  it('409 si la cuenta no tiene Google conectado, y no habla con Google', async () => {
    const db = boot({ ...baseSeed(), agenda_calendar_connections: [] })

    const res = await patch('st-1', { google_calendar_id: SALA })

    expect(res.status).toBe(409)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeUndefined()
    expect(googleCalls).toHaveLength(0)
  })

  it('409 si la conexión está revocada', async () => {
    const db = boot({
      ...baseSeed(),
      agenda_calendar_connections: [connectionRow({ status: 'revoked' })],
    })

    const res = await patch('st-1', { google_calendar_id: SALA })

    expect(res.status).toBe(409)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeUndefined()
  })

  it('502 si Google no responde, y no cambia nada', async () => {
    const db = boot()
    installGoogle({ calendarList: () => jsonResponse(500, { error: { message: 'boom' } }) })

    const res = await patch('st-1', { google_calendar_id: SALA })

    expect(res.status).toBe(502)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeUndefined()
  })

  it('quitar el calendario no necesita conexión ni habla con Google', async () => {
    const db = boot({
      ...baseSeed(),
      agenda_calendar_connections: [],
      booking_staff: [
        {
          id: 'st-1',
          account_id: TEST_ACCOUNT,
          name: 'Andrés',
          bio: null,
          is_active: true,
          position: 0,
          google_calendar_id: 'viejo@group.calendar.google.com',
        },
      ],
    })

    const res = await patch('st-1', { google_calendar_id: null })

    expect(res.status).toBe(200)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeNull()
    expect(googleCalls).toHaveLength(0)
  })

  it('editar otros datos no habla con Google', async () => {
    boot()

    await patch('st-1', { name: 'Andrés Pérez' })

    expect(googleCalls).toHaveLength(0)
  })

  it('400 si el calendario de Google no es válido y no cambia nada', async () => {
    const db = boot()

    const res = await patch('st-1', { google_calendar_id: 'x'.repeat(301) })

    expect(res.status).toBe(400)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeUndefined()
    expect(googleCalls).toHaveLength(0)
  })

  it('un agente no puede cambiar el calendario de Google', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = await patch('st-1', { google_calendar_id: 'cal-1' })

    expect(res.status).toBe(403)
    expect(staff(db, 'st-1')?.google_calendar_id).toBeUndefined()
  })

  it('404 si el barbero es de otra cuenta y no lo toca', async () => {
    const db = boot()

    const res = await patch('st-other', { is_active: false })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Esa persona del equipo no existe.')
    expect(staff(db, 'st-other')?.is_active).toBe(true)
  })

  it('400 sin cambios', async () => {
    boot()
    const res = await patch('st-1', {})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No hay cambios que guardar.')
  })

  it('409 al renombrar a un nombre ya existente', async () => {
    boot()
    const res = await patch('st-1', { name: 'beto' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('duplicate_name')
  })

  it('rechaza a un agente con 403', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = await patch('st-1', { name: 'Otro' })

    expect(res.status).toBe(403)
    expect(staff(db, 'st-1')?.name).toBe('Andrés')
  })
})
