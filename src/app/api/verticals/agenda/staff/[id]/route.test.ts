import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// PATCH /api/verticals/agenda/staff/[id] — editar/desactivar
// barberos con aislamiento por cuenta.
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

import { PATCH } from './route'

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

async function patch(id: string, body: unknown) {
  return (await PATCH(jsonRequest(body), {
    params: Promise.resolve({ id }),
  })) as unknown as TestResponse
}

const staff = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_staff.find((row) => row.id === id)

beforeEach(() => {
  h.state.role = 'owner'
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

  it('404 si el barbero es de otra cuenta y no lo toca', async () => {
    const db = boot()

    const res = await patch('st-other', { is_active: false })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('El barbero no existe.')
    expect(staff(db, 'st-other')?.is_active).toBe(true)
  })

  it('400 sin cambios', async () => {
    boot()
    const res = await patch('st-1', {})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No hay cambios que guardar en el barbero.')
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
