// ============================================================
// Lecturas de las pantallas de Ventas (inbox y /ventas).
//
// Con el cliente de Supabase del usuario: la RLS de 054 deja leer a los
// miembros de la cuenta, y además todo va filtrado por `account_id`. Las
// listas piden `PANEL_ORDER_COLUMNS` (sin cédula); solo el detalle lee la
// fila completa. Nunca lanzan: devuelven el error de PostgREST para que
// la pantalla decida (por ejemplo, "falta la migración").
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  PANEL_ORDER_COLUMNS,
  SUMMARY_LIMIT,
  SUMMARY_ORDER_COLUMNS,
  isSummaryTruncated,
  salesMonthStart,
  type PanelOrder,
} from './panel'
import type { OrderItemRow, OrderRow, SalesSettings } from './repo'

export type QueryError = { code?: string | null; message?: string } | null

export type SummaryRow = Pick<
  PanelOrder,
  'status' | 'payment_status' | 'total' | 'currency' | 'paid_at' | 'created_at'
>

export type OrderDetail = OrderRow & { items: OrderItemRow[] }

/** Pedidos para una lista, el más reciente primero. */
export async function fetchPanelOrders(
  db: SupabaseClient,
  accountId: string,
  opts: { contactId?: string; limit: number },
): Promise<{ data: PanelOrder[] | null; error: QueryError }> {
  let query = db.from('orders').select(PANEL_ORDER_COLUMNS).eq('account_id', accountId)
  if (opts.contactId) query = query.eq('contact_id', opts.contactId)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(opts.limit)
  return { data: (data as unknown as PanelOrder[] | null) ?? null, error }
}

/**
 * Filas del resumen: pagadas o creadas desde el inicio del mes (hora de
 * Colombia) y todas las pendientes de cobro. `salesSummary` vuelve a
 * filtrar por mes y estado. Con `truncated` la pantalla avisa que las
 * cifras pueden estar incompletas.
 */
export async function fetchSummaryRows(
  db: SupabaseClient,
  accountId: string,
  now: Date,
): Promise<{ rows: SummaryRow[] | null; truncated: boolean; error: QueryError }> {
  const since = salesMonthStart(now).toISOString()
  const { data, error } = await db
    .from('orders')
    .select(SUMMARY_ORDER_COLUMNS)
    .eq('account_id', accountId)
    .or(
      `paid_at.gte."${since}",created_at.gte."${since}",and(payment_status.eq.pending,status.neq.cancelled)`,
    )
    // Orden fijo: si se llega al tope, se quedan por fuera las filas más viejas.
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(SUMMARY_LIMIT)
  if (error) return { rows: null, truncated: false, error }
  const rows = (data ?? []) as unknown as SummaryRow[]
  return { rows, truncated: isSummaryTruncated(rows.length), error: null }
}

/** Un pedido por su consecutivo (enlace `?pedido=1001`), sin cédula. */
export async function fetchOrderByNumber(
  db: SupabaseClient,
  accountId: string,
  number: number,
): Promise<{ order: PanelOrder | null; error: QueryError }> {
  const { data, error } = await db
    .from('orders')
    .select(PANEL_ORDER_COLUMNS)
    .eq('account_id', accountId)
    .eq('number', number)
    .maybeSingle()
  return { order: (data as unknown as PanelOrder | null) ?? null, error }
}

/** Detalle completo (cédula incluida) con sus líneas en orden. */
export async function fetchOrderDetail(
  db: SupabaseClient,
  accountId: string,
  orderId: string,
): Promise<{ order: OrderDetail | null; error: QueryError }> {
  const [orderRes, itemsRes] = await Promise.all([
    db.from('orders').select('*').eq('id', orderId).eq('account_id', accountId).maybeSingle(),
    db
      .from('order_items')
      .select('*')
      .eq('order_id', orderId)
      .eq('account_id', accountId)
      .order('position', { ascending: true }),
  ])
  const error = orderRes.error ?? itemsRes.error ?? null
  if (error || !orderRes.data) return { order: null, error }
  return {
    order: { ...(orderRes.data as OrderRow), items: (itemsRes.data ?? []) as OrderItemRow[] },
    error: null,
  }
}

/** Interruptores de avisos; sin fila, los tres prendidos (igual que la base). */
export async function fetchSalesSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<{ settings: SalesSettings; error: QueryError }> {
  const { data, error } = await db
    .from('sales_settings')
    .select('notify_paid, notify_shipped, notify_delivered')
    .eq('account_id', accountId)
    .maybeSingle()
  const row = data as Partial<SalesSettings> | null
  return {
    settings: {
      notify_paid: row?.notify_paid ?? true,
      notify_shipped: row?.notify_shipped ?? true,
      notify_delivered: row?.notify_delivered ?? true,
    },
    error,
  }
}
