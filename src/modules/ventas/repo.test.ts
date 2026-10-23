import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  asClient,
  makeFakeDb,
  type FakeDb,
  type Row,
} from '@/verticals/agenda/agent/testing/fake-db'

import { validateOrderCreate, SALES_STAGES, type ValidOrderCreate } from './orders'
import {
  SalesError,
  createOrder,
  ensureSalesPipeline,
  getSalesSettings,
  saveSalesSettings,
  updateOrderStatus,
} from './repo'

// ============================================================
// Repositorio de Ventas contra el fake de PostgREST. `create_order`
// es una función SQL: el fake no la ejecuta, así que cada test
// registra con `_onRpc` el comportamiento mínimo (insertar el pedido
// y sus líneas, o responder con un error de Postgres).
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER_ACCOUNT = 'acc-2'
const USER = 'user-1'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_ORDER_ID = '44444444-4444-4444-8444-444444444444'

const NOW = new Date('2026-10-23T15:00:00.000Z')

function ctxFor(supabase: FakeDb) {
  return { supabase: asClient(supabase), accountId: ACCOUNT, userId: USER }
}

function input(overrides: Partial<ValidOrderCreate> = {}): ValidOrderCreate {
  return {
    contactId: CONTACT,
    conversationId: CONVERSATION,
    items: [
      { name: 'Anillo', quantity: 2, unitPrice: 50000 },
      { name: 'Cadena', quantity: 1, unitPrice: 30000.5 },
    ],
    shipping: 10000,
    paid: false,
    city: 'Medellín',
    address: 'Calle 1 # 2-3',
    idNumber: null,
    notes: null,
    ...overrides,
  }
}

/**
 * Simula `create_order`: guarda el pedido y sus líneas en las tablas de
 * `target` (la base que ve el servidor) con lo que calcularía la función.
 */
function stubCreateOrder(rpcDb: FakeDb, target: FakeDb = rpcDb) {
  rpcDb._onRpc('create_order', (args) => {
    const items = args.p_items as { name: string; quantity: number; unit_price: number }[]
    const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0)
    const shipping = (args.p_shipping as number) ?? 0
    const paid = args.p_paid === true
    const fields = (args.p_fields ?? {}) as Record<string, string | null>
    const number = 1001 + (target._tables.orders ?? []).length
    const order: Row = {
      id: ORDER_ID,
      account_id: args.p_account_id,
      number,
      contact_id: args.p_contact_id,
      customer_name: 'Ana',
      customer_phone: '573001112233',
      conversation_id: args.p_conversation_id,
      deal_id: null,
      subtotal,
      shipping,
      total: subtotal + shipping,
      currency: 'COP',
      payment_status: paid ? 'paid' : 'pending',
      status: 'new',
      city: fields.city ?? null,
      address: fields.address ?? null,
      id_number: fields.id_number ?? null,
      carrier: null,
      tracking_number: null,
      notes: fields.notes ?? null,
      last_notice: null,
      last_notice_error: null,
      created_by: USER,
      paid_at: paid ? NOW.toISOString() : null,
      shipped_at: null,
      delivered_at: null,
      cancelled_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    }
    ;(target._tables.orders ??= []).push(order)
    items.forEach((item, position) => {
      ;(target._tables.order_items ??= []).push({
        id: `item-${position}`,
        order_id: order.id,
        account_id: args.p_account_id,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        position,
      })
    })
    return { data: { ...order }, error: null }
  })
}

function pipelineSeed(): Record<string, Row[]> {
  return {
    pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, user_id: USER, name: 'Ventas' }],
    pipeline_stages: SALES_STAGES.map((name, position) => ({
      id: `stage-${position}`,
      pipeline_id: 'pipe-1',
      name,
      position,
    })),
  }
}

const stageId = (name: string) => `stage-${SALES_STAGES.indexOf(name as never)}`

describe('ensureSalesPipeline', () => {
  it('crea el pipeline Ventas con las seis etapas en orden', async () => {
    const db = makeFakeDb({})
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.pipelines[0]).toMatchObject({
      id: result.pipelineId,
      account_id: ACCOUNT,
      user_id: USER,
      name: 'Ventas',
    })
    const stages = db._tables.pipeline_stages
    expect(stages.map((s) => s.name)).toEqual([...SALES_STAGES])
    expect(stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5])
    expect(stages.every((s) => s.pipeline_id === result.pipelineId)).toBe(true)
    expect(stages.every((s) => typeof s.color === 'string')).toBe(true)
    for (const name of SALES_STAGES) {
      expect(result.stageIdByName[name]).toBe(stages.find((s) => s.name === name)?.id)
    }
  })

  it('es idempotente: la segunda llamada no duplica nada', async () => {
    const db = makeFakeDb({})
    const first = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)
    const second = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(second).toEqual(first)
    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.pipeline_stages).toHaveLength(6)
  })

  it('reconoce el nombre sin importar mayúsculas ni espacios', async () => {
    const db = makeFakeDb({
      ...pipelineSeed(),
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, user_id: USER, name: '  VENTAS ' }],
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(result.pipelineId).toBe('pipe-1')
    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.pipeline_stages).toHaveLength(6)
  })

  it('rellena solo las etapas que faltan y conserva las del dueño', async () => {
    const db = makeFakeDb({
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, user_id: USER, name: 'Ventas' }],
      pipeline_stages: [
        { id: 's-a', pipeline_id: 'pipe-1', name: 'pagado', position: 0, color: '#111111' },
        { id: 's-b', pipeline_id: 'pipe-1', name: 'Mi etapa', position: 1, color: '#222222' },
      ],
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    const stages = db._tables.pipeline_stages
    // Las dos del dueño siguen ahí, sin tocar.
    expect(stages.find((s) => s.id === 's-a')).toMatchObject({ name: 'pagado', color: '#111111' })
    expect(stages.find((s) => s.id === 's-b')?.name).toBe('Mi etapa')
    // "pagado" cuenta como "Pagado": no se duplica.
    expect(stages.filter((s) => String(s.name).toLowerCase() === 'pagado')).toHaveLength(1)
    expect(result.stageIdByName.Pagado).toBe('s-a')
    // Faltaban 5: se agregan al final, con posiciones nuevas.
    expect(stages).toHaveLength(7)
    const added = stages.filter((s) => !['s-a', 's-b'].includes(String(s.id)))
    expect(added.map((s) => s.name)).toEqual([
      'Nuevo',
      'Pago pendiente',
      'Enviado',
      'Entregado',
      'Cancelado',
    ])
    const positions = stages.map((s) => s.position as number)
    expect(new Set(positions).size).toBe(positions.length)
    expect(Math.min(...added.map((s) => s.position as number))).toBeGreaterThan(1)
  })

  it('no mira pipelines de otra cuenta', async () => {
    const db = makeFakeDb({
      pipelines: [{ id: 'pipe-x', account_id: OTHER_ACCOUNT, user_id: 'u2', name: 'Ventas' }],
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(result.pipelineId).not.toBe('pipe-x')
    expect(db._tables.pipelines).toHaveLength(2)
  })

  it('propaga un error de PostgREST', async () => {
    const db = makeFakeDb({})
    db._failNext('select', 'pipelines', { message: 'boom' })
    await expect(ensureSalesPipeline(asClient(db), ACCOUNT, USER)).rejects.toMatchObject({
      message: 'boom',
    })
  })
})

describe('createOrder', () => {
  let db: FakeDb
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    db = makeFakeDb({})
    stubCreateOrder(db)
  })

  it('llama la función con el cliente del usuario y los datos validados', async () => {
    const userDb = makeFakeDb({})
    stubCreateOrder(userDb, db)

    await createOrder(asClient(db), ctxFor(userDb), input({ paid: true, idNumber: '123.456', notes: 'Regalo' }))

    expect(db._rpcCalls).toHaveLength(0)
    expect(userDb._rpcCalls).toHaveLength(1)
    expect(userDb._rpcCalls[0]).toEqual({
      name: 'create_order',
      args: {
        p_account_id: ACCOUNT,
        p_contact_id: CONTACT,
        p_conversation_id: CONVERSATION,
        p_items: [
          { name: 'Anillo', quantity: 2, unit_price: 50000 },
          { name: 'Cadena', quantity: 1, unit_price: 30000.5 },
        ],
        p_shipping: 10000,
        p_paid: true,
        p_fields: { city: 'Medellín', address: 'Calle 1 # 2-3', id_number: '123.456', notes: 'Regalo' },
      },
    })
  })

  it('devuelve el pedido con sus líneas ordenadas', async () => {
    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order).toMatchObject({ id: ORDER_ID, number: 1001, total: 140000.5, currency: 'COP' })
    expect(order.items.map((i) => [i.name, i.quantity, i.unit_price, i.position])).toEqual([
      ['Anillo', 2, 50000, 0],
      ['Cadena', 1, 30000.5, 1],
    ])
  })

  it('el pedido sale de un body con un total mentiroso: el total lo pone la función', async () => {
    const parsed = validateOrderCreate({
      contactId: CONTACT,
      items: [{ name: 'Anillo', quantity: 1, unitPrice: 100 }],
      total: 1,
      subtotal: 1,
    })
    if (!parsed.ok) throw new Error(parsed.message)
    await createOrder(asClient(db), ctxFor(db), parsed.value)

    expect(db._rpcCalls[0].args).not.toHaveProperty('p_total')
    expect(db._tables.orders[0].total).toBe(100)
  })

  it('crea el pipeline y el negocio en la etapa "Pago pendiente" y guarda deal_id', async () => {
    const order = await createOrder(asClient(db), ctxFor(db), input())

    const [deal] = db._tables.deals
    const pendiente = db._tables.pipeline_stages.find((s) => s.name === 'Pago pendiente')
    expect(deal).toMatchObject({
      account_id: ACCOUNT,
      user_id: USER,
      title: 'Pedido #1001',
      value: 140000.5,
      currency: 'COP',
      contact_id: CONTACT,
      conversation_id: CONVERSATION,
      stage_id: pendiente?.id,
      pipeline_id: db._tables.pipelines[0].id,
      status: 'open',
    })
    expect(order.deal_id).toBe(deal.id)
    expect(db._tables.orders[0].deal_id).toBe(deal.id)
  })

  it('un pedido ya pagado entra en la etapa "Pagado"', async () => {
    await createOrder(asClient(db), ctxFor(db), input({ paid: true }))

    const pagado = db._tables.pipeline_stages.find((s) => s.name === 'Pagado')
    expect(db._tables.deals[0].stage_id).toBe(pagado?.id)
  })

  it('reutiliza el pipeline Ventas que ya existe', async () => {
    db = makeFakeDb(pipelineSeed())
    stubCreateOrder(db)
    await createOrder(asClient(db), ctxFor(db), input())
    await createOrder(asClient(db), ctxFor(db), input())

    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.deals).toHaveLength(2)
  })

  it('sin conversación, el negocio va sin conversación', async () => {
    await createOrder(asClient(db), ctxFor(db), input({ conversationId: null }))

    expect(db._rpcCalls[0].args.p_conversation_id).toBeNull()
    expect(db._tables.deals[0].conversation_id).toBeNull()
  })

  it('si el negocio falla, el pedido igual se devuelve (y se registra el error)', async () => {
    db._failNext('insert', 'deals', { message: 'deals roto' })

    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order.number).toBe(1001)
    expect(order.deal_id).toBeNull()
    expect(db._tables.orders).toHaveLength(1)
    expect(db._tables.deals ?? []).toHaveLength(0)
    expect(console.error).toHaveBeenCalled()
  })

  it('si el pipeline no se puede preparar, el pedido igual se devuelve', async () => {
    db._failNext('insert', 'pipelines', { message: 'sin permiso' })

    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order.deal_id).toBeNull()
    expect(db._tables.orders).toHaveLength(1)
  })

  it('si no se puede enlazar deal_id, el pedido igual se devuelve', async () => {
    db._failNext('update', 'orders', { message: 'update roto' })

    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order.number).toBe(1001)
    expect(order.deal_id).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })

  it('si no se pueden leer las líneas, devuelve las que se enviaron', async () => {
    db._failNext('select', 'order_items', { message: 'lectura rota' })

    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order.items.map((i) => [i.name, i.quantity, i.unit_price])).toEqual([
      ['Anillo', 2, 50000],
      ['Cadena', 1, 30000.5],
    ])
  })

  describe('errores de la función', () => {
    const invalid = 'Los datos del pedido no son válidos. Revisa los productos, precios y el envío.'
    const cases: [string, number, string][] = [
      ['42501', 403, 'No tienes permiso para crear pedidos en esta cuenta.'],
      ['P0001', 409, 'El módulo Ventas no está activo para esta cuenta.'],
      ['23503', 404, 'El contacto o la conversación no existe en tu cuenta.'],
      ['23514', 400, invalid],
      ['22023', 400, invalid],
    ]
    for (const [code, status, message] of cases) {
      it(`${code} → ${status} con mensaje en español (nunca el crudo de Postgres)`, async () => {
        db._failNext('rpc', 'create_order', { code, message: 'raw postgres text' })

        const error = await createOrder(asClient(db), ctxFor(db), input()).catch((e) => e)

        expect(error).toBeInstanceOf(SalesError)
        expect(error.status).toBe(status)
        expect(error.message).toBe(message)
        expect(db._tables.deals ?? []).toHaveLength(0)
      })
    }

    it('cualquier otro error se lanza tal cual (500 en la ruta)', async () => {
      db._failNext('rpc', 'create_order', { code: 'XX000', message: 'se cayó' })
      const error = await createOrder(asClient(db), ctxFor(db), input()).catch((e) => e)

      expect(error).not.toBeInstanceOf(SalesError)
      expect(error.message).toBe('se cayó')
    })

    it('función ausente (054 sin aplicar) también se lanza', async () => {
      const bare = makeFakeDb({})
      const error = await createOrder(asClient(bare), ctxFor(bare), input()).catch((e) => e)
      expect(error).not.toBeInstanceOf(SalesError)
      expect(error.message).toContain('create_order')
    })
  })
})

describe('updateOrderStatus', () => {
  function orderRow(overrides: Row = {}): Row {
    return {
      id: ORDER_ID,
      account_id: ACCOUNT,
      number: 1001,
      contact_id: CONTACT,
      customer_name: 'Ana',
      customer_phone: '573001112233',
      conversation_id: CONVERSATION,
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

  function seedDb(order: Row = orderRow()): FakeDb {
    return makeFakeDb({
      ...pipelineSeed(),
      orders: [
        order,
        orderRow({ id: OTHER_ORDER_ID, account_id: OTHER_ACCOUNT, deal_id: 'deal-x' }),
      ],
      order_items: [
        { id: 'i2', order_id: ORDER_ID, account_id: ACCOUNT, name: 'B', quantity: 1, unit_price: 5, position: 1 },
        { id: 'i1', order_id: ORDER_ID, account_id: ACCOUNT, name: 'A', quantity: 2, unit_price: 10, position: 0 },
      ],
      deals: [
        {
          id: 'deal-1',
          account_id: ACCOUNT,
          pipeline_id: 'pipe-1',
          stage_id: stageId('Pago pendiente'),
          title: 'Pedido #1001',
        },
        {
          id: 'deal-x',
          account_id: OTHER_ACCOUNT,
          pipeline_id: 'pipe-x',
          stage_id: 'stage-x',
          title: 'Pedido #1001',
        },
      ],
    })
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('marca pagado: guarda el cambio, mueve el negocio y devuelve el aviso', async () => {
    const db = seedDb()
    const result = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW)

    expect(result.changed).toBe(true)
    expect(result.notice).toBe('paid')
    expect(result.order).toMatchObject({ payment_status: 'paid', paid_at: NOW.toISOString() })
    expect(result.order.items.map((i) => i.name)).toEqual(['A', 'B'])
    expect(db._tables.orders[0]).toMatchObject({ payment_status: 'paid', paid_at: NOW.toISOString() })
    expect(db._tables.deals[0].stage_id).toBe(stageId('Pagado'))
  })

  it('marcar pagado un pedido ya pagado no escribe nada ni avisa', async () => {
    const db = seedDb(orderRow({ payment_status: 'paid', paid_at: '2026-10-01T00:00:00.000Z' }))
    const updateSpy = vi.spyOn(db as unknown as { from: (t: string) => unknown }, 'from')

    const result = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW)

    expect(result).toMatchObject({ changed: false, notice: null })
    expect(result.order.paid_at).toBe('2026-10-01T00:00:00.000Z')
    expect(db._tables.orders[0].paid_at).toBe('2026-10-01T00:00:00.000Z')
    // Solo lecturas: ni update de orders ni de deals.
    const writes = updateSpy.mock.calls.filter(([t]) => t === 'deals')
    expect(writes).toHaveLength(0)
    expect(db._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
  })

  it('marca enviado con transportadora y guía y mueve el negocio a "Enviado"', async () => {
    const db = seedDb()
    const result = await updateOrderStatus(
      asClient(db),
      ctxFor(db),
      ORDER_ID,
      'mark_shipped',
      { carrier: 'Servientrega', tracking_number: 'ABC123' },
      NOW,
    )

    expect(result.notice).toBe('shipped')
    expect(db._tables.orders[0]).toMatchObject({
      status: 'shipped',
      shipped_at: NOW.toISOString(),
      carrier: 'Servientrega',
      tracking_number: 'ABC123',
    })
    expect(db._tables.deals[0].stage_id).toBe(stageId('Enviado'))
  })

  it('cancelar mueve el negocio a "Cancelado" y no avisa', async () => {
    const db = seedDb()
    const result = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'cancel', {}, NOW)

    expect(result).toMatchObject({ changed: true, notice: null })
    expect(db._tables.deals[0].stage_id).toBe(stageId('Cancelado'))
  })

  it('una acción inválida para el estado es un 400 con el mensaje del dominio', async () => {
    const db = seedDb(orderRow({ status: 'delivered' }))
    await expect(
      updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'cancel', {}, NOW),
    ).rejects.toMatchObject({ status: 400, message: 'Un pedido entregado no se puede cancelar.' })
    expect(db._tables.orders[0].status).toBe('delivered')
  })

  it('marcar enviado sin guía es un 400', async () => {
    const db = seedDb()
    await expect(
      updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_shipped', { carrier: 'X' }, NOW),
    ).rejects.toMatchObject({ status: 400, message: 'Escribe el número de guía.' })
  })

  it('un pedido de otra cuenta es un 404 y no se toca', async () => {
    const db = seedDb()
    await expect(
      updateOrderStatus(asClient(db), ctxFor(db), OTHER_ORDER_ID, 'mark_paid', {}, NOW),
    ).rejects.toMatchObject({ status: 404 })
    expect(db._tables.orders[1].payment_status).toBe('pending')
    expect(db._tables.deals[1].stage_id).toBe('stage-x')
  })

  it('un id que no es uuid es un 404 sin consultar la base', async () => {
    const db = seedDb()
    const spy = vi.spyOn(db as unknown as { from: (t: string) => unknown }, 'from')
    await expect(
      updateOrderStatus(asClient(db), ctxFor(db), 'no-es-uuid', 'mark_paid', {}, NOW),
    ).rejects.toMatchObject({ status: 404 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('un pedido inexistente es un 404', async () => {
    const db = seedDb()
    await expect(
      updateOrderStatus(
        asClient(db),
        ctxFor(db),
        '55555555-5555-4555-8555-555555555555',
        'mark_paid',
        {},
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('el cambio se guarda aunque el negocio falle', async () => {
    const db = seedDb()
    db._failNext('update', 'deals', { message: 'deals roto' })

    const result = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW)

    expect(result.changed).toBe(true)
    expect(db._tables.orders[0].payment_status).toBe('paid')
    expect(console.error).toHaveBeenCalled()
  })

  it('el pedido sin negocio (deal_id nulo) se actualiza igual', async () => {
    const db = seedDb(orderRow({ deal_id: null }))
    const result = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW)

    expect(result.changed).toBe(true)
    expect(db._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
  })

  it('si el dueño borró la etapa, el pedido igual se actualiza y el negocio no se mueve', async () => {
    const db = seedDb()
    db._tables.pipeline_stages = db._tables.pipeline_stages.filter((s) => s.name !== 'Pagado')

    const result = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW)

    expect(result.changed).toBe(true)
    expect(db._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
    expect(console.warn).toHaveBeenCalled()
  })

  it('un error al leer el pedido se lanza (500)', async () => {
    const db = seedDb()
    db._failNext('select', 'orders', { message: 'lectura rota' })
    const error = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW).catch((e) => e)
    expect(error).not.toBeInstanceOf(SalesError)
    expect(error.message).toBe('lectura rota')
  })

  it('un error al guardar el pedido se lanza y no mueve el negocio', async () => {
    const db = seedDb()
    db._failNext('update', 'orders', { message: 'escritura rota' })
    const error = await updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW).catch((e) => e)
    expect(error.message).toBe('escritura rota')
    expect(db._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
  })

  it('si el pedido cambió entre la lectura y la escritura, responde 409 y no duplica el aviso', async () => {
    const db = seedDb()
    // Otra pestaña ya lo marcó pagado entre la lectura y la escritura.
    const realFrom = db.from.bind(db)
    let flipped = false
    db.from = (table: string) => {
      const api = realFrom(table) as { update?: (p: Row) => unknown }
      if (table === 'orders' && api.update) {
        const update = api.update.bind(api)
        api.update = (p: Row) => {
          if (!flipped) {
            flipped = true
            db._tables.orders[0].payment_status = 'paid'
          }
          return update(p)
        }
      }
      return api
    }

    await expect(
      updateOrderStatus(asClient(db), ctxFor(db), ORDER_ID, 'mark_paid', {}, NOW),
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe('ajustes de avisos', () => {
  it('sin fila, los tres avisos están prendidos', async () => {
    const db = makeFakeDb({})
    expect(await getSalesSettings(asClient(db), ACCOUNT)).toEqual({
      notify_paid: true,
      notify_shipped: true,
      notify_delivered: true,
    })
  })

  it('lee la fila de la cuenta', async () => {
    const db = makeFakeDb({
      sales_settings: [
        { account_id: OTHER_ACCOUNT, notify_paid: true, notify_shipped: true, notify_delivered: true },
        { account_id: ACCOUNT, notify_paid: false, notify_shipped: true, notify_delivered: false },
      ],
    })
    expect(await getSalesSettings(asClient(db), ACCOUNT)).toEqual({
      notify_paid: false,
      notify_shipped: true,
      notify_delivered: false,
    })
  })

  it('un error de lectura se lanza (no se confunde con "sin fila")', async () => {
    const db = makeFakeDb({})
    db._failNext('select', 'sales_settings', { message: 'lectura rota' })
    await expect(getSalesSettings(asClient(db), ACCOUNT)).rejects.toMatchObject({ message: 'lectura rota' })
  })

  it('guardar crea la fila con lo enviado y deja el resto en su valor por defecto', async () => {
    const db = makeFakeDb({})
    const saved = await saveSalesSettings(asClient(db), ACCOUNT, { notify_shipped: false })

    expect(saved).toEqual({ notify_paid: true, notify_shipped: false, notify_delivered: true })
    expect(db._tables.sales_settings).toHaveLength(1)
    expect(db._tables.sales_settings[0]).toMatchObject({ account_id: ACCOUNT, notify_shipped: false })
  })

  it('guardar es parcial: no pisa lo que no se envía', async () => {
    const db = makeFakeDb({
      sales_settings: [
        { account_id: ACCOUNT, notify_paid: false, notify_shipped: true, notify_delivered: true },
      ],
    })
    const saved = await saveSalesSettings(asClient(db), ACCOUNT, { notify_delivered: false })

    expect(saved).toEqual({ notify_paid: false, notify_shipped: true, notify_delivered: false })
    expect(db._tables.sales_settings).toHaveLength(1)
  })

  it('un error al guardar se lanza', async () => {
    const db = makeFakeDb({})
    db._failNext('upsert', 'sales_settings', { message: 'escritura rota' })
    await expect(saveSalesSettings(asClient(db), ACCOUNT, { notify_paid: false })).rejects.toMatchObject({
      message: 'escritura rota',
    })
  })
})
