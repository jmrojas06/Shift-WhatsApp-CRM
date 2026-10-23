// ============================================================
// Doble de `create_order()` para los tests de Ventas.
//
// El fake de Supabase no ejecuta SQL; este manejador (para `_onRpc`)
// reproduce lo esencial de la función de la migración 054: el
// consecutivo desde 1001 por cuenta, el total calculado a partir de
// las líneas y el envío, la moneda fija (COP), el estado inicial según
// `p_paid` y las líneas en `order_items`. Si las tablas `contacts` /
// `conversations` existen en el fake, comprueba que pertenezcan a la
// cuenta y responde 23503 como Postgres.
//
// NO valida rangos ni permisos: eso lo cubren las migraciones; los
// tests de error usan `_failNext('rpc', 'create_order', …)`.
// ============================================================

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

export const STUB_ORDER_ID = '33333333-3333-4333-8333-333333333333'
export const STUB_NOW = '2026-10-23T15:00:00.000Z'

export function stubCreateOrder(
  rpcDb: FakeDb,
  /** Base donde caen las filas (la que lee el servidor); por defecto la misma. */
  target: FakeDb = rpcDb,
  options: { createdBy?: string } = {},
): void {
  rpcDb._onRpc('create_order', (args) => {
    const accountId = args.p_account_id
    const contacts = target._tables.contacts
    if (contacts && !contacts.some((c) => c.id === args.p_contact_id && c.account_id === accountId)) {
      return { data: null, error: { code: '23503', message: 'contact does not belong to account' } }
    }
    const conversations = target._tables.conversations
    if (
      args.p_conversation_id &&
      conversations &&
      !conversations.some((c) => c.id === args.p_conversation_id && c.account_id === accountId)
    ) {
      return { data: null, error: { code: '23503', message: 'conversation does not belong' } }
    }

    const items = args.p_items as { name: string; quantity: number; unit_price: number }[]
    const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0)
    const shipping = (args.p_shipping as number) ?? 0
    const paid = args.p_paid === true
    const fields = (args.p_fields ?? {}) as Record<string, string | null>
    const taken = (target._tables.orders ?? []).filter((o) => o.account_id === accountId).length
    const contact = contacts?.find((c) => c.id === args.p_contact_id)

    const order: Row = {
      id: STUB_ORDER_ID,
      account_id: accountId,
      number: 1001 + taken,
      contact_id: args.p_contact_id,
      customer_name: (contact?.name as string | undefined) ?? 'Ana',
      customer_phone: (contact?.phone as string | undefined) ?? '573001112233',
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
      created_by: options.createdBy ?? 'user-1',
      paid_at: paid ? STUB_NOW : null,
      shipped_at: null,
      delivered_at: null,
      cancelled_at: null,
      created_at: STUB_NOW,
      updated_at: STUB_NOW,
    }
    ;(target._tables.orders ??= []).push(order)
    items.forEach((item, position) => {
      ;(target._tables.order_items ??= []).push({
        id: `item-${position}`,
        order_id: order.id,
        account_id: accountId,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        position,
      })
    })
    return { data: { ...order }, error: null }
  })
}
