import { describe, expect, it } from 'vitest'

import {
  addDraftLine,
  buildOrderRequest,
  draftTotals,
  emptyOrderDraft,
  parseAmountInput,
  parseQuantityInput,
  removeDraftLine,
  updateDraftLine,
  type OrderDraft,
} from './order-form'
import { ORDER_LIMITS, validateOrderCreate } from './orders'

const CONTACT = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'

describe('parseAmountInput: valores como los escribe la gente en Colombia', () => {
  it.each([
    ['150000', 150000],
    ['150.000', 150000],
    ['1.500.000', 1500000],
    ['12.000,50', 12000.5],
    ['12000,5', 12000.5],
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['1,500', 1500],
    ['1,234.56', 1234.56],
    ['$ 45.900', 45900],
    ['  0 ', 0],
  ])('%s → %s', (raw, expected) => {
    expect(parseAmountInput(raw)).toBe(expected)
  })

  it('vacío es null (el que llama decide)', () => {
    expect(parseAmountInput('')).toBeNull()
    expect(parseAmountInput('   ')).toBeNull()
  })

  it('basura o negativos son NaN, para que el dominio los rechace', () => {
    expect(parseAmountInput('abc')).toBeNaN()
    expect(parseAmountInput('-500')).toBeNaN()
    expect(parseAmountInput('1.2.3,4,5')).toBeNaN()
  })
})

describe('parseQuantityInput', () => {
  it('enteros', () => {
    expect(parseQuantityInput('3')).toBe(3)
    expect(parseQuantityInput(' 12 ')).toBe(12)
  })

  it('decimales, vacío o texto: NaN', () => {
    expect(parseQuantityInput('1.5')).toBeNaN()
    expect(parseQuantityInput('')).toBeNaN()
    expect(parseQuantityInput('dos')).toBeNaN()
  })
})

describe('líneas del borrador', () => {
  it('empieza con una línea vacía de cantidad 1', () => {
    const draft = emptyOrderDraft()
    expect(draft.lines).toHaveLength(1)
    expect(draft.lines[0]).toMatchObject({ name: '', quantity: '1', unitPrice: '' })
    expect(draft.paid).toBe(false)
  })

  it('agrega hasta el máximo y no pasa de ahí', () => {
    let draft = emptyOrderDraft()
    for (let i = 0; i < ORDER_LIMITS.itemsMax + 5; i++) draft = addDraftLine(draft)
    expect(draft.lines).toHaveLength(ORDER_LIMITS.itemsMax)
    expect(new Set(draft.lines.map((l) => l.key)).size).toBe(ORDER_LIMITS.itemsMax)
  })

  it('quita líneas pero siempre deja una', () => {
    let draft = addDraftLine(emptyOrderDraft())
    const [first, second] = draft.lines
    draft = removeDraftLine(draft, first.key)
    expect(draft.lines.map((l) => l.key)).toEqual([second.key])
    draft = removeDraftLine(draft, second.key)
    expect(draft.lines).toHaveLength(1)
  })

  it('actualiza una línea sin tocar las demás', () => {
    const draft = addDraftLine(emptyOrderDraft())
    const next = updateDraftLine(draft, draft.lines[1].key, { name: 'Aretes' })
    expect(next.lines[1].name).toBe('Aretes')
    expect(next.lines[0]).toBe(draft.lines[0])
  })
})

function filled(patch: Partial<OrderDraft> = {}): OrderDraft {
  const base = emptyOrderDraft()
  return {
    ...base,
    lines: [
      { key: 'a', name: 'Anillo de plata', quantity: '2', unitPrice: '45.000' },
      { key: 'b', name: 'Cadena', quantity: '1', unitPrice: '80.000,50' },
    ],
    shipping: '12.000',
    ...patch,
  }
}

describe('draftTotals: total de muestra en vivo', () => {
  it('cantidad × precio más envío, en centavos exactos', () => {
    const totals = draftTotals(filled())
    expect(totals.subtotalCents).toBe(17_000_050)
    expect(totals.shippingCents).toBe(1_200_000)
    expect(totals.totalCents).toBe(18_200_050)
  })

  it('una línea a medio escribir cuenta como cero, no rompe el total', () => {
    const totals = draftTotals(
      filled({
        lines: [
          { key: 'a', name: 'Anillo', quantity: '2', unitPrice: '10.000' },
          { key: 'b', name: '', quantity: '', unitPrice: 'abc' },
        ],
        shipping: '',
      }),
    )
    expect(totals.totalCents).toBe(2_000_000)
  })
})

describe('buildOrderRequest: el cuerpo que espera POST /api/modules/ventas/orders', () => {
  it('arma el cuerpo con números y textos limpios', () => {
    const result = buildOrderRequest(
      filled({ city: ' Pereira ', address: 'Calle 19 # 8-34', idNumber: '', notes: 'Empacar para regalo', paid: true }),
      CONTACT,
      CONVERSATION,
    )
    expect(result).toEqual({
      ok: true,
      value: {
        contactId: CONTACT,
        conversationId: CONVERSATION,
        items: [
          { name: 'Anillo de plata', quantity: 2, unitPrice: 45000 },
          { name: 'Cadena', quantity: 1, unitPrice: 80000.5 },
        ],
        shipping: 12000,
        paid: true,
        city: 'Pereira',
        address: 'Calle 19 # 8-34',
        idNumber: null,
        notes: 'Empacar para regalo',
      },
    })
  })

  it('el cuerpo nunca lleva total y el dominio del servidor lo acepta', () => {
    const result = buildOrderRequest(filled(), CONTACT, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).not.toHaveProperty('total')
    expect(validateOrderCreate(result.value).ok).toBe(true)
  })

  it('envío vacío es cero', () => {
    const result = buildOrderRequest(filled({ shipping: '' }), CONTACT, null)
    expect(result.ok && result.value.shipping).toBe(0)
  })

  it('usa los mismos mensajes que el servidor', () => {
    const noName = buildOrderRequest(
      filled({ lines: [{ key: 'a', name: ' ', quantity: '1', unitPrice: '1000' }] }),
      CONTACT,
      null,
    )
    expect(noName).toEqual({ ok: false, message: 'Producto 1: escribe el nombre.', line: 0, field: 'name' })

    const badQty = buildOrderRequest(
      filled({
        lines: [
          { key: 'a', name: 'A', quantity: '1', unitPrice: '1000' },
          { key: 'b', name: 'B', quantity: '0', unitPrice: '1000' },
        ],
      }),
      CONTACT,
      null,
    )
    expect(badQty.ok).toBe(false)
    if (!badQty.ok) {
      expect(badQty.message).toMatch(/^Producto 2: la cantidad/)
      expect(badQty).toMatchObject({ line: 1, field: 'quantity' })
    }
  })

  it('precio vacío o ilegible se rechaza con el mensaje del dominio', () => {
    const empty = buildOrderRequest(
      filled({ lines: [{ key: 'a', name: 'A', quantity: '1', unitPrice: '' }] }),
      CONTACT,
      null,
    )
    expect(empty).toMatchObject({ ok: false, line: 0, field: 'unitPrice' })
    if (!empty.ok) expect(empty.message).toBe('Producto 1: el precio debe ser un número.')
  })

  it('envío ilegible', () => {
    const result = buildOrderRequest(filled({ shipping: 'gratis' }), CONTACT, null)
    expect(result).toMatchObject({ ok: false, field: 'shipping', message: 'El envío debe ser un número.' })
  })

  it('cédula con caracteres raros', () => {
    const result = buildOrderRequest(filled({ idNumber: '1.234/567' }), CONTACT, null)
    expect(result).toMatchObject({ ok: false, field: 'idNumber' })
  })
})
