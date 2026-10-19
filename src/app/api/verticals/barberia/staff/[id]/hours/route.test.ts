import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/barberia/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../../_lib/route-testing'

// ============================================================
// PUT /api/verticals/barberia/staff/[id]/hours — horario semanal
// por DIFF contra el fake de PostgREST: los bloques idénticos se
// conservan, los nuevos entran y los que salieron se borran.
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

import { PUT } from './route'

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
    booking_working_hours: [
      {
        id: 'wh-1',
        account_id: TEST_ACCOUNT,
        staff_id: 'st-1',
        weekday: 1,
        start_time: '09:00:00',
        end_time: '12:00:00',
      },
    ],
  }
}

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

async function put(id: string, body: unknown) {
  return (await PUT(jsonRequest(body), {
    params: Promise.resolve({ id }),
  })) as unknown as TestResponse
}

const hours = (db: { _tables: Record<string, Row[]> }) =>
  db._tables.booking_working_hours

beforeEach(() => {
  h.state.role = 'owner'
})

describe('PUT /api/verticals/barberia/staff/[id]/hours', () => {
  it('conserva el bloque idéntico (HH:MM vs HH:MM:SS) y agrega los nuevos', async () => {
    const db = boot()

    const res = await put('st-1', {
      hours: [
        { weekday: 1, start_time: '09:00', end_time: '12:00' },
        { weekday: 2, start_time: '10:00', end_time: '14:00' },
      ],
    })

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(hours(db)).toHaveLength(2)
    // El bloque que ya estaba no se reescribió: conserva su id.
    expect(
      hours(db).find((row) => row.weekday === 1)?.id,
    ).toBe('wh-1')
  })

  it('borra los bloques que ya no están y permite vaciar el horario', async () => {
    const db = boot()

    const res = await put('st-1', {
      hours: [{ weekday: 3, start_time: '08:00', end_time: '16:00' }],
    })
    expect(res.status).toBe(200)
    expect(hours(db).find((row) => row.id === 'wh-1')).toBeUndefined()

    const cleared = await put('st-1', { hours: [] })
    expect(cleared.status).toBe(200)
    expect(hours(db)).toHaveLength(0)
  })

  it('400 si hay traslapes o el fin no es mayor que el inicio', async () => {
    boot()

    const overlap = await put('st-1', {
      hours: [
        { weekday: 1, start_time: '09:00', end_time: '12:00' },
        { weekday: 1, start_time: '11:00', end_time: '13:00' },
      ],
    })
    expect(overlap.status).toBe(400)
    expect(overlap.body.error).toContain('se traslapan')
    expect(overlap.body.error).toContain('lunes')

    const backwards = await put('st-1', {
      hours: [{ weekday: 3, start_time: '10:00', end_time: '09:00' }],
    })
    expect(backwards.status).toBe(400)
    expect(backwards.body.error).toContain(
      'La hora final debe ser mayor que la inicial',
    )
  })

  it('400 si el horario no es una lista', async () => {
    boot()
    const res = await put('st-1', { hours: 'de 9 a 6' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('El horario no es válido.')
  })

  it('404 si el barbero es de otra cuenta sin tocar su horario', async () => {
    boot()

    const res = await put('st-other', { hours: [] })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('El barbero no existe.')
  })

  it('si insertar los bloques nuevos falla: 500 y el horario anterior intacto', async () => {
    const db = boot()
    db._failNext('insert', 'booking_working_hours', { message: 'insert failed' })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await put('st-1', {
      hours: [{ weekday: 3, start_time: '08:00', end_time: '16:00' }],
    })

    expect(res.status).toBe(500)
    expect(res.body.count).toBeUndefined()
    // No se borró el bloque viejo: el barbero no queda sin horario.
    expect(hours(db).map((row) => row.id)).toEqual(['wh-1'])
  })

  it('si borrar los bloques viejos falla: 500, nunca "Guardado"', async () => {
    const db = boot()
    db._failNext('delete', 'booking_working_hours', { message: 'delete failed' })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await put('st-1', {
      hours: [{ weekday: 3, start_time: '08:00', end_time: '16:00' }],
    })

    expect(res.status).toBe(500)
    expect(res.body.ok).toBeUndefined()
  })

  it('rechaza a un agente con 403', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = await put('st-1', { hours: [] })

    expect(res.status).toBe(403)
    expect(hours(db)).toHaveLength(1)
  })
})
