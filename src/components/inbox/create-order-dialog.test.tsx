import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ============================================================
// Formulario "Crear pedido" y resultado del aviso.
//
// Se renderiza a HTML estático, como el resto de pruebas de componentes
// del repo (no hay DOM en el entorno de pruebas). Las partes del Dialog
// de base-ui necesitan su contexto y un portal: se cambian por etiquetas
// simples para probar el contenido. La validación del envío se prueba en
// order-form.test.ts (misma función que usa el formulario).
// ============================================================

vi.mock('@/components/ui/dialog', () => {
  const pass = (tag: string) => {
    function Plain({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) {
      return React.createElement(tag, rest, children)
    }
    return Plain
  }
  return {
    Dialog: pass('div'),
    DialogContent: pass('div'),
    DialogHeader: pass('div'),
    DialogFooter: pass('div'),
    DialogTitle: pass('h2'),
    DialogDescription: pass('p'),
  }
})

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { CreateOrderForm, CreateOrderSuccess } from './create-order-dialog'
import type { OrderDraft } from '@/modules/ventas/order-form'
import { emptyOrderDraft } from '@/modules/ventas/order-form'
import { ORDER_LIMITS } from '@/modules/ventas/orders'
import type { OrderWithItems } from '@/modules/ventas/repo'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

const CONTACT = '11111111-1111-4111-8111-111111111111'

function renderForm(initialDraft?: OrderDraft): string {
  return renderToStaticMarkup(
    React.createElement(CreateOrderForm, {
      contactId: CONTACT,
      contactName: 'Valentina Restrepo',
      conversationId: null,
      currency: 'COP',
      initialDraft,
      onSaved: () => {},
      onCancel: () => {},
    }),
  )
}

const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

describe('<CreateOrderForm />', () => {
  it('no pide nombre ni teléfono: los toma del contacto', () => {
    const html = decode(renderForm())
    expect(html).toContain(T.createOrder.description('Valentina Restrepo'))
    expect(html).not.toMatch(/autoComplete="tel"|type="tel"/i)
  })

  it('cada campo de texto tiene su etiqueta', () => {
    const html = renderForm()
    const ids = [...html.matchAll(/<(?:input|textarea)[^>]*\sid="([^"]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThanOrEqual(8)
    for (const id of ids) {
      expect(html).toContain(`for="${id}"`)
    }
  })

  it('el interruptor de "ya pagó" tiene nombre y descripción', () => {
    const html = renderForm()
    const switchTag = /<[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? ''
    expect(switchTag).toMatch(/aria-labelledby="[^"]+"/)
    expect(switchTag).toMatch(/aria-describedby="[^"]+"/)
    expect(html).toContain(T.createOrder.paidLabel)
  })

  it('muestra el total de muestra con el envío', () => {
    const html = renderForm({
      ...emptyOrderDraft(),
      lines: [
        { key: 'a', name: 'Anillo de plata', quantity: '2', unitPrice: '45.000' },
        { key: 'b', name: 'Cadena', quantity: '1', unitPrice: '80.000,50' },
      ],
      shipping: '12.000',
    })
    const total = /data-testid="order-total"[^>]*>([^<]+)</.exec(html)?.[1]
    expect(total).toBe('$182.000,50')
    expect(html).toContain(T.createOrder.totalHint)
  })

  it('con una sola línea no se puede quitar', () => {
    const html = renderForm()
    const remove = new RegExp(`<button[^>]*aria-label="${T.createOrder.removeLine(1)}"[^>]*>`).exec(html)?.[0]
    expect(remove).toMatch(/\sdisabled=""/)
  })

  it('con dos líneas sí se pueden quitar, y agregar sigue disponible', () => {
    const html = renderForm({
      ...emptyOrderDraft(),
      lines: [
        { key: 'a', name: 'A', quantity: '1', unitPrice: '1' },
        { key: 'b', name: 'B', quantity: '1', unitPrice: '1' },
      ],
    })
    const remove = new RegExp(`<button[^>]*aria-label="${T.createOrder.removeLine(1)}"[^>]*>`).exec(html)?.[0]
    expect(remove).not.toMatch(/\sdisabled=""/)
    const add = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Agregar producto/.exec(html)?.[0] ?? ''
    expect(add).not.toMatch(/\sdisabled=""/)
  })

  it('en el máximo de líneas no deja agregar más y lo dice', () => {
    const lines = Array.from({ length: ORDER_LIMITS.itemsMax }, (_, i) => ({
      key: `k${i}`,
      name: `Producto ${i + 1}`,
      quantity: '1',
      unitPrice: '1000',
    }))
    const html = renderForm({ ...emptyOrderDraft(), lines })
    expect(html).toContain(T.createOrder.linesLimit(ORDER_LIMITS.itemsMax))
    const add = /<button[^>]*>(?:(?!<\/button>)[\s\S])*Agregar producto/.exec(html)?.[0] ?? ''
    expect(add).toMatch(/\sdisabled=""/)
  })

  it('la cédula es opcional y avisa que no sale en las listas', () => {
    const html = renderForm()
    expect(html).toContain(T.createOrder.idNumberLabel)
    expect(html).toContain(T.createOrder.idNumberHint)
  })
})

function created(patch: Partial<OrderWithItems> = {}): OrderWithItems {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    account_id: 'acc',
    number: 1007,
    contact_id: CONTACT,
    customer_name: 'Valentina Restrepo',
    customer_phone: '+57 311 000 0000',
    conversation_id: null,
    deal_id: null,
    subtotal: 90000,
    shipping: 12000,
    total: 102000,
    currency: 'COP',
    payment_status: 'paid',
    status: 'new',
    city: null,
    address: null,
    id_number: null,
    carrier: null,
    tracking_number: null,
    notes: null,
    last_notice: null,
    last_notice_error: null,
    created_by: null,
    paid_at: '2026-10-22T15:00:00Z',
    shipped_at: null,
    delivered_at: null,
    cancelled_at: null,
    created_at: '2026-10-22T15:00:00Z',
    updated_at: '2026-10-22T15:00:00Z',
    items: [],
    ...patch,
  }
}

function renderSuccess(order: OrderWithItems, notice: 'sent' | 'failed' | 'skipped' | null): string {
  return renderToStaticMarkup(
    React.createElement(CreateOrderSuccess, {
      result: { order, notice },
      onDone: () => {},
      onCreateAnother: () => {},
    }),
  )
}

describe('<CreateOrderSuccess />: resultado del aviso', () => {
  it('muestra el pedido creado y su total', () => {
    const html = renderSuccess(created(), null)
    expect(html).toContain(T.createOrder.created(1007))
    expect(html).toContain('$102.000')
  })

  it('aviso mandado: confirmación tranquila', () => {
    const html = renderSuccess(created({ last_notice: 'paid' }), 'sent')
    expect(html).toContain(T.notice.sent)
    expect(html).toContain('data-tone="success"')
    expect(html).toContain('role="status"')
  })

  it('aviso fallido: advertencia con el motivo, sin tratarlo como error', () => {
    const html = renderSuccess(
      created({ last_notice: 'paid', last_notice_error: 'Plantilla no aprobada en Meta' }),
      'failed',
    )
    expect(html).toContain('Plantilla no aprobada en Meta')
    expect(html).toContain('data-tone="warning"')
    expect(html).not.toContain('role="alert"')
  })

  it('aviso apagado o sin aviso: no dice nada del aviso', () => {
    for (const notice of ['skipped', null] as const) {
      const html = renderSuccess(created(), notice)
      expect(html).not.toContain('data-tone=')
      expect(html).not.toContain(T.notice.sent)
    }
  })
})
