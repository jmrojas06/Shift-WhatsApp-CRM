import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { PANEL_ORDER_COLUMNS, SUMMARY_LIMIT, SUMMARY_ORDER_COLUMNS } from './panel'
import {
  fetchOrderByNumber,
  fetchOrderDetail,
  fetchPanelOrders,
  fetchSalesSettings,
  fetchSummaryRows,
} from './queries'

// ============================================================
// Lecturas de las pantallas de Ventas contra un cliente de mentira que
// anota cada llamada: qué columnas se piden (nunca la cédula en las
// listas), que todo va filtrado por cuenta y los topes.
// ============================================================

type Call = [string, ...unknown[]]
type Result = { data: unknown; error: unknown }

function fakeClient(results: Record<string, Result>) {
  const calls: Record<string, Call[]> = {}
  const client = {
    from(table: string) {
      const log: Call[] = (calls[table] ??= [])
      const result = results[table] ?? { data: null, error: null }
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'or', 'order', 'limit', 'maybeSingle']) {
        builder[method] = (...args: unknown[]) => {
          log.push([method, ...args])
          return builder
        }
      }
      builder.then = (resolve: (value: Result) => unknown) => resolve(result)
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('fetchPanelOrders', () => {
  it('pide solo las columnas de la lista, de la cuenta, más reciente primero y con tope', async () => {
    const { client, calls } = fakeClient({ orders: { data: [{ id: 'a' }], error: null } })
    const res = await fetchPanelOrders(client, 'acc-1', { limit: 500 })
    expect(res).toEqual({ data: [{ id: 'a' }], error: null })
    expect(calls.orders).toEqual([
      ['select', PANEL_ORDER_COLUMNS],
      ['eq', 'account_id', 'acc-1'],
      ['order', 'created_at', { ascending: false }],
      ['limit', 500],
    ])
    expect(String(calls.orders[0][1])).not.toMatch(/id_number|\*/)
  })

  it('los de un contacto (panel del inbox)', async () => {
    const { client, calls } = fakeClient({})
    await fetchPanelOrders(client, 'acc-1', { contactId: 'c-1', limit: 5 })
    expect(calls.orders).toContainEqual(['eq', 'contact_id', 'c-1'])
    expect(calls.orders).toContainEqual(['limit', 5])
  })
})

describe('fetchSummaryRows', () => {
  it('columnas mínimas, desde el inicio del mes en Colombia, con tope explícito', async () => {
    const { client, calls } = fakeClient({ orders: { data: [], error: null } })
    const res = await fetchSummaryRows(client, 'acc-1', new Date('2026-10-22T12:00:00Z'))
    expect(res).toEqual({ rows: [], truncated: false, error: null })
    expect(calls.orders).toEqual([
      ['select', SUMMARY_ORDER_COLUMNS],
      ['eq', 'account_id', 'acc-1'],
      [
        'or',
        'paid_at.gte."2026-10-01T05:00:00.000Z",created_at.gte."2026-10-01T05:00:00.000Z",and(payment_status.eq.pending,status.neq.cancelled)',
      ],
      ['limit', SUMMARY_LIMIT],
    ])
  })

  it('marca el resumen como incompleto si llegó al tope', async () => {
    const rows = Array.from({ length: SUMMARY_LIMIT }, () => ({}))
    const { client } = fakeClient({ orders: { data: rows, error: null } })
    const res = await fetchSummaryRows(client, 'acc-1', new Date())
    expect(res.truncated).toBe(true)
  })

  it('error: sin filas', async () => {
    const { client } = fakeClient({ orders: { data: null, error: { code: 'XX' } } })
    expect(await fetchSummaryRows(client, 'acc-1', new Date())).toEqual({
      rows: null,
      truncated: false,
      error: { code: 'XX' },
    })
  })
})

describe('fetchOrderByNumber', () => {
  it('busca por consecutivo dentro de la cuenta, sin cédula', async () => {
    const { client, calls } = fakeClient({ orders: { data: { id: 'x', number: 1042 }, error: null } })
    const res = await fetchOrderByNumber(client, 'acc-1', 1042)
    expect(res.order).toEqual({ id: 'x', number: 1042 })
    expect(calls.orders).toEqual([
      ['select', PANEL_ORDER_COLUMNS],
      ['eq', 'account_id', 'acc-1'],
      ['eq', 'number', 1042],
      ['maybeSingle'],
    ])
  })
})

describe('fetchOrderDetail', () => {
  it('el detalle sí trae todo (cédula incluida), filtrado por cuenta, y sus líneas en orden', async () => {
    const { client, calls } = fakeClient({
      orders: { data: { id: 'o-1', account_id: 'acc-1' }, error: null },
      order_items: { data: [{ id: 'i-1' }], error: null },
    })
    const res = await fetchOrderDetail(client, 'acc-1', 'o-1')
    expect(res).toEqual({ order: { id: 'o-1', account_id: 'acc-1', items: [{ id: 'i-1' }] }, error: null })
    expect(calls.orders).toEqual([
      ['select', '*'],
      ['eq', 'id', 'o-1'],
      ['eq', 'account_id', 'acc-1'],
      ['maybeSingle'],
    ])
    expect(calls.order_items).toEqual([
      ['select', '*'],
      ['eq', 'order_id', 'o-1'],
      ['eq', 'account_id', 'acc-1'],
      ['order', 'position', { ascending: true }],
    ])
  })

  it('pedido que no existe o error: sin detalle', async () => {
    const { client } = fakeClient({ orders: { data: null, error: null } })
    expect((await fetchOrderDetail(client, 'acc-1', 'o-1')).order).toBeNull()
  })
})

describe('fetchSalesSettings', () => {
  it('sin fila: los tres avisos prendidos', async () => {
    const { client, calls } = fakeClient({ sales_settings: { data: null, error: null } })
    expect(await fetchSalesSettings(client, 'acc-1')).toEqual({
      settings: { notify_paid: true, notify_shipped: true, notify_delivered: true },
      error: null,
    })
    expect(calls.sales_settings).toContainEqual(['eq', 'account_id', 'acc-1'])
  })

  it('respeta lo guardado', async () => {
    const { client } = fakeClient({
      sales_settings: { data: { notify_paid: false, notify_shipped: true, notify_delivered: false }, error: null },
    })
    expect((await fetchSalesSettings(client, 'acc-1')).settings).toEqual({
      notify_paid: false,
      notify_shipped: true,
      notify_delivered: false,
    })
  })
})
