import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../../_lib/route-testing'

// ============================================================
// PUT /api/verticals/agenda/staff/[id]/services — relación
// barbero ↔ servicios por DIFF contra el fake de PostgREST.
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

import { PUT } from './route'

function baseSeed(): Record<string, Row[]> {
  return {
    booking_services: [
      {
        id: 'svc-1',
        account_id: TEST_ACCOUNT,
        name: 'Corte',
        description: null,
        duration_minutes: 30,
        price: 25000,
        is_active: true,
        position: 0,
      },
      {
        id: 'svc-2',
        account_id: TEST_ACCOUNT,
        name: 'Barba',
        description: null,
        duration_minutes: 20,
        price: 12000,
        is_active: true,
        position: 1,
      },
      {
        id: 'svc-other',
        account_id: 'acc-2',
        name: 'Ajeno',
        description: null,
        duration_minutes: 30,
        price: 100,
        is_active: true,
        position: 0,
      },
    ],
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
    booking_staff_services: [
      { account_id: TEST_ACCOUNT, staff_id: 'st-1', service_id: 'svc-1' },
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

const links = (db: { _tables: Record<string, Row[]> }, staffId: string) =>
  db._tables.booking_staff_services.filter((row) => row.staff_id === staffId)

beforeEach(() => {
  h.state.role = 'owner'
})

describe('PUT /api/verticals/agenda/staff/[id]/services', () => {
  it('deja el set exacto de servicios y repetir la llamada no duplica', async () => {
    const db = boot()

    const res = await put('st-1', { service_ids: ['svc-1', 'svc-2'] })
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(links(db, 'st-1')).toHaveLength(2)

    // Idempotente: mismo set otra vez, mismas filas.
    await put('st-1', { service_ids: ['svc-1', 'svc-2'] })
    expect(links(db, 'st-1')).toHaveLength(2)
  })

  it('quita la relación de los servicios que salieron', async () => {
    const db = boot()

    const res = await put('st-1', { service_ids: ['svc-2'] })

    expect(res.status).toBe(200)
    expect(links(db, 'st-1').map((row) => row.service_id)).toEqual(['svc-2'])
  })

  it('400 si la lista no es válida o tiene repetidos', async () => {
    const db = boot()

    const notList = await put('st-1', { service_ids: 'svc-1' })
    expect(notList.status).toBe(400)
    expect(notList.body.error).toBe('La lista de servicios no es válida.')

    const repeated = await put('st-1', { service_ids: ['svc-1', 'svc-1'] })
    expect(repeated.status).toBe(400)
    expect(repeated.body.error).toBe('La lista de servicios tiene repetidos.')

    // La relación original queda intacta.
    expect(links(db, 'st-1')).toHaveLength(1)
  })

  it('404 si algún servicio es de otra cuenta o no existe', async () => {
    const db = boot()

    const foreign = await put('st-1', { service_ids: ['svc-other'] })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error).toBe('Algún servicio seleccionado no existe.')

    const unknown = await put('st-1', { service_ids: ['nope'] })
    expect(unknown.status).toBe(404)

    expect(links(db, 'st-1').map((row) => row.service_id)).toEqual(['svc-1'])
  })

  it('404 si el barbero es de otra cuenta', async () => {
    boot()

    const res = await put('st-other', { service_ids: ['svc-1'] })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Esa persona del equipo no existe.')
  })

  it('rechaza a un agente con 403', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = await put('st-1', { service_ids: ['svc-1', 'svc-2'] })

    expect(res.status).toBe(403)
    expect(links(db, 'st-1')).toHaveLength(1)
  })
})
