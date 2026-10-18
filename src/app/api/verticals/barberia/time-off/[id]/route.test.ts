import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/barberia/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// DELETE /api/verticals/barberia/time-off/[id] — los bloqueos SÍ
// se borran; un id de otra cuenta es 404 y la fila no se toca.
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

import { DELETE } from './route'

function baseSeed(): Record<string, Row[]> {
  return {
    booking_time_off: [
      {
        id: 'to-1',
        account_id: TEST_ACCOUNT,
        staff_id: 'st-1',
        starts_at: '2026-11-02T13:00:00.000Z',
        ends_at: '2026-11-03T22:00:00.000Z',
        reason: 'Vacaciones',
      },
      {
        id: 'to-other',
        account_id: 'acc-2',
        staff_id: 'st-other',
        starts_at: '2026-11-02T13:00:00.000Z',
        ends_at: '2026-11-03T22:00:00.000Z',
        reason: null,
      },
    ],
  }
}

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

async function del(id: string) {
  return (await DELETE(jsonRequest(null), {
    params: Promise.resolve({ id }),
  })) as unknown as TestResponse
}

const timeOff = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_time_off.find((row) => row.id === id)

beforeEach(() => {
  h.state.role = 'owner'
})

describe('DELETE /api/verticals/barberia/time-off/[id]', () => {
  it('borra el bloqueo propio; repetir da 404', async () => {
    const db = boot()

    const res = await del('to-1')
    expect(res.status).toBe(200)
    expect(timeOff(db, 'to-1')).toBeUndefined()

    const again = await del('to-1')
    expect(again.status).toBe(404)
    expect(again.body.error).toBe('El bloqueo no existe.')
  })

  it('404 si el bloqueo es de otra cuenta y no lo toca', async () => {
    const db = boot()

    const res = await del('to-other')

    expect(res.status).toBe(404)
    expect(timeOff(db, 'to-other')).toBeDefined()
  })

  it('rechaza a un agente con 403 sin borrar nada', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = await del('to-1')

    expect(res.status).toBe(403)
    expect(timeOff(db, 'to-1')).toBeDefined()
  })
})
