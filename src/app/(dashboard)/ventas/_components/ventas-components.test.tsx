import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ============================================================
// Piezas de /ventas renderizadas a HTML estático (como el resto de
// pruebas de componentes del repo): acciones según el estado y el rol,
// estados vacíos, la cédula solo en el detalle y el aviso fallido
// visible con su motivo.
// ============================================================

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { OrderList, OrderToolbar, orderTitleId } from './order-list'
import { OrderDetailBody } from './order-detail-dialog'
import { SalesSummaryTiles } from './sales-summary'
import { SUMMARY_LIMIT, type PanelOrder } from '@/modules/ventas/panel'
import type { OrderItemRow, OrderRow } from '@/modules/ventas/repo'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

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
  created_at: '2026-10-21T01:30:00Z',
}

const order = (patch: Partial<PanelOrder> = {}): PanelOrder => ({ ...base, ...patch })

function renderList(orders: PanelOrder[], props: Partial<React.ComponentProps<typeof OrderList>> = {}) {
  return renderToStaticMarkup(
    React.createElement(OrderList, {
      orders,
      hasAny: orders.length > 0,
      hasQuery: false,
      canAct: true,
      busyIds: new Set<string>(),
      onAction: () => {},
      onOpenDetail: () => {},
      ...props,
    }),
  )
}

const ALL_ACTIONS = [T.actions.markPaid, T.actions.markShipped, T.actions.markDelivered, T.actions.cancel]

describe('<OrderList />', () => {
  it('pedido nuevo sin pagar: las cuatro acciones, número, cliente y total', () => {
    const html = renderList([order()])
    for (const label of ALL_ACTIONS) expect(html).toContain(label)
    expect(html).toContain('Pedido #1001')
    expect(html).toContain('Mariana Ospina')
    expect(html).toContain('$150.000')
    expect(html).toContain('mar 20 oct, 8:30 p. m.')
  })

  it('entregado y pagado: ninguna acción, solo el detalle', () => {
    const html = renderList([order({ status: 'delivered', payment_status: 'paid' })])
    for (const label of ALL_ACTIONS) expect(html).not.toContain(label)
    expect(html).toContain(T.actions.viewDetail)
  })

  it('viewer (sin permiso): ninguna acción aunque el estado las admita', () => {
    const html = renderList([order()], { canAct: false })
    for (const label of ALL_ACTIONS) expect(html).not.toContain(label)
    expect(html).toContain(T.actions.viewDetail)
  })

  it('nunca muestra la cédula en la lista', () => {
    const withId = { ...order(), id_number: '1.017.555.222' } as PanelOrder
    expect(renderList([withId])).not.toContain('1.017.555.222')
  })

  it('aviso fallido: insignia visible con el motivo', () => {
    const html = renderList([
      order({ last_notice: 'paid', last_notice_error: 'Plantilla no aprobada en Meta' }),
    ])
    expect(html).toContain(T.notice.failedBadge)
    expect(html).toContain('title="Plantilla no aprobada en Meta"')
  })

  it('mientras se guarda: botones desactivados; el aviso para lectores lo da la página', () => {
    const html = renderList([order()], { busyIds: new Set([base.id]) })
    expect(html).toContain(T.actions.working)
    expect(html).not.toContain('role="status"')
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Marcar pagado/)
  })

  it('varios pedidos guardando a la vez: cada uno bloquea solo los suyos', () => {
    const a = order({ id: 'a', number: 1001 })
    const b = order({ id: 'b', number: 1002 })
    const c = order({ id: 'c', number: 1003 })
    const html = renderList([a, b, c], { busyIds: new Set(['a', 'c']) })
    const disabledPaid = html.match(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*?Marcar pagado/g) ?? []
    expect(disabledPaid).toHaveLength(2)
  })

  it('el título de cada pedido tiene id para devolverle el foco tras una acción', () => {
    expect(renderList([order()])).toContain(`id="${orderTitleId(base.id)}"`)
  })

  it('estados vacíos: cuenta sin pedidos, filtro y búsqueda', () => {
    expect(renderList([], { hasAny: false })).toContain(T.empty.title)
    expect(renderList([], { hasAny: true })).toContain(T.empty.filtered)
    expect(renderList([], { hasAny: true, hasQuery: true })).toContain(T.empty.search)
  })
})

describe('<OrderToolbar />', () => {
  it('búsqueda con etiqueta y filtros con su cuenta y aria-pressed', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrderToolbar, {
        orders: [order(), order({ id: 'b', status: 'cancelled' })],
        filter: 'pendingPayment',
        onFilterChange: () => {},
        query: '',
        onQueryChange: () => {},
      }),
    )
    expect(html).toContain('for="ventas-search"')
    expect(html).toContain(T.filters.toShip)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Pendientes de pago<span[^>]*>1</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Todos<span[^>]*>2</)
  })
})

describe('<SalesSummaryTiles />', () => {
  it('muestra las tres cifras en la moneda de la cuenta', () => {
    const html = renderToStaticMarkup(
      React.createElement(SalesSummaryTiles, {
        summary: {
          soldThisMonth: [{ currency: 'COP', cents: 45_000_000 }],
          ordersThisMonth: 7,
          pendingToCollect: [],
        },
        currency: 'COP',
        loading: false,
      }),
    )
    expect(html).toContain(T.summary.soldThisMonth)
    expect(html).toContain('$450.000')
    expect(html).toContain('>7<')
    expect(html).toContain('$0')
  })
})

describe('<SalesSummaryTiles />: fallos y tope', () => {
  const summary = { soldThisMonth: [], ordersThisMonth: 0, pendingToCollect: [] }

  it('si no se pudo leer: error con "Reintentar", sin cifras', () => {
    const html = renderToStaticMarkup(
      React.createElement(SalesSummaryTiles, {
        summary: null,
        currency: 'COP',
        loading: false,
        failed: true,
        onRetry: () => {},
      }),
    )
    expect(html).toContain(T.summary.loadFailed)
    expect(html).toContain(T.actions.retry)
    expect(html).not.toContain(T.summary.soldThisMonth)
  })

  it('si llegó al tope de filas: avisa que puede estar incompleto', () => {
    const html = renderToStaticMarkup(
      React.createElement(SalesSummaryTiles, { summary, currency: 'COP', loading: false, truncated: true }),
    )
    expect(html).toContain(T.summary.truncated(SUMMARY_LIMIT))
  })

  it('sin tope no dice nada', () => {
    const html = renderToStaticMarkup(
      React.createElement(SalesSummaryTiles, { summary, currency: 'COP', loading: false }),
    )
    expect(html).not.toContain(T.summary.truncated(SUMMARY_LIMIT))
  })
})

describe('<OrderDetailBody />', () => {
  const items: OrderItemRow[] = [
    { id: 'i1', order_id: base.id, account_id: 'acc', name: 'Anillo de plata', quantity: 2, unit_price: 45000, position: 0 },
  ]
  const detail = (patch: Partial<OrderRow> = {}) =>
    ({
      ...base,
      account_id: 'acc',
      contact_id: null,
      conversation_id: null,
      deal_id: null,
      subtotal: 90000,
      shipping: 12000,
      total: 102000,
      id_number: '1017555222',
      notes: null,
      created_by: null,
      shipped_at: null,
      delivered_at: null,
      cancelled_at: null,
      updated_at: base.created_at,
      items,
      ...patch,
    }) as OrderRow & { items: OrderItemRow[] }

  it('líneas, totales y cédula con su nota de dato personal', () => {
    const html = renderToStaticMarkup(React.createElement(OrderDetailBody, { order: detail() }))
    expect(html).toContain('Anillo de plata')
    expect(html).toContain('$90.000')
    expect(html).toContain('$102.000')
    expect(html).toContain('1017555222')
    expect(html).toContain(T.detail.idNumberNote)
  })

  it('aviso fallido con su motivo', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrderDetailBody, {
        order: detail({ last_notice: 'shipped', last_notice_error: 'Pasaron más de 24 horas desde el último mensaje del cliente' }),
      }),
    )
    expect(html).toContain('Aviso de envío: no se pudo mandar')
    expect(html).toContain(T.detail.noticeReason('Pasaron más de 24 horas desde el último mensaje del cliente'))
  })

  it('sin aviso todavía', () => {
    const html = renderToStaticMarkup(React.createElement(OrderDetailBody, { order: detail() }))
    expect(html).toContain(T.detail.noNotice)
  })
})
