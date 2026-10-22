import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../_lib/route-testing'

// ============================================================
// /api/verticals/agenda/staff — crear y reordenar barberos
// contra el fake de PostgREST compartido.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
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

import { POST, PUT } from './route'

function baseSeed(): Record<string, Row[]> {
  return {
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

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

const staff = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_staff.find((row) => row.id === id)

beforeEach(() => {
  h.state.role = 'owner'
})

describe('POST /api/verticals/agenda/staff', () => {
  it('crea el barbero al final del orden y con la cuenta de la sesión', async () => {
    const db = boot()

    const res = (await POST(
      jsonRequest({ name: 'Camilo', bio: 'Fades y diseño' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.staff).toMatchObject({
      name: 'Camilo',
      bio: 'Fades y diseño',
      isActive: true,
      position: 2,
    })
    expect(db._tables.booking_staff).toHaveLength(4)
    expect(db._tables.booking_staff.at(-1)?.account_id).toBe(TEST_ACCOUNT)
  })

  it('rechaza agent y viewer con 403 sin crear nada', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      const res = (await POST(
        jsonRequest({ name: 'Camilo' }),
      )) as unknown as TestResponse
      expect(res.status).toBe(403)
    }
    expect(db._tables.booking_staff).toHaveLength(3)
  })

  it('400 si el nombre está vacío', async () => {
    boot()
    const res = (await POST(
      jsonRequest({ name: '  ' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('El nombre del barbero es obligatorio.')
  })

  it('409 si el nombre ya existe en la cuenta (case-insensitive)', async () => {
    boot()

    const res = (await POST(
      jsonRequest({ name: ' andrés ' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('duplicate_name')
    expect(res.body.error).toBe('Ya existe un barbero con ese nombre.')
  })
})

describe('PUT /api/verticals/agenda/staff', () => {
  it('reordena con la permutación exacta de la cuenta', async () => {
    const db = boot()

    const res = (await PUT(
      jsonRequest({ ids: ['st-2', 'st-1'] }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(staff(db, 'st-2')?.position).toBe(0)
    expect(staff(db, 'st-1')?.position).toBe(1)
    expect(staff(db, 'st-other')?.position).toBe(0)
  })

  it('400 si la lista incluye un barbero de otra cuenta', async () => {
    const db = boot()

    const res = (await PUT(
      jsonRequest({ ids: ['st-1', 'st-other'] }),
    )) as unknown as TestResponse

    expect(res.status).toBe(400)
    expect(staff(db, 'st-1')?.position).toBe(0)
  })

  it('rechaza a un agente con 403', async () => {
    boot()
    h.state.role = 'agent'

    const res = (await PUT(
      jsonRequest({ ids: ['st-2', 'st-1'] }),
    )) as unknown as TestResponse

    expect(res.status).toBe(403)
  })
})
