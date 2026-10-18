import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/barberia/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../_lib/route-testing'

// ============================================================
// POST /api/verticals/barberia/time-off — bloqueos puntuales
// contra el fake de PostgREST.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import(
    '@/app/api/verticals/barberia/_lib/route-testing'
  )
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import(
    '@/app/api/verticals/barberia/_lib/route-testing'
  )
  return authMockModule(h.state)
})

import { POST } from './route'

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
        id: 'st-other',
        account_id: 'acc-2',
        name: 'Ajeno',
        bio: null,
        is_active: true,
        position: 0,
      },
    ],
    booking_time_off: [],
  }
}

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

beforeEach(() => {
  h.state.role = 'owner'
})

describe('POST /api/verticals/barberia/time-off', () => {
  it('crea el bloqueo para un barbero de la cuenta', async () => {
    const db = boot()

    const res = (await POST(
      jsonRequest({
        staff_id: 'st-1',
        starts_at: '2026-12-24T13:00:00.000Z',
        ends_at: '2026-12-26T22:00:00.000Z',
        reason: 'Navidad',
      }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.timeOff).toMatchObject({
      staffId: 'st-1',
      reason: 'Navidad',
    })
    expect(db._tables.booking_time_off).toHaveLength(1)
    expect(db._tables.booking_time_off[0].account_id).toBe(TEST_ACCOUNT)
  })

  it('400 con mensajes en es-CO para cada validación', async () => {
    boot()
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          starts_at: '2026-12-24T13:00:00.000Z',
          ends_at: '2026-12-26T22:00:00.000Z',
        },
        'Elige el barbero del bloqueo.',
      ],
      [
        {
          staff_id: 'st-1',
          starts_at: '2026-12-26T22:00:00.000Z',
          ends_at: '2026-12-24T13:00:00.000Z',
        },
        'La fecha final debe ser posterior a la inicial.',
      ],
      [
        { staff_id: 'st-1', starts_at: 'mañana', ends_at: 'pasado' },
        'Las fechas del bloqueo no son válidas.',
      ],
    ]
    for (const [body, message] of cases) {
      const res = (await POST(jsonRequest(body))) as unknown as TestResponse
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(message)
    }
  })

  it('404 si el barbero es de otra cuenta', async () => {
    const db = boot()

    const res = (await POST(
      jsonRequest({
        staff_id: 'st-other',
        starts_at: '2026-12-24T13:00:00.000Z',
        ends_at: '2026-12-26T22:00:00.000Z',
      }),
    )) as unknown as TestResponse

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('El barbero no existe.')
    expect(db._tables.booking_time_off).toHaveLength(0)
  })

  it('rechaza agent y viewer con 403 sin crear nada', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      const res = (await POST(
        jsonRequest({
          staff_id: 'st-1',
          starts_at: '2026-12-24T13:00:00.000Z',
          ends_at: '2026-12-26T22:00:00.000Z',
        }),
      )) as unknown as TestResponse
      expect(res.status).toBe(403)
    }
    expect(db._tables.booking_time_off).toHaveLength(0)
  })
})
