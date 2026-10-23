import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
import { stubCreateOrder } from './testing/create-order-stub'

// ============================================================
// Repositorio de Ventas contra el fake de PostgREST. `create_order`
// es una función SQL: el fake no la ejecuta, así que cada test
// registra con `_onRpc` el comportamiento mínimo (insertar el pedido
// y sus líneas, o responder con un error de Postgres).
//
// El repositorio usa dos clientes: el del usuario (`ctx.supabase`:
// RPC y lectura/escritura de `orders`, con RLS y el guarda de 054) y
// el service-role (`db`: pipeline, negocio y líneas). Los tests de
// estado los separan en dos fakes para comprobar quién hace qué.
// ============================================================

/** Texto exacto del RAISE EXCEPTION de create_order() cuando Ventas no está activo. */
function moduleMessageInMigration054(): string {
  const sql = readFileSync(
    join(fileURLToPath(new URL('../../../supabase/migrations', import.meta.url)), '054_ventas.sql'),
    'utf8',
  )
  const match = sql.match(/RAISE EXCEPTION\s+'(El módulo Ventas no está activo[^']*)'/)
  if (!match) throw new Error('054_ventas.sql ya no tiene el mensaje de módulo apagado')
  return match[1]
}

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
  it('crea el pipeline Ventas con las cinco etapas en orden (sin "Nuevo")', async () => {
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
    expect(stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4])
    expect(stages.map((s) => s.name)).not.toContain('Nuevo')
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
    expect(db._tables.pipeline_stages).toHaveLength(5)
  })

  it('reconoce el nombre sin importar mayúsculas ni espacios', async () => {
    const db = makeFakeDb({
      ...pipelineSeed(),
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, user_id: USER, name: '  VENTAS ' }],
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(result.pipelineId).toBe('pipe-1')
    expect(db._tables.pipelines).toHaveLength(1)
    expect(db._tables.pipeline_stages).toHaveLength(5)
  })

  it('con dos pipelines "Ventas" elige siempre el más antiguo (created_at, id)', async () => {
    const db = makeFakeDb({
      pipelines: [
        { id: 'p-b', account_id: ACCOUNT, user_id: USER, name: 'Ventas', created_at: '2026-02-01T00:00:00Z' },
        { id: 'p-a', account_id: ACCOUNT, user_id: USER, name: 'ventas', created_at: '2026-01-01T00:00:00Z' },
      ],
      pipeline_stages: SALES_STAGES.map((name, position) => ({
        id: `a-${position}`,
        pipeline_id: 'p-a',
        name,
        position,
      })),
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(result.pipelineId).toBe('p-a')
    expect(db._tables.pipelines).toHaveLength(2)
  })

  it('con empate en created_at desempata por id', async () => {
    const db = makeFakeDb({
      pipelines: [
        { id: 'p-2', account_id: ACCOUNT, user_id: USER, name: 'Ventas', created_at: '2026-01-01T00:00:00Z' },
        { id: 'p-1', account_id: ACCOUNT, user_id: USER, name: 'Ventas', created_at: '2026-01-01T00:00:00Z' },
      ],
    })
    expect((await ensureSalesPipeline(asClient(db), ACCOUNT, USER)).pipelineId).toBe('p-1')
  })

  it('con etapas repetidas elige la de menor posición (luego created_at, id)', async () => {
    const db = makeFakeDb({
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, user_id: USER, name: 'Ventas' }],
      pipeline_stages: [
        { id: 'late', pipeline_id: 'pipe-1', name: 'Pagado', position: 5 },
        { id: 'early', pipeline_id: 'pipe-1', name: 'pagado', position: 2 },
      ],
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)
    expect(result.stageIdByName.Pagado).toBe('early')
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
    // Faltaban 4: se agregan al final, con posiciones nuevas.
    expect(stages).toHaveLength(6)
    const added = stages.filter((s) => !['s-a', 's-b'].includes(String(s.id)))
    expect(added.map((s) => s.name)).toEqual(['Pago pendiente', 'Enviado', 'Entregado', 'Cancelado'])
    const positions = stages.map((s) => s.position as number)
    expect(new Set(positions).size).toBe(positions.length)
    expect(Math.min(...added.map((s) => s.position as number))).toBeGreaterThan(1)
  })

  it('un pipeline que ya tiene "Nuevo" (versión anterior) lo conserva sin usarlo', async () => {
    const db = makeFakeDb({
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, user_id: USER, name: 'Ventas' }],
      pipeline_stages: ['Nuevo', ...SALES_STAGES].map((name, position) => ({
        id: `old-${position}`,
        pipeline_id: 'pipe-1',
        name,
        position,
      })),
    })
    const result = await ensureSalesPipeline(asClient(db), ACCOUNT, USER)

    expect(db._tables.pipeline_stages).toHaveLength(6)
    expect(db._tables.pipeline_stages.find((s) => s.name === 'Nuevo')?.id).toBe('old-0')
    expect(Object.keys(result.stageIdByName)).not.toContain('Nuevo')
    expect(result.stageIdByName['Pago pendiente']).toBe('old-1')
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

    expect(order).toMatchObject({ number: 1001, total: 140000.5, currency: 'COP' })
    expect(order.id).toBe(db._tables.orders[0].id)
    expect(order.items.map((i) => [i.name, i.quantity, i.unit_price, i.position])).toEqual([
      ['Anillo', 2, 50000, 0],
      ['Cadena', 1, 30000.5, 1],
    ])
  })

  it('cada pedido recibe un id distinto', async () => {
    const a = await createOrder(asClient(db), ctxFor(db), input())
    const b = await createOrder(asClient(db), ctxFor(db), input())
    expect(a.id).not.toBe(b.id)
    expect(b.number).toBe(1002)
    expect(b.items.every((i) => i.order_id === b.id)).toBe(true)
    expect(b.items).toHaveLength(2)
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

  it('crea el pipeline y el negocio abierto en la etapa "Pago pendiente" y guarda deal_id', async () => {
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

  it('un pedido ya pagado entra en la etapa "Pagado" (el negocio sigue abierto)', async () => {
    await createOrder(asClient(db), ctxFor(db), input({ paid: true }))

    const pagado = db._tables.pipeline_stages.find((s) => s.name === 'Pagado')
    expect(db._tables.deals[0]).toMatchObject({ stage_id: pagado?.id, status: 'open' })
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

  it('si no se puede enlazar deal_id, borra el negocio recién creado y el pedido se devuelve', async () => {
    db._failNext('update', 'orders', { message: 'update roto' })

    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order.number).toBe(1001)
    expect(order.deal_id).toBeNull()
    // Sin negocio huérfano en el tablero.
    expect(db._tables.deals).toHaveLength(0)
    expect(db._tables.orders).toHaveLength(1)
    expect(console.error).toHaveBeenCalled()
  })

  it('el borrado del negocio huérfano solo toca la cuenta del pedido', async () => {
    db = makeFakeDb({
      deals: [{ id: 'otro', account_id: OTHER_ACCOUNT, title: 'Ajeno' }],
    })
    stubCreateOrder(db)
    db._failNext('update', 'orders', { message: 'update roto' })

    await createOrder(asClient(db), ctxFor(db), input())

    expect(db._tables.deals.map((d) => d.id)).toEqual(['otro'])
  })

  it('si tampoco se puede borrar el huérfano, el pedido igual se devuelve', async () => {
    db._failNext('update', 'orders', { message: 'update roto' })
    db._failNext('delete', 'deals', { message: 'delete roto' })

    const order = await createOrder(asClient(db), ctxFor(db), input())

    expect(order.number).toBe(1001)
    expect(order.deal_id).toBeNull()
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
    // El texto que lanza la base: se lee de la migración 054 (no de
    // moduleNotActiveMessage) para que el test falle si SQL y TypeScript
    // dejan de decir lo mismo.
    const moduleMessage = moduleMessageInMigration054()
    const cases: [string, string, number, string, string][] = [
      // code de Postgres, mensaje crudo, status, code de dominio, mensaje en español
      ['42501', 'raw postgres text', 403, 'forbidden', 'No tienes permiso para crear pedidos en esta cuenta.'],
      ['P0001', moduleMessage, 409, 'module_inactive', moduleMessage],
      ['23503', 'raw postgres text', 404, 'not_found', 'El contacto o la conversación no existe en tu cuenta.'],
      ['23514', 'raw postgres text', 400, 'invalid', invalid],
      ['22023', 'raw postgres text', 400, 'invalid', invalid],
    ]
    for (const [pg, raw, status, code, message] of cases) {
      it(`${pg} → ${status} (${code}) con mensaje en español`, async () => {
        db._failNext('rpc', 'create_order', { code: pg, message: raw })

        const error = await createOrder(asClient(db), ctxFor(db), input()).catch((e) => e)

        expect(error).toBeInstanceOf(SalesError)
        expect(error.status).toBe(status)
        expect(error.code).toBe(code)
        expect(error.message).toBe(message)
        expect(db._tables.deals ?? []).toHaveLength(0)
      })
    }

    it('P0001 con otro mensaje (un RAISE genérico) no se hace pasar por módulo apagado', async () => {
      db._failNext('rpc', 'create_order', { code: 'P0001', message: 'algo distinto' })
      const error = await createOrder(asClient(db), ctxFor(db), input()).catch((e) => e)

      expect(error).not.toBeInstanceOf(SalesError)
      expect(error.message).toBe('algo distinto')
    })

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

  /**
   * Dos fakes, como en producción: el del usuario ve `orders` (RLS) y el
   * service-role ve el pipeline, los negocios y las líneas.
   */
  function seed(order: Row = orderRow()): { user: FakeDb; admin: FakeDb } {
    const user = makeFakeDb({
      orders: [order, orderRow({ id: OTHER_ORDER_ID, account_id: OTHER_ACCOUNT, deal_id: 'deal-x' })],
    })
    const admin = makeFakeDb({
      ...pipelineSeed(),
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
          status: 'open',
          title: 'Pedido #1001',
        },
        {
          id: 'deal-x',
          account_id: OTHER_ACCOUNT,
          pipeline_id: 'pipe-x',
          stage_id: 'stage-x',
          status: 'open',
          title: 'Pedido #1001',
        },
      ],
    })
    return { user, admin }
  }

  const run = (
    fakes: { user: FakeDb; admin: FakeDb },
    action: string,
    extra: Record<string, unknown> = {},
    id = ORDER_ID,
  ) => updateOrderStatus(asClient(fakes.admin), ctxFor(fakes.user), id, action, extra, NOW)

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('marca pagado con el cliente del usuario, mueve el negocio y devuelve el aviso', async () => {
    const fakes = seed()
    const result = await run(fakes, 'mark_paid')

    expect(result.changed).toBe(true)
    expect(result.notice).toBe('paid')
    expect(result.order).toMatchObject({ payment_status: 'paid', paid_at: NOW.toISOString() })
    expect(result.order.items.map((i) => i.name)).toEqual(['A', 'B'])
    // El UPDATE del pedido ocurrió en el fake del usuario (RLS + guarda de 054)…
    expect(fakes.user._tables.orders[0]).toMatchObject({ payment_status: 'paid', paid_at: NOW.toISOString() })
    // …y el service-role ni siquiera tiene la tabla de pedidos.
    expect(fakes.admin._tables.orders).toBeUndefined()
    expect(fakes.admin._tables.deals[0]).toMatchObject({ stage_id: stageId('Pagado'), status: 'open' })
  })

  it('el UPDATE lleva los filtros de cuenta y de estado leído', async () => {
    const fakes = seed()
    // Otra cuenta con el mismo id de pedido: no debe tocarse jamás.
    fakes.user._tables.orders.push(orderRow({ account_id: OTHER_ACCOUNT, deal_id: null }))

    await run(fakes, 'mark_paid')

    expect(fakes.user._tables.orders[0].payment_status).toBe('paid')
    expect(fakes.user._tables.orders[2].payment_status).toBe('pending')
  })

  it('marcar pagado un pedido ya pagado no escribe nada ni avisa', async () => {
    const fakes = seed(orderRow({ payment_status: 'paid', paid_at: '2026-10-01T00:00:00.000Z' }))
    const adminFrom = vi.spyOn(fakes.admin as unknown as { from: (t: string) => unknown }, 'from')

    const result = await run(fakes, 'mark_paid')

    expect(result).toMatchObject({ changed: false, notice: null })
    expect(result.order.paid_at).toBe('2026-10-01T00:00:00.000Z')
    expect(result.order.items).toHaveLength(2)
    expect(fakes.user._tables.orders[0].paid_at).toBe('2026-10-01T00:00:00.000Z')
    expect(adminFrom.mock.calls.filter(([t]) => t === 'deals')).toHaveLength(0)
    expect(fakes.admin._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
  })

  it('marca enviado con transportadora y guía y mueve el negocio a "Enviado"', async () => {
    const fakes = seed()
    const result = await run(fakes, 'mark_shipped', {
      carrier: 'Servientrega',
      tracking_number: 'ABC123',
    })

    expect(result.notice).toBe('shipped')
    expect(fakes.user._tables.orders[0]).toMatchObject({
      status: 'shipped',
      shipped_at: NOW.toISOString(),
      carrier: 'Servientrega',
      tracking_number: 'ABC123',
    })
    expect(fakes.admin._tables.deals[0]).toMatchObject({ stage_id: stageId('Enviado'), status: 'open' })
  })

  it('entregado: el negocio pasa a "Entregado" y a ganado (won)', async () => {
    const fakes = seed(orderRow({ status: 'shipped' }))
    await run(fakes, 'mark_delivered')

    expect(fakes.admin._tables.deals[0]).toMatchObject({
      stage_id: stageId('Entregado'),
      status: 'won',
      updated_at: NOW.toISOString(),
    })
  })

  it('cancelado: el negocio pasa a "Cancelado" y a perdido (lost), sin aviso', async () => {
    const fakes = seed()
    const result = await run(fakes, 'cancel')

    expect(result).toMatchObject({ changed: true, notice: null })
    expect(fakes.admin._tables.deals[0]).toMatchObject({ stage_id: stageId('Cancelado'), status: 'lost' })
  })

  it('si el dueño borró la etapa, el estado del negocio se actualiza igual y se avisa en el log', async () => {
    const fakes = seed(orderRow({ status: 'shipped' }))
    fakes.admin._tables.pipeline_stages = fakes.admin._tables.pipeline_stages.filter(
      (s) => s.name !== 'Entregado',
    )

    const result = await run(fakes, 'mark_delivered')

    expect(result.changed).toBe(true)
    expect(fakes.admin._tables.deals[0]).toMatchObject({
      stage_id: stageId('Pago pendiente'), // no se movió
      status: 'won',
    })
    expect(console.warn).toHaveBeenCalled()
  })

  it('si la etapa ya era la correcta pero el estado cambió, solo cambia el estado', async () => {
    const fakes = seed(orderRow({ status: 'shipped' }))
    // El negocio ya está en "Entregado" (movido a mano) pero sigue abierto.
    fakes.admin._tables.deals[0].stage_id = stageId('Entregado')

    await run(fakes, 'mark_delivered')

    expect(fakes.admin._tables.deals[0]).toMatchObject({ stage_id: stageId('Entregado'), status: 'won' })
  })

  it('si el negocio ya está en la etapa y el estado correctos no lo escribe', async () => {
    const fakes = seed()
    fakes.admin._tables.deals[0].stage_id = stageId('Pagado')
    const before = JSON.stringify(fakes.admin._tables.deals[0])

    await run(fakes, 'mark_paid')

    expect(JSON.stringify(fakes.admin._tables.deals[0])).toBe(before)
  })

  it('mueve el negocio según el pedido releído, no según el parche (evita movimientos fuera de orden)', async () => {
    const fakes = seed()
    // Entre nuestro UPDATE y el movimiento del negocio, otra petición ya lo entregó.
    const realFrom = fakes.user.from.bind(fakes.user)
    fakes.user.from = (table: string) => {
      const api = realFrom(table) as { update?: (p: Row) => unknown }
      if (table === 'orders' && api.update) {
        const update = api.update.bind(api)
        api.update = (p: Row) => {
          const out = update(p)
          // Se aplica nuestro parche y, a continuación, la otra petición gana.
          queueMicrotask(() => {
            Object.assign(fakes.user._tables.orders[0], {
              status: 'delivered',
              payment_status: 'paid',
            })
          })
          return out
        }
      }
      return api
    }

    await run(fakes, 'mark_paid')

    expect(fakes.admin._tables.deals[0]).toMatchObject({
      stage_id: stageId('Entregado'),
      status: 'won',
    })
  })

  describe('errores de dominio', () => {
    it('una transición que el estado no permite es 409 invalid_transition', async () => {
      const fakes = seed(orderRow({ status: 'delivered' }))
      await expect(run(fakes, 'cancel')).rejects.toMatchObject({
        status: 409,
        code: 'invalid_transition',
        message: 'Un pedido entregado no se puede cancelar.',
      })
      expect(fakes.user._tables.orders[0].status).toBe('delivered')
    })

    it('un pedido cancelado no se marca como pagado: 409 invalid_transition', async () => {
      const fakes = seed(orderRow({ status: 'cancelled' }))
      await expect(run(fakes, 'mark_paid')).rejects.toMatchObject({
        status: 409,
        code: 'invalid_transition',
      })
    })

    it('marcar enviado sin guía es 400 invalid', async () => {
      const fakes = seed()
      await expect(run(fakes, 'mark_shipped', { carrier: 'X' })).rejects.toMatchObject({
        status: 400,
        code: 'invalid',
        message: 'Escribe el número de guía.',
      })
    })

    it('una acción desconocida es 400 invalid', async () => {
      const fakes = seed()
      await expect(run(fakes, 'volar')).rejects.toMatchObject({ status: 400, code: 'invalid' })
    })

    it('si la acción se rechaza no se leen las líneas', async () => {
      for (const [order, action, extra] of [
        [orderRow({ status: 'delivered' }), 'cancel', {}],
        [orderRow(), 'mark_shipped', {}],
      ] as const) {
        const fakes = seed(order)
        const adminFrom = vi.spyOn(fakes.admin as unknown as { from: (t: string) => unknown }, 'from')
        await run(fakes, action, extra).catch(() => {})
        expect(adminFrom.mock.calls.filter(([t]) => t === 'order_items')).toHaveLength(0)
      }
    })

    it('un pedido de otra cuenta es 404 not_found y no se toca', async () => {
      const fakes = seed()
      await expect(run(fakes, 'mark_paid', {}, OTHER_ORDER_ID)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      })
      expect(fakes.user._tables.orders[1].payment_status).toBe('pending')
      expect(fakes.admin._tables.deals[1].stage_id).toBe('stage-x')
    })

    it('un id que no es uuid es 404 sin consultar ninguna base', async () => {
      const fakes = seed()
      const userFrom = vi.spyOn(fakes.user as unknown as { from: (t: string) => unknown }, 'from')
      const adminFrom = vi.spyOn(fakes.admin as unknown as { from: (t: string) => unknown }, 'from')
      await expect(run(fakes, 'mark_paid', {}, 'no-es-uuid')).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      })
      expect(userFrom).not.toHaveBeenCalled()
      expect(adminFrom).not.toHaveBeenCalled()
    })

    it('un pedido inexistente es 404', async () => {
      const fakes = seed()
      await expect(
        run(fakes, 'mark_paid', {}, '55555555-5555-4555-8555-555555555555'),
      ).rejects.toMatchObject({ status: 404 })
    })
  })

  describe('errores de la base', () => {
    it('el cambio se guarda aunque el negocio falle', async () => {
      const fakes = seed()
      fakes.admin._failNext('update', 'deals', { message: 'deals roto' })

      const result = await run(fakes, 'mark_paid')

      expect(result.changed).toBe(true)
      expect(fakes.user._tables.orders[0].payment_status).toBe('paid')
      expect(console.error).toHaveBeenCalled()
    })

    it('el pedido sin negocio (deal_id nulo) se actualiza igual', async () => {
      const fakes = seed(orderRow({ deal_id: null }))
      const result = await run(fakes, 'mark_paid')

      expect(result.changed).toBe(true)
      expect(fakes.admin._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
    })

    it('un error al leer el pedido se lanza (500)', async () => {
      const fakes = seed()
      fakes.user._failNext('select', 'orders', { message: 'lectura rota' })
      const error = await run(fakes, 'mark_paid').catch((e) => e)
      expect(error).not.toBeInstanceOf(SalesError)
      expect(error.message).toBe('lectura rota')
    })

    it('un error genérico al guardar se lanza y no mueve el negocio', async () => {
      const fakes = seed()
      fakes.user._failNext('update', 'orders', { message: 'escritura rota' })
      const error = await run(fakes, 'mark_paid').catch((e) => e)
      expect(error).not.toBeInstanceOf(SalesError)
      expect(error.message).toBe('escritura rota')
      expect(fakes.admin._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
    })

    it('42501 (guarda de 054 o RLS) es 409 stale y se registra', async () => {
      const fakes = seed()
      fakes.user._failNext('update', 'orders', {
        code: '42501',
        message: 'order status cannot move from shipped to new',
      })

      const error = await run(fakes, 'mark_paid').catch((e) => e)

      expect(error).toBeInstanceOf(SalesError)
      expect(error).toMatchObject({ status: 409, code: 'stale' })
      expect(console.error).toHaveBeenCalled()
      expect(fakes.admin._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
    })

    it('si el pedido cambió entre la lectura y la escritura (0 filas) es 409 stale', async () => {
      const fakes = seed()
      const realFrom = fakes.user.from.bind(fakes.user)
      let flipped = false
      fakes.user.from = (table: string) => {
        const api = realFrom(table) as { update?: (p: Row) => unknown }
        if (table === 'orders' && api.update) {
          const update = api.update.bind(api)
          api.update = (p: Row) => {
            if (!flipped) {
              flipped = true
              fakes.user._tables.orders[0].payment_status = 'paid'
            }
            return update(p)
          }
        }
        return api
      }

      await expect(run(fakes, 'mark_paid')).rejects.toMatchObject({ status: 409, code: 'stale' })
      expect(fakes.admin._tables.deals[0].stage_id).toBe(stageId('Pago pendiente'))
    })
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
