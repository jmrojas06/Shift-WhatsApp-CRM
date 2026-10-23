import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  type TestResponse,
} from '../../../verticals/agenda/_lib/route-testing'

// ============================================================
// PATCH /api/modules/ventas/settings — interruptores de avisos:
// solo admin+, módulo activo, booleanos, parcial y por cuenta.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'admin' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

vi.mock('@/lib/verticals/admin-client', () => ({
  supabaseAdmin: () => h.state.db,
}))

import { PATCH } from './route'

function boot(options: { modules?: string[]; settings?: Row[] } = {}): FakeDb {
  const db = makeFakeDb({
    accounts: [{ id: TEST_ACCOUNT, modules: options.modules ?? ['ventas'], vertical_key: null }],
    sales_settings: options.settings ?? [],
  })
  h.state.db = db
  return db
}

async function patch(body: unknown) {
  return (await PATCH(jsonRequest(body))) as unknown as TestResponse
}

beforeEach(() => {
  h.state.role = 'admin'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('PATCH /api/modules/ventas/settings', () => {
  it('un admin apaga un aviso y recibe los ajustes completos', async () => {
    const db = boot()
    const res = await patch({ notify_shipped: false })

    expect(res.status).toBe(200)
    expect(res.body.settings).toEqual({
      notify_paid: true,
      notify_shipped: false,
      notify_delivered: true,
    })
    expect(db._tables.sales_settings).toHaveLength(1)
    expect(db._tables.sales_settings[0]).toMatchObject({ account_id: TEST_ACCOUNT, notify_shipped: false })
  })

  it('un owner también puede', async () => {
    h.state.role = 'owner'
    boot()
    expect((await patch({ notify_paid: false })).status).toBe(200)
  })

  it('es parcial: no pisa lo que no se envía', async () => {
    const db = boot({
      settings: [
        { account_id: TEST_ACCOUNT, notify_paid: false, notify_shipped: true, notify_delivered: true },
      ],
    })
    const res = await patch({ notify_delivered: false })

    expect(res.body.settings).toEqual({
      notify_paid: false,
      notify_shipped: true,
      notify_delivered: false,
    })
    expect(db._tables.sales_settings).toHaveLength(1)
  })

  it('acepta los tres a la vez', async () => {
    boot()
    const res = await patch({ notify_paid: false, notify_shipped: false, notify_delivered: false })
    expect(res.body.settings).toEqual({
      notify_paid: false,
      notify_shipped: false,
      notify_delivered: false,
    })
  })

  it('no toca los ajustes de otra cuenta', async () => {
    const db = boot({
      settings: [
        { account_id: 'acc-2', notify_paid: true, notify_shipped: true, notify_delivered: true },
      ],
    })
    await patch({ notify_paid: false })

    expect(db._tables.sales_settings.find((r) => r.account_id === 'acc-2')?.notify_paid).toBe(true)
    expect(db._tables.sales_settings).toHaveLength(2)
  })

  it('un agente recibe 403', async () => {
    h.state.role = 'agent'
    const db = boot()
    expect((await patch({ notify_paid: false })).status).toBe(403)
    expect(db._tables.sales_settings).toHaveLength(0)
  })

  it('un viewer recibe 403', async () => {
    h.state.role = 'viewer'
    boot()
    expect((await patch({ notify_paid: false })).status).toBe(403)
  })

  it('módulo apagado: 409', async () => {
    const db = boot({ modules: [] })
    const res = await patch({ notify_paid: false })

    expect(res.status).toBe(409)
    expect(db._tables.sales_settings).toHaveLength(0)
  })

  describe('validación (400)', () => {
    const cases: [string, unknown][] = [
      ['sin ninguna clave', {}],
      ['solo claves desconocidas', { otra: true }],
      ['valor que no es booleano', { notify_paid: 'no' }],
      ['null', { notify_paid: null }],
      ['número', { notify_shipped: 0 }],
      ['uno bueno y uno malo', { notify_paid: false, notify_delivered: 'x' }],
      ['cuerpo que no es un objeto', [true]],
    ]
    for (const [name, body] of cases) {
      it(name, async () => {
        const db = boot()
        const res = await patch(body)
        expect(res.status).toBe(400)
        expect(typeof res.body.error).toBe('string')
        expect(db._tables.sales_settings).toHaveLength(0)
      })
    }

    it('JSON roto', async () => {
      boot()
      const res = (await PATCH(brokenJsonRequest())) as unknown as TestResponse
      expect(res.status).toBe(400)
    })
  })

  it('las claves desconocidas junto a una válida se ignoran', async () => {
    const db = boot()
    const res = await patch({ notify_paid: false, hack: true })

    expect(res.status).toBe(200)
    expect(db._tables.sales_settings[0]).not.toHaveProperty('hack')
  })

  it('un error de la base responde 500 genérico', async () => {
    const db = boot()
    db._failNext('upsert', 'sales_settings', { message: 'detalle interno' })
    const res = await patch({ notify_paid: false })

    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('detalle interno')
  })
})
