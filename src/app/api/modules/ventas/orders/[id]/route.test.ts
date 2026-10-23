import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SALES_STAGES } from '@/modules/ventas/orders'
import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import {
  brokenJsonRequest,
  jsonRequest,
  TEST_ACCOUNT,
  type TestResponse,
} from '../../../../verticals/agenda/_lib/route-testing'

// ============================================================
// PATCH /api/modules/ventas/orders/[id] — acciones de estado:
// roles, módulo, aislamiento por cuenta, validación y avisos
// (solo cuando la acción cambió algo y el interruptor está prendido).
// ============================================================

const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const FOREIGN_ORDER_ID = '44444444-4444-4444-8444-444444444444'

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

vi.mock('@/lib/verticals/admin-client', () => ({
  supabaseAdmin: () => h.state.db,
}))

// Solo se falsea el envío; el registro del resultado (recordNotice) es el real.
vi.mock('@/modules/ventas/notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/ventas/notify')>()),
  sendOrderNotice: h.sendOrderNotice,
}))

import { PATCH } from './route'

function orderRow(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    account_id: TEST_ACCOUNT,
    number: 1001,
    contact_id: 'c-1',
    customer_name: 'Ana',
    customer_phone: '573001112233',
    conversation_id: null,
    deal_id: 'deal-1',
    subtotal: 100000,
    shipping: 0,
    total: 100000,
    currency: 'COP',
    payment_status: 'pending',
    status: 'new',
    city: 'Cali',
    address: 'Calle 5',
    carrier: null,
    tracking_number: null,
    paid_at: null,
    shipped_at: null,
    delivered_at: null,
    cancelled_at: null,
    ...overrides,
  }
}

function boot(
  options: { modules?: string[]; order?: Row; settings?: Row[] } = {},
): FakeDb {
  const db = makeFakeDb({
    accounts: [{ id: TEST_ACCOUNT, modules: options.modules ?? ['ventas'], vertical_key: null }],
    pipelines: [{ id: 'pipe-1', account_id: TEST_ACCOUNT, user_id: 'user-1', name: 'Ventas' }],
    pipeline_stages: SALES_STAGES.map((name, position) => ({
      id: `stage-${position}`,
      pipeline_id: 'pipe-1',
      name,
      position,
    })),
    deals: [
      { id: 'deal-1', account_id: TEST_ACCOUNT, pipeline_id: 'pipe-1', stage_id: 'stage-1' },
    ],
    orders: [
      options.order ?? orderRow(),
      orderRow({ id: FOREIGN_ORDER_ID, account_id: 'acc-2', deal_id: null }),
    ],
    order_items: [
      { id: 'i1', order_id: ORDER_ID, account_id: TEST_ACCOUNT, name: 'A', quantity: 1, unit_price: 100000, position: 0 },
    ],
    ...(options.settings ? { sales_settings: options.settings } : {}),
  })
  h.state.db = db
  return db
}

async function patch(id: string, body: unknown) {
  return (await PATCH(jsonRequest(body), {
    params: Promise.resolve({ id }),
  })) as unknown as TestResponse
}

const order = (db: FakeDb, id = ORDER_ID) => db._tables.orders.find((row) => row.id === id) as Row

beforeEach(() => {
  h.state.role = 'agent'
  h.sendOrderNotice.mockReset()
  h.sendOrderNotice.mockResolvedValue('sent')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('PATCH /api/modules/ventas/orders/[id]', () => {
  it('marcar pagado guarda, mueve el negocio y avisa "paid"', async () => {
    const db = boot()
    const res = await patch(ORDER_ID, { action: 'mark_paid' })

    expect(res.status).toBe(200)
    expect(res.body.notice).toBe('sent')
    expect(res.body.order).toMatchObject({ payment_status: 'paid', items: [{ name: 'A' }] })
    expect(order(db).payment_status).toBe('paid')
    expect(db._tables.deals[0].stage_id).toBe('stage-2') // Pagado
    expect(h.sendOrderNotice).toHaveBeenCalledTimes(1)
    expect(h.sendOrderNotice.mock.calls[0][1]).toMatchObject({ number: 1001, payment_status: 'paid' })
    expect(h.sendOrderNotice.mock.calls[0][2]).toBe('paid')
  })

  describe('el pedido devuelto refleja el aviso', () => {
    it('envío fallido: trae last_notice y el motivo, y queda guardado', async () => {
      const db = boot()
      h.sendOrderNotice.mockImplementation(async (client, row, kind) => {
        await client
          .from('orders')
          .update({ last_notice: kind, last_notice_error: 'El cliente no tiene WhatsApp vinculado' })
          .eq('id', row.id)
          .eq('account_id', row.account_id)
        return 'failed'
      })

      const res = await patch(ORDER_ID, { action: 'mark_paid' })

      expect(res.body.notice).toBe('failed')
      expect(res.body.order).toMatchObject({
        last_notice: 'paid',
        last_notice_error: 'El cliente no tiene WhatsApp vinculado',
        items: [{ name: 'A' }],
      })
      expect(order(db).last_notice_error).toBe('El cliente no tiene WhatsApp vinculado')
    })

    it('envío bueno tras uno fallido: el error viejo ya no aparece', async () => {
      boot({ order: orderRow({ last_notice: 'paid', last_notice_error: 'viejo' }) })
      h.sendOrderNotice.mockImplementation(async (client, row, kind) => {
        await client.from('orders').update({ last_notice: kind, last_notice_error: null }).eq('id', row.id)
        return 'sent'
      })
      const res = await patch(ORDER_ID, { action: 'mark_paid' })
      expect(res.body.order).toMatchObject({ last_notice: 'paid', last_notice_error: null })
    })

    it('si no se pueden leer los ajustes, el motivo genérico queda en el pedido y en la respuesta', async () => {
      const db = boot()
      db._failNext('select', 'sales_settings', { message: 'lectura rota' })

      const res = await patch(ORDER_ID, { action: 'mark_paid' })

      expect(res.body.notice).toBe('failed')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
      expect(order(db)).toMatchObject({
        last_notice: 'paid',
        last_notice_error: 'No se pudo mandar el mensaje por WhatsApp',
      })
      expect(res.body.order).toMatchObject({
        last_notice: 'paid',
        last_notice_error: 'No se pudo mandar el mensaje por WhatsApp',
      })
    })

    it('si el envío lanza, también queda el motivo genérico', async () => {
      const db = boot()
      h.sendOrderNotice.mockRejectedValue(new Error('Meta caída'))
      const res = await patch(ORDER_ID, { action: 'mark_paid' })
      expect(res.body.order).toMatchObject({ last_notice: 'paid', last_notice_error: 'No se pudo mandar el mensaje por WhatsApp' })
      expect(order(db).last_notice).toBe('paid')
    })

    it('"skipped" deja el pedido como estaba', async () => {
      boot({
        order: orderRow({ last_notice: 'paid', last_notice_error: 'previo' }),
        settings: [
          { account_id: TEST_ACCOUNT, notify_paid: false, notify_shipped: true, notify_delivered: true },
        ],
      })
      const res = await patch(ORDER_ID, { action: 'mark_paid' })
      expect(res.body.notice).toBe('skipped')
      expect(res.body.order).toMatchObject({ last_notice: 'paid', last_notice_error: 'previo' })
    })

    it('una acción sin aviso (cancelar) no toca last_notice', async () => {
      const db = boot()
      const res = await patch(ORDER_ID, { action: 'cancel' })
      expect(res.body.notice).toBeNull()
      expect(order(db).last_notice).toBeUndefined()
    })
  })

  it('marcar enviado pasa transportadora y guía y avisa "shipped"', async () => {
    const db = boot()
    const res = await patch(ORDER_ID, {
      action: 'mark_shipped',
      carrier: 'Servientrega',
      tracking_number: 'ABC123',
    })

    expect(res.status).toBe(200)
    expect(order(db)).toMatchObject({
      status: 'shipped',
      carrier: 'Servientrega',
      tracking_number: 'ABC123',
    })
    expect(h.sendOrderNotice.mock.calls[0][2]).toBe('shipped')
    expect(db._tables.deals[0].stage_id).toBe('stage-3') // Enviado
  })

  it('marcar enviado sin ciudad ni dirección en el pedido las toma del cuerpo', async () => {
    const db = boot({ order: orderRow({ city: null, address: null }) })
    const res = await patch(ORDER_ID, {
      action: 'mark_shipped',
      carrier: 'Coordinadora',
      tracking_number: 'Z9',
      city: 'Bogotá',
      address: 'Carrera 7',
    })

    expect(res.status).toBe(200)
    expect(order(db)).toMatchObject({ city: 'Bogotá', address: 'Carrera 7' })
  })

  it('marcar entregado avisa "delivered"', async () => {
    const db = boot({ order: orderRow({ status: 'shipped' }) })
    const res = await patch(ORDER_ID, { action: 'mark_delivered' })

    expect(res.status).toBe(200)
    expect(order(db).status).toBe('delivered')
    expect(h.sendOrderNotice.mock.calls[0][2]).toBe('delivered')
  })

  it('cancelar no avisa y notice es null', async () => {
    const db = boot()
    const res = await patch(ORDER_ID, { action: 'cancel' })

    expect(res.status).toBe(200)
    expect(res.body.notice).toBeNull()
    expect(order(db).status).toBe('cancelled')
    expect(h.sendOrderNotice).not.toHaveBeenCalled()
  })

  it('marcar pagado un pedido ya pagado no cambia nada ni avisa', async () => {
    const db = boot({
      order: orderRow({ payment_status: 'paid', paid_at: '2026-10-01T00:00:00.000Z' }),
    })
    const res = await patch(ORDER_ID, { action: 'mark_paid' })

    expect(res.status).toBe(200)
    expect(res.body.notice).toBeNull()
    expect(order(db).paid_at).toBe('2026-10-01T00:00:00.000Z')
    expect(h.sendOrderNotice).not.toHaveBeenCalled()
  })

  describe('interruptores de avisos', () => {
    const settings = (over: Partial<Record<string, boolean>>): Row[] => [
      {
        account_id: TEST_ACCOUNT,
        notify_paid: true,
        notify_shipped: true,
        notify_delivered: true,
        ...over,
      },
    ]

    it('aviso apagado: el cambio se guarda, no se envía y notice es "skipped"', async () => {
      const db = boot({ settings: settings({ notify_paid: false }) })
      const res = await patch(ORDER_ID, { action: 'mark_paid' })

      expect(res.status).toBe(200)
      expect(res.body.notice).toBe('skipped')
      expect(order(db).payment_status).toBe('paid')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
    })

    it('cada aviso respeta su propio interruptor', async () => {
      boot({ settings: settings({ notify_shipped: false }), order: orderRow({ status: 'shipped' }) })
      const delivered = await patch(ORDER_ID, { action: 'mark_delivered' })
      expect(delivered.body.notice).toBe('sent')
    })

    it('un fallo del envío no deshace el cambio: notice "failed"', async () => {
      const db = boot()
      h.sendOrderNotice.mockRejectedValue(new Error('Meta caída'))
      const res = await patch(ORDER_ID, { action: 'mark_paid' })

      expect(res.status).toBe(200)
      expect(res.body.notice).toBe('failed')
      expect(order(db).payment_status).toBe('paid')
    })
  })

  describe('permisos y cuenta', () => {
    it('un viewer recibe 403', async () => {
      h.state.role = 'viewer'
      const db = boot()
      const res = await patch(ORDER_ID, { action: 'mark_paid' })

      expect(res.status).toBe(403)
      expect(res.body.code).toBe('forbidden')
      expect(order(db).payment_status).toBe('pending')
    })

    it('módulo apagado: 409', async () => {
      const db = boot({ modules: ['agenda'] })
      const res = await patch(ORDER_ID, { action: 'mark_paid' })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('El módulo Ventas no está activo para esta cuenta.')
      expect(res.body.code).toBe('module_inactive')
      expect(order(db).payment_status).toBe('pending')
    })

    it('un pedido de otra cuenta responde 404 y no se toca', async () => {
      const db = boot()
      const res = await patch(FOREIGN_ORDER_ID, { action: 'mark_paid' })

      expect(res.status).toBe(404)
      expect(res.body.code).toBe('not_found')
      expect(order(db, FOREIGN_ORDER_ID).payment_status).toBe('pending')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
    })

    it('un id que no es uuid responde 404', async () => {
      boot()
      expect((await patch('abc', { action: 'mark_paid' })).status).toBe(404)
    })
  })

  describe('validación (400)', () => {
    it('acción desconocida', async () => {
      boot()
      const res = await patch(ORDER_ID, { action: 'borrar' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('La acción no es válida.')
      expect(res.body.code).toBe('invalid')
    })

    it('sin acción', async () => {
      boot()
      expect((await patch(ORDER_ID, {})).status).toBe(400)
    })

    it('cuerpo que no es un objeto', async () => {
      boot()
      expect((await patch(ORDER_ID, 'mark_paid')).status).toBe(400)
    })

    it('JSON roto', async () => {
      boot()
      const res = (await PATCH(brokenJsonRequest(), {
        params: Promise.resolve({ id: ORDER_ID }),
      })) as unknown as TestResponse
      expect(res.status).toBe(400)
    })

    it('enviado sin guía: 400 con el mensaje del dominio y nada cambia', async () => {
      const db = boot()
      const res = await patch(ORDER_ID, { action: 'mark_shipped', carrier: 'Servientrega' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Escribe el número de guía.')
      expect(res.body.code).toBe('invalid')
      expect(order(db).status).toBe('new')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
    })

    it('una transición que el estado no permite: 409 invalid_transition', async () => {
      const db = boot({ order: orderRow({ status: 'delivered' }) })
      const res = await patch(ORDER_ID, { action: 'cancel' })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('invalid_transition')
      expect(res.body.error).toBe('Un pedido entregado no se puede cancelar.')
      expect(order(db).status).toBe('delivered')
      expect(h.sendOrderNotice).not.toHaveBeenCalled()
    })

    it('campos que no son del contrato (status, total) se ignoran', async () => {
      const db = boot()
      const res = await patch(ORDER_ID, { action: 'mark_paid', status: 'delivered', total: 1 })

      expect(res.status).toBe(200)
      expect(order(db)).toMatchObject({ status: 'new', total: 100000, payment_status: 'paid' })
    })
  })

  it('si la base rechaza el cambio por estado viejo (42501): 409 stale y sin aviso', async () => {
    const db = boot()
    db._failNext('update', 'orders', { code: '42501', message: 'order status cannot move' })
    const res = await patch(ORDER_ID, { action: 'mark_paid' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('stale')
    expect(order(db).payment_status).toBe('pending')
    expect(h.sendOrderNotice).not.toHaveBeenCalled()
  })

  it('un error inesperado de la base responde 500 genérico', async () => {
    const db = boot()
    db._failNext('select', 'orders', { message: 'detalle interno' })
    const res = await patch(ORDER_ID, { action: 'mark_paid' })

    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('detalle interno')
  })
})
