import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/barberia/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../_lib/route-testing'

// ============================================================
// /api/verticals/barberia/services — crear y reordenar contra el
// fake de PostgREST compartido: permisos, validación, duplicados y
// aislamiento por cuenta.
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

import { POST, PUT } from './route'

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

const svc = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_services.find((row) => row.id === id)

beforeEach(() => {
  h.state.role = 'owner'
})

describe('POST /api/verticals/barberia/services', () => {
  it('crea el servicio al final del orden y con la cuenta de la sesión', async () => {
    const db = boot()

    const res = (await POST(
      jsonRequest({ name: 'Cejas', duration_minutes: 15, price: 8000 }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.service).toMatchObject({
      name: 'Cejas',
      durationMinutes: 15,
      price: 8000,
      isActive: true,
      position: 2,
    })
    expect(db._tables.booking_services).toHaveLength(4)
    expect(db._tables.booking_services.at(-1)?.account_id).toBe(TEST_ACCOUNT)
  })

  it('admin también puede (límite exacto del rol)', async () => {
    boot()
    h.state.role = 'admin'

    const res = (await POST(
      jsonRequest({ name: 'Cejas', duration_minutes: 15, price: 8000 }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
  })

  it('rechaza agent y viewer con 403 sin crear nada', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      const res = (await POST(
        jsonRequest({ name: 'Cejas', duration_minutes: 15, price: 8000 }),
      )) as unknown as TestResponse
      expect(res.status).toBe(403)
    }
    expect(db._tables.booking_services).toHaveLength(3)
  })

  it('400 con mensajes en es-CO para cada validación', async () => {
    boot()
    const cases: [Record<string, unknown>, string][] = [
      [
        { duration_minutes: 30, price: 1000 },
        'El nombre del servicio es obligatorio.',
      ],
      [
        { name: 'Cejas', duration_minutes: 0, price: 1000 },
        'La duración debe ser un número entero entre 1 y 480 minutos.',
      ],
      [
        { name: 'Cejas', duration_minutes: 15, price: -1 },
        'El precio debe estar entre 0 y 99.999.999,99 con máximo 2 decimales.',
      ],
    ]
    for (const [body, message] of cases) {
      const res = (await POST(jsonRequest(body))) as unknown as TestResponse
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(message)
    }
  })

  it('409 si el nombre ya existe en la cuenta (case-insensitive)', async () => {
    boot()

    const res = (await POST(
      jsonRequest({ name: 'corte', duration_minutes: 30, price: 1000 }),
    )) as unknown as TestResponse

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('duplicate_name')
    expect(res.body.error).toBe('Ya existe un servicio con ese nombre.')
  })
})

describe('PUT /api/verticals/barberia/services', () => {
  it('reordena con la permutación exacta de la cuenta', async () => {
    const db = boot()

    const res = (await PUT(
      jsonRequest({ ids: ['svc-2', 'svc-1'] }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(svc(db, 'svc-2')?.position).toBe(0)
    expect(svc(db, 'svc-1')?.position).toBe(1)
    // El servicio de la otra cuenta queda intacto.
    expect(svc(db, 'svc-other')?.position).toBe(0)
  })

  it('400 si faltan ids o la lista no coincide con la cuenta', async () => {
    const db = boot()

    const missing = (await PUT(
      jsonRequest({ ids: ['svc-1'] }),
    )) as unknown as TestResponse
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe(
      'La lista de orden debe incluir todos los elementos actuales.',
    )

    const foreign = (await PUT(
      jsonRequest({ ids: ['svc-1', 'svc-other'] }),
    )) as unknown as TestResponse
    expect(foreign.status).toBe(400)
    expect(foreign.body.error).toBe(
      'La lista de orden no coincide con los elementos actuales.',
    )

    // Nada se reordenó tras los rechazos.
    expect(svc(db, 'svc-1')?.position).toBe(0)
    expect(svc(db, 'svc-2')?.position).toBe(1)
  })

  it('rechaza a un agente con 403', async () => {
    boot()
    h.state.role = 'agent'

    const res = (await PUT(
      jsonRequest({ ids: ['svc-2', 'svc-1'] }),
    )) as unknown as TestResponse

    expect(res.status).toBe(403)
  })
})
