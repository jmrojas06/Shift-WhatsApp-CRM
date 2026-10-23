import { describe, expect, it } from 'vitest'

import {
  ORDER_FILTERS,
  availableOrderActions,
  filterOrders,
  formatAmounts,
  matchesOrderFilter,
  matchesOrderSearch,
  missingShippingPlace,
  noticeResult,
  orderNoticeLine,
  salesErrorMessage,
  salesMonthStart,
  salesSummary,
  type PanelOrder,
} from './panel'
import { VENTAS_TEXTS as T } from './texts'

const base: PanelOrder = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 1001,
  customer_name: 'Mariana Ospina',
  customer_phone: '+57 310 555 0142',
  total: 150000,
  currency: 'COP',
  payment_status: 'pending',
  status: 'new',
  city: 'Medellín',
  address: 'Cra 43A # 5-20',
  carrier: null,
  tracking_number: null,
  last_notice: null,
  last_notice_error: null,
  paid_at: null,
  created_at: '2026-10-10T15:00:00.000Z',
}

const order = (patch: Partial<PanelOrder>): PanelOrder => ({ ...base, ...patch })

describe('salesMonthStart: primer instante del mes en hora de Colombia', () => {
  it('mitad de mes', () => {
    expect(salesMonthStart(new Date('2026-10-22T12:00:00Z')).toISOString()).toBe(
      '2026-10-01T05:00:00.000Z',
    )
  })

  it('la noche del 31 en Colombia ya es el 1 en UTC, pero sigue siendo el mes anterior', () => {
    // 2026-11-01 02:00 UTC = 2026-10-31 21:00 en Bogotá.
    expect(salesMonthStart(new Date('2026-11-01T02:00:00Z')).toISOString()).toBe(
      '2026-10-01T05:00:00.000Z',
    )
  })

  it('enero', () => {
    expect(salesMonthStart(new Date('2027-01-01T05:00:00Z')).toISOString()).toBe(
      '2027-01-01T05:00:00.000Z',
    )
  })
})

describe('salesSummary', () => {
  const now = new Date('2026-10-22T12:00:00Z')

  it('vendido este mes suma los pagados por fecha de pago, sin cancelados', () => {
    const summary = salesSummary(
      [
        order({ id: 'a', payment_status: 'paid', paid_at: '2026-10-05T14:00:00Z', total: 100000 }),
        order({ id: 'b', payment_status: 'paid', paid_at: '2026-10-21T14:00:00Z', total: 50000.5 }),
        // Pagado el mes pasado: no cuenta aunque se haya creado antes.
        order({ id: 'c', payment_status: 'paid', paid_at: '2026-09-30T14:00:00Z', total: 999 }),
        // 31 de octubre a las 21:00 en Bogotá (1 de nov en UTC): cuenta en octubre.
        order({ id: 'd', payment_status: 'paid', paid_at: '2026-11-01T02:00:00Z', total: 1 }),
        // Cancelado después de cobrar: la venta se cae.
        order({
          id: 'e',
          payment_status: 'paid',
          status: 'cancelled',
          paid_at: '2026-10-06T14:00:00Z',
          total: 70000,
        }),
      ],
      new Date('2026-10-31T23:00:00Z'),
    )
    // 100.000 + 50.000,50 + 1 = 150.001,50
    expect(summary.soldThisMonth).toEqual([{ currency: 'COP', cents: 15_000_150 }])
  })

  it('pedidos del mes: creados este mes en Colombia, sin cancelados', () => {
    const summary = salesSummary(
      [
        order({ id: 'a', created_at: '2026-10-01T05:00:00Z' }),
        order({ id: 'b', created_at: '2026-10-01T04:59:59Z' }), // 30 sep en Bogotá
        order({ id: 'c', created_at: '2026-10-12T12:00:00Z', status: 'cancelled' }),
        order({ id: 'd', created_at: '2026-10-12T12:00:00Z', status: 'delivered' }),
      ],
      now,
    )
    expect(summary.ordersThisMonth).toBe(2)
  })

  it('pendiente por cobrar: sin pagar y no cancelado, de cualquier mes', () => {
    const summary = salesSummary(
      [
        order({ id: 'a', total: 20000, created_at: '2026-08-01T12:00:00Z' }),
        order({ id: 'b', total: 30000, status: 'shipped' }),
        order({ id: 'c', total: 40000, status: 'cancelled' }),
        order({ id: 'd', total: 50000, payment_status: 'paid', paid_at: '2026-10-02T12:00:00Z' }),
      ],
      now,
    )
    expect(summary.pendingToCollect).toEqual([{ currency: 'COP', cents: 5_000_000 }])
  })

  it('separa las monedas en vez de sumarlas', () => {
    const summary = salesSummary(
      [
        order({ id: 'a', total: 10, currency: 'USD' }),
        order({ id: 'b', total: 20000, currency: 'COP' }),
      ],
      now,
      'COP',
    )
    expect(summary.pendingToCollect).toEqual([
      { currency: 'COP', cents: 2_000_000 },
      { currency: 'USD', cents: 1000 },
    ])
  })

  it('los importes pueden llegar como texto (numeric de Postgres)', () => {
    const summary = salesSummary(
      [order({ id: 'a', total: '12000.50' as unknown as number })],
      now,
    )
    expect(summary.pendingToCollect).toEqual([{ currency: 'COP', cents: 1_200_050 }])
  })

  it('sin pedidos todo queda en cero', () => {
    expect(salesSummary([], now)).toEqual({
      soldThisMonth: [],
      ordersThisMonth: 0,
      pendingToCollect: [],
    })
  })
})

describe('formatAmounts', () => {
  it('vacío muestra cero en la moneda de la cuenta', () => {
    expect(formatAmounts([], 'COP')).toBe('$0')
  })

  it('una o varias monedas', () => {
    expect(formatAmounts([{ currency: 'COP', cents: 15_000_050 }], 'COP')).toBe('$150.000,50')
    expect(
      formatAmounts(
        [
          { currency: 'COP', cents: 2_000_000 },
          { currency: 'USD', cents: 1000 },
        ],
        'COP',
      ),
    ).toBe('$20.000 + US$10')
  })
})

describe('filtros', () => {
  it('son los del diseño y coinciden con los textos', () => {
    expect([...ORDER_FILTERS]).toEqual(Object.keys(T.filters))
  })

  const pending = order({ id: 'p' })
  const paidNew = order({ id: 'pn', payment_status: 'paid', paid_at: '2026-10-10T12:00:00Z' })
  const shippedUnpaid = order({ id: 'su', status: 'shipped' })
  const shippedPaid = order({ id: 'sp', status: 'shipped', payment_status: 'paid' })
  const delivered = order({ id: 'd', status: 'delivered', payment_status: 'paid' })
  const cancelled = order({ id: 'c', status: 'cancelled' })
  const all = [pending, paidNew, shippedUnpaid, shippedPaid, delivered, cancelled]
  const ids = (filter: (typeof ORDER_FILTERS)[number]) =>
    all.filter((o) => matchesOrderFilter(o, filter)).map((o) => o.id)

  it('todos', () => expect(ids('all')).toEqual(['p', 'pn', 'su', 'sp', 'd', 'c']))
  it('pendientes de pago: sin pagar y activos (incluye contraentrega en camino)', () =>
    expect(ids('pendingPayment')).toEqual(['p', 'su']))
  it('pagados por enviar', () => expect(ids('toShip')).toEqual(['pn']))
  it('enviados', () => expect(ids('shipped')).toEqual(['su', 'sp']))
  it('entregados', () => expect(ids('delivered')).toEqual(['d']))
  it('cancelados', () => expect(ids('cancelled')).toEqual(['c']))
})

describe('búsqueda', () => {
  const o = order({ number: 1042, customer_name: 'José Ángel Muñoz', customer_phone: '+57 300 123 4567' })

  it('vacía encuentra todo', () => {
    expect(matchesOrderSearch(o, '')).toBe(true)
    expect(matchesOrderSearch(o, '   ')).toBe(true)
  })

  it('por número, con o sin #', () => {
    expect(matchesOrderSearch(o, '1042')).toBe(true)
    expect(matchesOrderSearch(o, '#1042')).toBe(true)
    expect(matchesOrderSearch(o, '#104')).toBe(true)
    expect(matchesOrderSearch(o, '1043')).toBe(false)
  })

  it('por nombre, sin importar tildes ni mayúsculas', () => {
    expect(matchesOrderSearch(o, 'jose angel')).toBe(true)
    expect(matchesOrderSearch(o, 'MUÑOZ')).toBe(true)
    expect(matchesOrderSearch(o, 'munoz')).toBe(true)
    expect(matchesOrderSearch(o, 'pedro')).toBe(false)
  })

  it('por teléfono, con o sin espacios ni prefijo', () => {
    expect(matchesOrderSearch(o, '300 123')).toBe(true)
    expect(matchesOrderSearch(o, '3001234567')).toBe(true)
    expect(matchesOrderSearch(o, '+573001234567')).toBe(true)
    expect(matchesOrderSearch(o, '999 888')).toBe(false)
  })
})

describe('filterOrders', () => {
  it('filtra, busca y deja el más reciente primero', () => {
    const rows = [
      order({ id: 'old', number: 1001, created_at: '2026-10-01T12:00:00Z' }),
      order({ id: 'new', number: 1003, created_at: '2026-10-20T12:00:00Z' }),
      order({ id: 'mid', number: 1002, created_at: '2026-10-10T12:00:00Z', status: 'cancelled' }),
    ]
    expect(filterOrders(rows, 'all', '').map((o) => o.id)).toEqual(['new', 'mid', 'old'])
    expect(filterOrders(rows, 'pendingPayment', '').map((o) => o.id)).toEqual(['new', 'old'])
    expect(filterOrders(rows, 'all', '1001').map((o) => o.id)).toEqual(['old'])
  })

  it('no muta la lista original', () => {
    const rows = [
      order({ id: 'a', created_at: '2026-10-01T12:00:00Z' }),
      order({ id: 'b', created_at: '2026-10-02T12:00:00Z' }),
    ]
    filterOrders(rows, 'all', '')
    expect(rows.map((o) => o.id)).toEqual(['a', 'b'])
  })
})

describe('availableOrderActions: las mismas reglas que applyOrderAction', () => {
  it('nuevo sin pagar: todo', () => {
    expect(availableOrderActions(order({}))).toEqual([
      'mark_paid',
      'mark_shipped',
      'mark_delivered',
      'cancel',
    ])
  })

  it('nuevo pagado: sin "marcar pagado"', () => {
    expect(availableOrderActions(order({ payment_status: 'paid' }))).toEqual([
      'mark_shipped',
      'mark_delivered',
      'cancel',
    ])
  })

  it('nuevo sin ciudad ni dirección: igual se puede enviar (el diálogo las pide)', () => {
    expect(availableOrderActions(order({ city: null, address: null }))).toContain('mark_shipped')
  })

  it('enviado sin pagar', () => {
    expect(availableOrderActions(order({ status: 'shipped' }))).toEqual([
      'mark_paid',
      'mark_delivered',
      'cancel',
    ])
  })

  it('entregado sin pagar: solo cobrar', () => {
    expect(availableOrderActions(order({ status: 'delivered' }))).toEqual(['mark_paid'])
  })

  it('entregado y pagado, o cancelado: nada', () => {
    expect(availableOrderActions(order({ status: 'delivered', payment_status: 'paid' }))).toEqual([])
    expect(availableOrderActions(order({ status: 'cancelled' }))).toEqual([])
  })
})

describe('missingShippingPlace', () => {
  it('pide solo lo que falta', () => {
    expect(missingShippingPlace(order({}))).toEqual({ city: false, address: false })
    expect(missingShippingPlace(order({ city: '  ', address: null }))).toEqual({
      city: true,
      address: true,
    })
    expect(missingShippingPlace(order({ address: '' }))).toEqual({ city: false, address: true })
  })
})

describe('salesErrorMessage', () => {
  it('usa el mensaje del servidor cuando es de datos o de transición', () => {
    expect(salesErrorMessage({ status: 400, code: 'invalid', error: 'Escribe la ciudad de envío.' })).toBe(
      'Escribe la ciudad de envío.',
    )
    expect(
      salesErrorMessage({ status: 409, code: 'invalid_transition', error: 'El pedido ya fue entregado.' }),
    ).toBe('El pedido ya fue entregado.')
  })

  it('traduce los códigos conocidos a mensajes amables', () => {
    expect(salesErrorMessage({ status: 403, code: 'forbidden', error: 'x' })).toBe(T.errors.forbidden)
    expect(salesErrorMessage({ status: 409, code: 'module_inactive', error: 'x' })).toBe(T.errors.moduleOff)
    expect(salesErrorMessage({ status: 404, code: 'not_found', error: 'x' })).toBe(T.errors.notFound)
    expect(salesErrorMessage({ status: 409, code: 'stale', error: 'x' })).toBe(T.errors.stale)
    expect(salesErrorMessage({ status: 401, code: 'unauthorized', error: 'x' })).toBe(T.errors.session)
  })

  it('el módulo apagado también llega sin código (guarda genérica)', () => {
    expect(
      salesErrorMessage({ status: 409, error: 'El módulo Ventas no está activo para esta cuenta.' }),
    ).toBe(T.errors.moduleOff)
  })

  it('un 500 o un fallo de red muestra el genérico (nunca el detalle técnico)', () => {
    expect(salesErrorMessage({ status: 500, error: 'relation "orders" does not exist' })).toBe(
      T.errors.generic,
    )
    expect(salesErrorMessage({ status: 0 })).toBe(T.errors.network)
  })

  it('invalid sin mensaje usa el de respaldo', () => {
    expect(salesErrorMessage({ status: 400, code: 'invalid' })).toBe(T.errors.invalid)
  })
})

describe('noticeResult: lo que se le dice a la persona tras guardar', () => {
  it('enviado', () => {
    expect(noticeResult('sent', order({}))).toEqual({ tone: 'success', text: T.notice.sent })
  })

  it('falló, con el motivo guardado en el pedido', () => {
    expect(
      noticeResult('failed', order({ last_notice: 'paid', last_notice_error: 'Plantilla no aprobada en Meta' })),
    ).toEqual({ tone: 'warning', text: T.notice.failed('Plantilla no aprobada en Meta') })
  })

  it('falló sin motivo', () => {
    expect(noticeResult('failed', order({}))).toEqual({ tone: 'warning', text: T.notice.failed(null) })
  })

  it('omitido o sin aviso: nada', () => {
    expect(noticeResult('skipped', order({}))).toBeNull()
    expect(noticeResult(null, order({}))).toBeNull()
    expect(noticeResult(undefined, order({}))).toBeNull()
  })
})

describe('orderNoticeLine: estado del último aviso en el pedido', () => {
  it('sin aviso', () => {
    expect(orderNoticeLine(order({}))).toBeNull()
  })

  it('mandado', () => {
    expect(orderNoticeLine(order({ last_notice: 'shipped' }))).toEqual({
      failed: false,
      text: 'Aviso de envío mandado',
      reason: null,
    })
  })

  it('falló, con su motivo', () => {
    expect(
      orderNoticeLine(order({ last_notice: 'paid', last_notice_error: 'WhatsApp no está conectado en esta cuenta' })),
    ).toEqual({
      failed: true,
      text: 'Aviso de pago: no se pudo mandar',
      reason: 'WhatsApp no está conectado en esta cuenta',
    })
  })

  it('un valor raro en la base no rompe la pantalla', () => {
    expect(orderNoticeLine(order({ last_notice: 'otro' as never }))).toBeNull()
  })
})
