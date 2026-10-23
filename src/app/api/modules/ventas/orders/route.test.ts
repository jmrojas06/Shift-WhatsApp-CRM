import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stubCreateOrder } from '@/modules/ventas/testing/create-order-stub'
import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  type TestResponse,
} from '../../../verticals/agenda/_lib/route-testing'

// ============================================================
// POST /api/modules/ventas/orders — roles, módulo, validación,
// aislamiento por cuenta, total calculado en el servidor y avisos.
// La ruta y el repositorio corren de punta a punta contra el fake de
// PostgREST compartido; solo el envío del aviso (notify.ts) se mockea.
// ============================================================

const CONTACT = '11111111-1111-4111-8111-111111111111'
const FOREIGN_CONTACT = '99999999-9999-4999-8999-999999999999'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
  sendOrderNotice: vi.fn(),
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

// El service-role de la ruta es el mismo fake que ve el usuario en el test.
vi.mock('@/lib/verticals/admin-client', () => ({
  supabaseAdmin: () => h.state.db,
}))

vi.mock('@/modules/ventas/notify', () => ({
  sendOrderNotice: h.sendOrderNotice,
}))

import { POST } from './route'

function boot(overrides: { modules?: string[]; extra?: Record<string, Row[]> } = {}): FakeDb {
  const db = makeFakeDb({
    accounts: [
      { id: TEST_ACCOUNT, modules: overrides.modules ?? ['agenda', 'ventas'], vertical_key: null },
    ],
    contacts: [
      { id: CONTACT, account_id: TEST_ACCOUNT, name: 'Ana', phone: '573001112233' },
      { id: FOREIGN_CONTACT, account_id: 'acc-2', name: 'Ajena', phone: '573009998877' },
    ],
    conversations: [{ id: CONVERSATION, account_id: TEST_ACCOUNT, contact_id: CONTACT }],
    ...overrides.extra,
  })
  stubCreateOrder(db)
  h.state.db = db
  return db
}

const validBody = (extra: Record<string, unknown> = {}) => ({
  contactId: CONTACT,
  conversationId: CONVERSATION,
  items: [
    { name: 'Anillo', quantity: 2, unitPrice: 50000 },
    { name: 'Cadena', quantity: 1, unitPrice: 30000 },
  ],
  shipping: 10000,
  city: 'Medellín',
  address: 'Calle 1 # 2-3',
  ...extra,
})

async function post(body: unknown) {
  return (await POST(jsonRequest(body))) as unknown as TestResponse
}

beforeEach(() => {
  h.state.role = 'agent'
  h.sendOrderNotice.mockReset()
  h.sendOrderNotice.mockResolvedValue('sent')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/modules/ventas/orders', () => {
  it('un agente crea el pedido: 201 con el pedido, sus líneas y el negocio', async () => {
    const db = boot()
    const res = await post(validBody())

    expect(res.status).toBe(201)
    const order = res.body.order as Record<string, unknown> & { items: Row[] }
    expect(order).toMatchObject({ number: 1001, total: 140000, currency: 'COP', status: 'new' })
    expect(order.items.map((i) => i.name)).toEqual(['Anillo', 'Cadena'])
    expect(db._tables.deals).toHaveLength(1)
    expect(order.deal_id).toBe(db._tables.deals[0].id)
    // Sin pago no hay aviso.
    expect(res.body.notice).toBeNull()
    expect(h.sendOrderNotice).not.toHaveBeenCalled()
  })

  it('un owner y un admin también pueden', async () => {
    for (const role of ['owner', 'admin'] as const) {
      h.state.role = role
      boot()
      expect((await post(validBody())).status).toBe(201)
    }
  })

  it('un viewer recibe 403 y no se crea nada', async () => {
    h.state.role = 'viewer'
    const db = boot()
    const res = await post(validBody())

    expect(res.status).toBe(403)
    expect(db._rpcCalls).toHaveLength(0)
  })

  it('con el módulo apagado responde 409 con el mensaje del módulo', async () => {
    const db = boot({ modules: ['agenda'] })
    const res = await post(validBody())

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('El módulo Ventas no está activo para esta cuenta.')
    expect(db._rpcCalls).toHaveLength(0)
  })

  it('un total o subtotal en el cuerpo se ignora: el total lo calcula el servidor', async () => {
    const db = boot()
    const res = await post(validBody({ total: 1, subtotal: 1, shipping: 0 }))

    expect(res.status).toBe(201)
    expect((res.body.order as { total: number }).total).toBe(130000)
    expect(db._rpcCalls[0].args).not.toHaveProperty('p_total')
    expect(JSON.stringify(db._rpcCalls[0].args)).not.toContain('"total"')
  })

  it('un contacto de otra cuenta responde 404 y no crea pedido ni negocio', async () => {
    const db = boot()
    const res = await post(validBody({ contactId: FOREIGN_CONTACT }))

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('El contacto o la conversación no existe en tu cuenta.')
    expect(db._tables.orders ?? []).toHaveLength(0)
    expect(db._tables.deals ?? []).toHaveLength(0)
  })

  it('una conversación que no es de la cuenta responde 404', async () => {
    boot()
    const res = await post(validBody({ conversationId: '77777777-7777-4777-8777-777777777777' }))
    expect(res.status).toBe(404)
  })

  describe('validación (400)', () => {
    const cases: [string, unknown][] = [
      ['sin productos', validBody({ items: [] })],
      ['sin contacto', { ...validBody(), contactId: undefined }],
      ['cantidad decimal', validBody({ items: [{ name: 'A', quantity: 1.5, unitPrice: 10 }] })],
      ['precio negativo', validBody({ items: [{ name: 'A', quantity: 1, unitPrice: -1 }] })],
      ['paid que no es booleano', validBody({ paid: 'si' })],
      ['cuerpo que no es un objeto', [1, 2]],
    ]
    for (const [name, body] of cases) {
      it(name, async () => {
        const db = boot()
        const res = await post(body)
        expect(res.status).toBe(400)
        expect(typeof res.body.error).toBe('string')
        expect(db._rpcCalls).toHaveLength(0)
      })
    }

    it('JSON roto', async () => {
      boot()
      const res = (await POST(brokenJsonRequest())) as unknown as TestResponse
      expect(res.status).toBe(400)
    })
  })

  describe('aviso de pago', () => {
    it('un pedido que nace pagado avisa con "paid" y devuelve el resultado', async () => {
      const db = boot()
      const res = await post(validBody({ paid: true }))

      expect(res.status).toBe(201)
      expect(res.body.notice).toBe('sent')
      expect(h.sendOrderNotice).toHaveBeenCalledTimes(1)
      const [client, order, kind] = h.sendOrderNotice.mock.calls[0]
      expect(client).toBe(db)
      expect(order).toMatchObject({ number: 1001, payment_status: 'paid' })
      expect(kind).toBe('paid')
      // El negocio nace en "Pagado".
      const pagado = db._tables.pipeline_stages.find((s) => s.name === 'Pagado')
      expect(db._tables.deals[0].stage_id).toBe(pagado?.id)
    })

    it('con el aviso de pago apagado no se envía y responde "skipped"', async () => {
      boot({
        extra: {
          sales_settings: [
            { account_id: TEST_ACCOUNT, notify_paid: false, notify_shipped: true, notify_delivered: true },
          ],
        },
      })
      const res = await post(validBody({ paid: true }))

      expect(res.status).toBe(201)
      expect(res.body.notice).toBe('skipped')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
    })

    it('apagar otro aviso no afecta al de pago', async () => {
      boot({
        extra: {
          sales_settings: [
            { account_id: TEST_ACCOUNT, notify_paid: true, notify_shipped: false, notify_delivered: false },
          ],
        },
      })
      const res = await post(validBody({ paid: true }))
      expect(res.body.notice).toBe('sent')
    })

    it('si el envío falla, el pedido queda creado y se responde "failed"', async () => {
      const db = boot()
      h.sendOrderNotice.mockRejectedValue(new Error('Meta caída'))

      const res = await post(validBody({ paid: true }))

      expect(res.status).toBe(201)
      expect(res.body.notice).toBe('failed')
      expect(db._tables.orders).toHaveLength(1)
    })

    it('un resultado "failed" del envío se devuelve tal cual', async () => {
      boot()
      h.sendOrderNotice.mockResolvedValue('failed')
      const res = await post(validBody({ paid: true }))
      expect(res.body.notice).toBe('failed')
    })

    it('si no se pueden leer los ajustes, responde "failed" sin tumbar el pedido', async () => {
      const db = boot()
      db._failNext('select', 'sales_settings', { message: 'lectura rota' })

      const res = await post(validBody({ paid: true }))

      expect(res.status).toBe(201)
      expect(res.body.notice).toBe('failed')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
    })
  })

  it('un error inesperado de la base responde 500 genérico', async () => {
    const db = boot()
    db._failNext('rpc', 'create_order', { code: 'XX000', message: 'detalle interno' })
    const res = await post(validBody())

    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('detalle interno')
  })
})
