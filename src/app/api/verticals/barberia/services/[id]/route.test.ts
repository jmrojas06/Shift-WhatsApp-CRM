import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/barberia/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// PATCH /api/verticals/barberia/services/[id] — editar/desactivar
// con aislamiento por cuenta contra el fake de PostgREST compartido.
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

import { PATCH } from './route'

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
  }
}

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

async function patch(id: string, body: unknown) {
  return (await PATCH(jsonRequest(body), {
    params: Promise.resolve({ id }),
  })) as unknown as TestResponse
}

const svc = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_services.find((row) => row.id === id)

beforeEach(() => {
  h.state.role = 'owner'
})

describe('PATCH /api/verticals/barberia/services/[id]', () => {
  it('edita el precio y desactiva sin borrar la fila', async () => {
    const db = boot()

    const res = await patch('svc-1', { price: 30000, is_active: false })

    expect(res.status).toBe(200)
    expect(res.body.service).toMatchObject({ price: 30000, isActive: false })
    expect(svc(db, 'svc-1')).toBeDefined()
  })

  it('404 si el servicio es de otra cuenta y no lo toca', async () => {
    const db = boot()

    const res = await patch('svc-other', { price: 1 })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('El servicio no existe.')
    expect(svc(db, 'svc-other')?.price).toBe(100)
  })

  it('404 si el servicio no existe', async () => {
    boot()
    const res = await patch('nope', { price: 1 })
    expect(res.status).toBe(404)
  })

  it('400 sin cambios o con campos inválidos', async () => {
    boot()

    const empty = await patch('svc-1', {})
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe('No hay cambios que guardar en el servicio.')

    const badPrice = await patch('svc-1', { price: 1.005 })
    expect(badPrice.status).toBe(400)
  })

  it('409 al renombrar a un nombre ya existente', async () => {
    boot()

    const res = await patch('svc-1', { name: 'barba' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('duplicate_name')
  })

  it('rechaza a un agente con 403', async () => {
    const db = boot()
    h.state.role = 'agent'

    const res = await patch('svc-1', { price: 30000 })

    expect(res.status).toBe(403)
    expect(svc(db, 'svc-1')?.price).toBe(25000)
  })
})
