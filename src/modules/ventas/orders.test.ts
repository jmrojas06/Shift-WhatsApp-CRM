import { describe, expect, it } from 'vitest'

import {
  ORDER_ACTIONS,
  ORDER_LIMITS,
  SALES_STAGES,
  applyOrderAction,
  dealStatusFor,
  fromCents,
  SALES_TIME_ZONE,
  isCountedSale,
  isOrderAction,
  noticeFor,
  orderTotals,
  pipelineStageFor,
  toCents,
  validateOrderCreate,
  type OrderAction,
  type OrderState,
} from './orders'

const CONTACT = '3f2b8c1e-5d4a-4b7e-9a10-0c2d3e4f5a6b'
const CONVERSATION = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'

const base = () => ({
  contactId: CONTACT,
  items: [{ name: 'Anillo de oro', quantity: 1, unitPrice: 150000 }],
})

function ok(input: unknown) {
  const r = validateOrderCreate(input)
  if (!r.ok) throw new Error(`esperaba ok, vino: ${r.message}`)
  return r.value
}

function fail(input: unknown): string {
  const r = validateOrderCreate(input)
  if (r.ok) throw new Error('esperaba error y salió ok')
  return r.message
}

describe('validateOrderCreate — forma general', () => {
  it('acepta el pedido mínimo y rellena los valores por defecto', () => {
    expect(ok(base())).toEqual({
      contactId: CONTACT,
      conversationId: null,
      items: [{ name: 'Anillo de oro', quantity: 1, unitPrice: 150000 }],
      shipping: 0,
      paid: false,
      city: null,
      address: null,
      idNumber: null,
      notes: null,
    })
  })

  it('acepta todos los campos', () => {
    const v = ok({
      ...base(),
      conversationId: CONVERSATION,
      shipping: 12000.5,
      paid: true,
      city: ' Cali ',
      address: ' Calle 5 # 10-20 ',
      idNumber: ' 1.234.567-8 ',
      notes: 'Entregar por la tarde',
    })
    expect(v).toMatchObject({
      conversationId: CONVERSATION,
      shipping: 12000.5,
      paid: true,
      city: 'Cali',
      address: 'Calle 5 # 10-20',
      idNumber: '1.234.567-8',
      notes: 'Entregar por la tarde',
    })
  })

  it.each([null, undefined, 'x', 5, [], true])('rechaza un cuerpo que no es objeto (%s)', (body) => {
    expect(fail(body)).toBe('Los datos del pedido no son válidos.')
  })

  it('ignora cualquier total, subtotal o campo desconocido que llegue en el cuerpo', () => {
    const v = ok({ ...base(), total: 1, subtotal: 1, status: 'delivered', payment_status: 'paid', id: 'x' })
    expect(v).not.toHaveProperty('total')
    expect(v).not.toHaveProperty('subtotal')
    expect(v).not.toHaveProperty('status')
    expect(Object.keys(v).sort()).toEqual(
      ['address', 'city', 'contactId', 'conversationId', 'idNumber', 'items', 'notes', 'paid', 'shipping'].sort(),
    )
  })
})

describe('validateOrderCreate — ids', () => {
  it('exige el contacto', () => {
    expect(fail({ items: base().items })).toBe('Falta el contacto del pedido.')
    expect(fail({ ...base(), contactId: '' })).toBe('Falta el contacto del pedido.')
    expect(fail({ ...base(), contactId: null })).toBe('Falta el contacto del pedido.')
  })

  it.each(['abc', '3f2b8c1e5d4a4b7e9a100c2d3e4f5a6b', '3f2b8c1e-5d4a-4b7e-9a10-0c2d3e4f5a6', 123, {}])(
    'rechaza un contactId que no es uuid (%s)',
    (contactId) => {
      expect(fail({ ...base(), contactId })).toBe('El contacto del pedido no es válido.')
    },
  )

  it('acepta uuid en mayúsculas', () => {
    expect(ok({ ...base(), contactId: CONTACT.toUpperCase() }).contactId).toBe(CONTACT.toUpperCase())
  })

  it('la conversación es opcional pero, si viene, debe ser uuid', () => {
    expect(ok({ ...base(), conversationId: null }).conversationId).toBeNull()
    expect(ok({ ...base(), conversationId: undefined }).conversationId).toBeNull()
    expect(ok({ ...base(), conversationId: '' }).conversationId).toBeNull()
    expect(fail({ ...base(), conversationId: 'nope' })).toBe('La conversación del pedido no es válida.')
    expect(fail({ ...base(), conversationId: 7 })).toBe('La conversación del pedido no es válida.')
  })
})

describe('validateOrderCreate — líneas', () => {
  const line = (over: Record<string, unknown> = {}) => ({ name: 'Cadena', quantity: 2, unitPrice: 50000, ...over })
  const withLines = (...items: unknown[]) => ({ contactId: CONTACT, items })

  it('exige entre 1 y 50 líneas', () => {
    expect(fail({ contactId: CONTACT })).toBe('Agrega al menos un producto.')
    expect(fail({ contactId: CONTACT, items: [] })).toBe('Agrega al menos un producto.')
    expect(fail({ contactId: CONTACT, items: 'x' })).toBe('Agrega al menos un producto.')
    expect(ok(withLines(...Array.from({ length: 50 }, () => line()))).items).toHaveLength(50)
    expect(fail(withLines(...Array.from({ length: 51 }, () => line())))).toBe(
      'Un pedido admite máximo 50 productos.',
    )
  })

  it('cada línea debe ser un objeto', () => {
    expect(fail(withLines(line(), null))).toBe('Producto 2: los datos no son válidos.')
    expect(fail(withLines('x'))).toBe('Producto 1: los datos no son válidos.')
    expect(fail(withLines([]))).toBe('Producto 1: los datos no son válidos.')
  })

  describe('nombre', () => {
    it('lo recorta y respeta el límite de 120 caracteres', () => {
      expect(ok(withLines(line({ name: '  Aretes  ' }))).items[0].name).toBe('Aretes')
      expect(ok(withLines(line({ name: 'a'.repeat(120) }))).items[0].name).toHaveLength(120)
      expect(fail(withLines(line({ name: 'a'.repeat(121) })))).toBe(
        'Producto 1: el nombre no puede pasar de 120 caracteres.',
      )
    })

    it('cuenta puntos de código, no unidades UTF-16 (igual que char_length de Postgres)', () => {
      // 😀 son 2 unidades UTF-16 pero 1 carácter: 120 emojis caben.
      expect(ok(withLines(line({ name: '😀'.repeat(120) }))).items[0].name).toBe('😀'.repeat(120))
      expect(fail(withLines(line({ name: '😀'.repeat(121) })))).toContain('120 caracteres')
    })

    it('acepta tildes, eñes y símbolos comunes', () => {
      expect(ok(withLines(line({ name: 'Collar “Corazón” 18k – talla Ñ' }))).items[0].name).toBe(
        'Collar “Corazón” 18k – talla Ñ',
      )
    })

    it.each([undefined, null, 5, '', '   '])('exige un nombre (%s)', (name) => {
      expect(fail(withLines(line({ name })))).toBe('Producto 1: escribe el nombre.')
    })

    it.each([
      ['salto de línea', 'Anillo\nde oro'],
      ['tabulación', 'Anillo\tde oro'],
      ['NUL', 'Anillo\u0000'],
      ['espacio de ancho cero', 'Ani​llo'],
      ['unión de ancho cero', 'a‍b'],
      ['marca de dirección', 'a‮b'],
      ['sustituto suelto', 'a\uD800b'],
      ['uso privado', 'ab'],
    ])('rechaza %s', (_label, name) => {
      expect(fail(withLines(line({ name })))).toBe(
        'Producto 1: el nombre tiene caracteres no permitidos.',
      )
    })
  })

  describe('cantidad', () => {
    it.each([1, 2, 9999])('acepta %s', (quantity) => {
      expect(ok(withLines(line({ quantity }))).items[0].quantity).toBe(quantity)
    })

    it.each([0, -1, 10000, 1.5, 0.1 + 0.2, NaN, Infinity, '2', null, undefined, true])(
      'rechaza %s',
      (quantity) => {
        expect(fail(withLines(line({ quantity })))).toBe(
          'Producto 1: la cantidad debe ser un número entero entre 1 y 9999.',
        )
      },
    )

    it('un 2.0 de JSON es el entero 2', () => {
      expect(ok(withLines(line({ quantity: 2.0 }))).items[0].quantity).toBe(2)
    })
  })

  describe('precio unitario', () => {
    it('acepta 0 (regalo / cortesía) y el máximo', () => {
      expect(ok(withLines(line({ unitPrice: 0 }))).items[0].unitPrice).toBe(0)
      expect(ok(withLines(line({ unitPrice: 99999999.99, quantity: 1 }))).items[0].unitPrice).toBe(99999999.99)
    })

    it('normaliza -0 a 0', () => {
      expect(Object.is(ok(withLines(line({ unitPrice: -0 }))).items[0].unitPrice, 0)).toBe(true)
    })

    it('rechaza lo que pasa del máximo', () => {
      expect(fail(withLines(line({ unitPrice: 100000000 })))).toBe(
        'Producto 1: el precio no puede pasar de 99.999.999,99.',
      )
      expect(fail(withLines(line({ unitPrice: 1e300 })))).toContain('no puede pasar de')
    })

    it('rechaza negativos', () => {
      expect(fail(withLines(line({ unitPrice: -0.01 })))).toBe('Producto 1: el precio no puede ser negativo.')
    })

    it.each(['100', null, undefined, NaN, Infinity, -Infinity, {}, true])('rechaza %s', (unitPrice) => {
      const msg = fail(withLines(line({ unitPrice })))
      expect(msg).toMatch(/^Producto 1: el precio (debe ser un número|no puede ser negativo)\.$/)
    })

    it('admite hasta 2 decimales', () => {
      expect(ok(withLines(line({ unitPrice: 10.5 }))).items[0].unitPrice).toBe(10.5)
      expect(ok(withLines(line({ unitPrice: 10.55 }))).items[0].unitPrice).toBe(10.55)
      expect(ok(withLines(line({ unitPrice: 0.01 }))).items[0].unitPrice).toBe(0.01)
    })

    it.each([10.001, 1.005, 0.015, 3.14159, 0.0001])('rechaza más de 2 decimales (%s)', (unitPrice) => {
      expect(fail(withLines(line({ unitPrice })))).toBe('Producto 1: el precio admite máximo 2 decimales.')
    })

    it('tolera el ruido de coma flotante de sumas como 0.1 + 0.2', () => {
      const v = ok(withLines(line({ unitPrice: 0.1 + 0.2 })))
      expect(v.items[0].unitPrice).toBe(0.3)
    })

    it('tolera el ruido en importes grandes (99999999.99 calculado)', () => {
      const v = ok(withLines(line({ unitPrice: 99999999 + 0.99, quantity: 1 })))
      expect(v.items[0].unitPrice).toBe(99999999.99)
    })

    it('rechaza fracciones de centavo diminutas (la tolerancia es relativa, no absoluta)', () => {
      for (const unitPrice of [1e-7, 0.000001, 0.0000001, 1e-9, 0.00001, 1e-15]) {
        expect(fail(withLines(line({ unitPrice })))).toBe('Producto 1: el precio admite máximo 2 decimales.')
      }
      expect(fail({ ...base(), shipping: 1e-7 })).toBe('El envío admite máximo 2 decimales.')
      expect(fail({ ...base(), shipping: 0.000001 })).toBe('El envío admite máximo 2 decimales.')
    })

    it('rechaza una fracción de centavo también en importes grandes', () => {
      expect(fail(withLines(line({ unitPrice: 99999999.9901 })))).toBe(
        'Producto 1: el precio admite máximo 2 decimales.',
      )
      expect(fail(withLines(line({ unitPrice: 12345678.001 })))).toContain('2 decimales')
    })

    it('acepta el ruido típico de sumas y productos de coma flotante', () => {
      const noisy: [number, number][] = [
        [0.1 + 0.2, 0.3],
        [0.1 * 3, 0.3],
        [1.1 * 3, 3.3],
        [4.35 * 100 / 100, 4.35],
        [0.07, 0.07],
        [0.1 + 0.7, 0.8],
        [33333333.33 * 3, 99999999.99],
        [19.99 * 3, 59.97],
        [1234567.89 + 0.01, 1234567.9],
      ]
      for (const [input, expected] of noisy) {
        expect(ok(withLines(line({ unitPrice: input, quantity: 1 }))).items[0].unitPrice).toBe(expected)
      }
    })
  })

  it('el mensaje indica el número de la línea con error', () => {
    expect(fail(withLines(line(), line(), line({ quantity: 0 })))).toMatch(/^Producto 3:/)
  })

  it('normaliza el precio recibido (sin ruido de coma flotante)', () => {
    expect(ok(withLines(line({ unitPrice: 19.990000000000002 }))).items[0].unitPrice).toBe(19.99)
  })
})

describe('validateOrderCreate — envío', () => {
  it('por defecto es 0; acepta 0 y valores con 2 decimales', () => {
    expect(ok({ ...base(), shipping: null }).shipping).toBe(0)
    expect(ok({ ...base(), shipping: 0 }).shipping).toBe(0)
    expect(ok({ ...base(), shipping: 9500.25 }).shipping).toBe(9500.25)
  })

  it('rechaza negativos, no numéricos, más de 2 decimales y pasarse del máximo', () => {
    expect(fail({ ...base(), shipping: -1 })).toBe('El envío no puede ser negativo.')
    expect(fail({ ...base(), shipping: '5000' })).toBe('El envío debe ser un número.')
    expect(fail({ ...base(), shipping: NaN })).toBe('El envío debe ser un número.')
    expect(fail({ ...base(), shipping: 1.234 })).toBe('El envío admite máximo 2 decimales.')
    expect(fail({ ...base(), shipping: 100000000 })).toBe('El envío no puede pasar de 99.999.999,99.')
    expect(ok({ ...base(), shipping: 99999999.99 }).shipping).toBe(99999999.99)
  })
})

describe('validateOrderCreate — tope del total', () => {
  it('50 líneas al máximo no caben en numeric(12,2): se rechaza con un mensaje claro', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, quantity: 9999, unitPrice: 99999999.99 }))
    expect(fail({ contactId: CONTACT, items })).toBe(
      'El total del pedido no puede pasar de 9.999.999.999,99.',
    )
  })

  it('el total exacto del máximo pasa; un centavo más no', () => {
    // 9.999.999.999,99 = 99.999.999,99 × 99 + 99.999.999,99 → usamos líneas y envío.
    const max = ORDER_LIMITS.totalMaxCents
    const ok1 = {
      contactId: CONTACT,
      items: [{ name: 'A', quantity: 100, unitPrice: 99999999.99 }],
    }
    // 100 × 99.999.999,99 = 9.999.999.999,00 → + envío 0,99 = 9.999.999.999,99
    expect(ok({ ...ok1, shipping: 0.99 }).shipping).toBe(0.99)
    expect(toCents(99999999.99) * 100 + toCents(0.99)).toBe(max)
    expect(fail({ ...ok1, shipping: 1 })).toContain('9.999.999.999,99')
  })
})

describe('validateOrderCreate — pagado', () => {
  it('es falso por defecto y acepta solo booleanos', () => {
    expect(ok({ ...base(), paid: true }).paid).toBe(true)
    expect(ok({ ...base(), paid: false }).paid).toBe(false)
    expect(ok({ ...base(), paid: null }).paid).toBe(false)
    for (const paid of ['true', 1, 0, 'si', {}]) {
      expect(fail({ ...base(), paid })).toBe('Indica si el pedido ya está pagado (sí o no).')
    }
  })
})

describe('validateOrderCreate — textos opcionales', () => {
  it('vacíos o solo espacios quedan en null', () => {
    const v = ok({ ...base(), city: '   ', address: '', idNumber: null, notes: undefined })
    expect(v).toMatchObject({ city: null, address: null, idNumber: null, notes: null })
  })

  it('respeta los topes (ciudad 80, dirección 200, cédula 20, notas 500)', () => {
    expect(ok({ ...base(), city: 'c'.repeat(80) }).city).toHaveLength(80)
    expect(fail({ ...base(), city: 'c'.repeat(81) })).toBe('La ciudad no puede pasar de 80 caracteres.')
    expect(ok({ ...base(), address: 'a'.repeat(200) }).address).toHaveLength(200)
    expect(fail({ ...base(), address: 'a'.repeat(201) })).toBe('La dirección no puede pasar de 200 caracteres.')
    expect(ok({ ...base(), idNumber: '1'.repeat(20) }).idNumber).toHaveLength(20)
    expect(fail({ ...base(), idNumber: '1'.repeat(21) })).toBe('La cédula no puede pasar de 20 caracteres.')
    expect(ok({ ...base(), notes: 'n'.repeat(500) }).notes).toHaveLength(500)
    expect(fail({ ...base(), notes: 'n'.repeat(501) })).toBe('Las notas no pueden pasar de 500 caracteres.')
  })

  it('el tope se mide después de recortar', () => {
    expect(ok({ ...base(), city: ` ${'c'.repeat(80)} ` }).city).toHaveLength(80)
  })

  it('exige texto cuando el valor no es null/undefined', () => {
    expect(fail({ ...base(), city: 5 })).toBe('La ciudad debe ser texto.')
    expect(fail({ ...base(), address: {} })).toBe('La dirección debe ser texto.')
    expect(fail({ ...base(), idNumber: 123 })).toBe('La cédula debe ser texto.')
    expect(fail({ ...base(), notes: ['x'] })).toBe('Las notas deben ser texto.')
  })

  it('ciudad y dirección rechazan caracteres de control y de formato', () => {
    expect(fail({ ...base(), city: 'Ca\nli' })).toBe('La ciudad tiene caracteres no permitidos.')
    expect(fail({ ...base(), address: 'Calle​5' })).toBe('La dirección tiene caracteres no permitidos.')
    expect(fail({ ...base(), address: 'Calle\u0000' })).toBe('La dirección tiene caracteres no permitidos.')
  })

  it('las notas conservan saltos de línea (CRLF se normaliza) pero rechazan otros controles', () => {
    expect(ok({ ...base(), notes: 'Línea 1\r\nLínea 2\tfin' }).notes).toBe('Línea 1\nLínea 2\tfin')
    expect(fail({ ...base(), notes: 'x\u0007y' })).toBe('Las notas tienen caracteres no permitidos.')
    expect(fail({ ...base(), notes: 'x​y' })).toBe('Las notas tienen caracteres no permitidos.')
  })

  it('las notas con tabuladores y saltos cuentan para el tope', () => {
    expect(fail({ ...base(), notes: 'n\n'.repeat(251) })).toContain('500 caracteres')
  })

  describe('cédula', () => {
    it('un salto de línea cuenta como carácter no permitido', () => {
      expect(fail({ ...base(), idNumber: '12\n34' })).toBe('La cédula tiene caracteres no permitidos.')
    })

    it.each(['1234567890', '1.234.567-8', 'AB123456', 'a-b.c'])('acepta %s', (idNumber) => {
      expect(ok({ ...base(), idNumber }).idNumber).toBe(idNumber)
    })

    it.each(['123 456', '12/34', '12_34', '<script>', '１２３', 'cédula'])(
      'rechaza %s',
      (idNumber) => {
        expect(fail({ ...base(), idNumber })).toBe(
          'La cédula solo admite letras, números, puntos y guiones.',
        )
      },
    )
  })
})

describe('toCents / fromCents / orderTotals', () => {
  it('convierte a centavos enteros sin perder precisión', () => {
    expect(toCents(0.1 + 0.2)).toBe(30)
    expect(toCents(19.99)).toBe(1999)
    expect(toCents(0)).toBe(0)
    expect(Object.is(toCents(-0), 0)).toBe(true)
    expect(toCents(99999999.99)).toBe(9999999999)
    expect(fromCents(1999)).toBe(19.99)
    expect(fromCents(30)).toBe(0.3)
  })

  it('suma líneas y envío en centavos (0.1 + 0.2 = 0.3, no 0.30000000000000004)', () => {
    const t = orderTotals(
      [
        { quantity: 1, unitPrice: 0.1 },
        { quantity: 1, unitPrice: 0.2 },
      ],
      0,
    )
    expect(t).toEqual({
      subtotalCents: 30,
      shippingCents: 0,
      totalCents: 30,
      subtotal: 0.3,
      shipping: 0,
      total: 0.3,
    })
  })

  it('multiplica cantidad por precio unitario y suma el envío', () => {
    const t = orderTotals(
      [
        { quantity: 3, unitPrice: 19.99 },
        { quantity: 2, unitPrice: 50000 },
      ],
      12000.5,
    )
    expect(t.subtotalCents).toBe(3 * 1999 + 2 * 5000000)
    expect(t.subtotal).toBe(100059.97)
    expect(t.shipping).toBe(12000.5)
    expect(t.total).toBe(112060.47)
    expect(t.totalCents).toBe(t.subtotalCents + t.shippingCents)
  })

  it('un pedido vacío vale 0 más el envío', () => {
    expect(orderTotals([], 5).total).toBe(5)
    expect(orderTotals([], 0).total).toBe(0)
  })

  it('el resultado es siempre un entero en centavos (sin residuos de coma flotante)', () => {
    for (const price of [0.07, 0.29, 1.1, 4.35, 8.2, 19.99, 33.33, 1234567.89]) {
      for (const qty of [1, 3, 7, 99, 9999]) {
        const t = orderTotals([{ quantity: qty, unitPrice: price }], 0)
        expect(Number.isInteger(t.totalCents)).toBe(true)
        expect(t.totalCents).toBe(qty * Math.round(price * 100))
      }
    }
  })

  it('al límite del total sigue siendo un entero seguro', () => {
    const t = orderTotals([{ quantity: 100, unitPrice: 99999999.99 }], 0.99)
    expect(t.totalCents).toBe(ORDER_LIMITS.totalMaxCents)
    expect(Number.isSafeInteger(t.totalCents)).toBe(true)
    expect(t.total).toBe(9999999999.99)
  })
})

describe('applyOrderAction', () => {
  const NOW = new Date('2026-10-23T15:30:00.000Z')
  const state = (
    status: OrderState['status'],
    payment_status: OrderState['payment_status'] = 'pending',
    place: { city?: string | null; address?: string | null } = { city: 'Bogotá', address: 'Calle 1 # 2-3' },
  ): OrderState => ({
    status,
    payment_status,
    ...place,
  })
  const ship = { carrier: 'Servientrega', tracking_number: 'GU123456' }

  function applied(order: OrderState, action: OrderAction | string, extra = {}) {
    const r = applyOrderAction(order, action, extra, NOW)
    if (!r.ok) throw new Error(`esperaba ok, vino: ${r.message}`)
    return r
  }
  function refused(order: OrderState, action: OrderAction | string, extra = {}) {
    const r = applyOrderAction(order, action, extra, NOW)
    if (r.ok) throw new Error('esperaba error y salió ok')
    return r.message
  }

  describe('mark_paid', () => {
    it('pending → paid con paid_at, en cualquier estado no cancelado', () => {
      for (const status of ['new', 'shipped', 'delivered'] as const) {
        const r = applied(state(status), 'mark_paid')
        expect(r).toEqual({
          ok: true,
          changed: true,
          notice: 'paid',
          patch: { payment_status: 'paid', paid_at: '2026-10-23T15:30:00.000Z' },
        })
      }
    })

    it('ya pagado: no cambia nada y no pide aviso (idempotente)', () => {
      const r = applied(state('new', 'paid'), 'mark_paid')
      expect(r).toEqual({ ok: true, changed: false, notice: null, patch: {} })
      const again = applied(state('shipped', 'paid'), 'mark_paid')
      expect(again.changed).toBe(false)
      expect(again.patch).toEqual({})
    })

    it('un pedido cancelado no se marca pagado', () => {
      expect(refused(state('cancelled'), 'mark_paid')).toBe(
        'Un pedido cancelado no se puede marcar como pagado.',
      )
      expect(refused(state('cancelled', 'paid'), 'mark_paid')).toBe(
        'Un pedido cancelado no se puede marcar como pagado.',
      )
    })

    it('no toca el estado de envío', () => {
      expect(applied(state('shipped'), 'mark_paid').patch).not.toHaveProperty('status')
    })
  })

  describe('mark_shipped', () => {
    it('new → shipped con transportadora, guía y shipped_at', () => {
      expect(applied(state('new', 'paid'), 'mark_shipped', ship)).toEqual({
        ok: true,
        changed: true,
        notice: 'shipped',
        patch: {
          status: 'shipped',
          shipped_at: '2026-10-23T15:30:00.000Z',
          carrier: 'Servientrega',
          tracking_number: 'GU123456',
        },
      })
    })

    it('se puede enviar sin haber cobrado (contra entrega)', () => {
      expect(applied(state('new', 'pending'), 'mark_shipped', ship).patch.status).toBe('shipped')
    })

    it('recorta transportadora y guía', () => {
      const r = applied(state('new'), 'mark_shipped', { carrier: '  Coordinadora ', tracking_number: ' 77 ' })
      expect(r.patch).toMatchObject({ carrier: 'Coordinadora', tracking_number: '77' })
    })

    it('exige transportadora y guía', () => {
      expect(refused(state('new'), 'mark_shipped', {})).toBe('Escribe la transportadora.')
      expect(refused(state('new'), 'mark_shipped', { carrier: '   ', tracking_number: 'x' })).toBe(
        'Escribe la transportadora.',
      )
      expect(refused(state('new'), 'mark_shipped', { carrier: 'Envía' })).toBe('Escribe el número de guía.')
      expect(refused(state('new'), 'mark_shipped', { carrier: 'Envía', tracking_number: '' })).toBe(
        'Escribe el número de guía.',
      )
      expect(refused(state('new'), 'mark_shipped', { carrier: 5, tracking_number: 'x' })).toBe(
        'Escribe la transportadora.',
      )
    })

    describe('ciudad y dirección de envío', () => {
      const noPlace = { city: null, address: null }

      it('exige ciudad y dirección en el pedido', () => {
        expect(refused(state('new', 'paid', noPlace), 'mark_shipped', ship)).toBe('Escribe la ciudad de envío.')
        expect(refused(state('new', 'paid', { city: 'Bogotá', address: null }), 'mark_shipped', ship)).toBe(
          'Escribe la dirección de envío.',
        )
        expect(refused(state('new', 'paid', { city: null, address: 'Calle 1' }), 'mark_shipped', ship)).toBe(
          'Escribe la ciudad de envío.',
        )
      })

      it('un pedido sin esos campos en el objeto (undefined) también los pide', () => {
        expect(refused(state('new', 'paid', {}), 'mark_shipped', ship)).toBe('Escribe la ciudad de envío.')
      })

      it('solo espacios cuenta como vacío', () => {
        expect(refused(state('new', 'paid', { city: '   ', address: 'x' }), 'mark_shipped', ship)).toBe(
          'Escribe la ciudad de envío.',
        )
        expect(
          refused(state('new', 'paid', noPlace), 'mark_shipped', { ...ship, city: '  ', address: '  ' }),
        ).toBe('Escribe la ciudad de envío.')
      })

      it('los acepta por extra cuando faltan y los incluye en el parche', () => {
        const r = applied(state('new', 'paid', noPlace), 'mark_shipped', {
          ...ship,
          city: ' Medellín ',
          address: ' Carrera 7 # 8-9 ',
        })
        expect(r.patch).toEqual({
          status: 'shipped',
          shipped_at: '2026-10-23T15:30:00.000Z',
          carrier: 'Servientrega',
          tracking_number: 'GU123456',
          city: 'Medellín',
          address: 'Carrera 7 # 8-9',
        })
      })

      it('completa solo lo que falta: ciudad en el pedido, dirección por extra', () => {
        const r = applied(state('new', 'paid', { city: 'Bogotá', address: null }), 'mark_shipped', {
          ...ship,
          address: 'Calle 9',
        })
        expect(r.patch).toMatchObject({ address: 'Calle 9' })
        expect(r.patch).not.toHaveProperty('city')
      })

      it('si el pedido ya los tiene y no llegan por extra, el parche no los toca', () => {
        const r = applied(state('new'), 'mark_shipped', ship)
        expect(r.patch).not.toHaveProperty('city')
        expect(r.patch).not.toHaveProperty('address')
      })

      it('lo que llega por extra corrige al pedido (queda en el parche)', () => {
        const r = applied(state('new'), 'mark_shipped', { ...ship, city: 'Cartagena' })
        expect(r.patch).toMatchObject({ city: 'Cartagena' })
      })

      it('respeta los topes: ciudad 80, dirección 200', () => {
        const r = applied(state('new', 'paid', noPlace), 'mark_shipped', {
          ...ship,
          city: 'c'.repeat(80),
          address: 'a'.repeat(200),
        })
        expect(r.patch.city).toHaveLength(80)
        expect(r.patch.address).toHaveLength(200)
        expect(refused(state('new'), 'mark_shipped', { ...ship, city: 'c'.repeat(81) })).toBe(
          'La ciudad no puede pasar de 80 caracteres.',
        )
        expect(refused(state('new'), 'mark_shipped', { ...ship, address: 'a'.repeat(201) })).toBe(
          'La dirección no puede pasar de 200 caracteres.',
        )
      })

      it('rechaza lo que no es texto y los caracteres de control', () => {
        expect(refused(state('new'), 'mark_shipped', { ...ship, city: 5 })).toBe('La ciudad debe ser texto.')
        expect(refused(state('new'), 'mark_shipped', { ...ship, address: {} })).toBe('La dirección debe ser texto.')
        expect(refused(state('new'), 'mark_shipped', { ...ship, city: 'Bo\ngotá' })).toBe(
          'La ciudad tiene caracteres no permitidos.',
        )
        expect(refused(state('new'), 'mark_shipped', { ...ship, address: 'Calle​1' })).toBe(
          'La dirección tiene caracteres no permitidos.',
        )
      })

      it('transportadora y guía se piden antes que la ciudad', () => {
        expect(refused(state('new', 'paid', noPlace), 'mark_shipped', {})).toBe('Escribe la transportadora.')
        expect(refused(state('new', 'paid', noPlace), 'mark_shipped', { carrier: 'Envía' })).toBe(
          'Escribe el número de guía.',
        )
      })

      it('el estado del pedido gana sobre los datos faltantes', () => {
        expect(refused(state('delivered', 'paid', noPlace), 'mark_shipped', {})).toBe('El pedido ya fue entregado.')
      })
    })

    it('ambos hasta 60 caracteres', () => {
      const r = applied(state('new'), 'mark_shipped', { carrier: 'c'.repeat(60), tracking_number: 't'.repeat(60) })
      expect(r.patch.carrier).toHaveLength(60)
      expect(refused(state('new'), 'mark_shipped', { carrier: 'c'.repeat(61), tracking_number: 't' })).toBe(
        'La transportadora no puede pasar de 60 caracteres.',
      )
      expect(refused(state('new'), 'mark_shipped', { carrier: 'c', tracking_number: 't'.repeat(61) })).toBe(
        'El número de guía no puede pasar de 60 caracteres.',
      )
    })

    it('rechaza caracteres de control y de formato', () => {
      expect(refused(state('new'), 'mark_shipped', { carrier: 'Ser\nvi', tracking_number: 'x' })).toBe(
        'La transportadora tiene caracteres no permitidos.',
      )
      expect(refused(state('new'), 'mark_shipped', { carrier: 'Servi', tracking_number: 'x​y' })).toBe(
        'El número de guía tiene caracteres no permitidos.',
      )
    })

    it.each([
      ['shipped', 'El pedido ya fue marcado como enviado.'],
      ['delivered', 'El pedido ya fue entregado.'],
      ['cancelled', 'El pedido está cancelado.'],
    ] as const)('desde %s no se puede', (status, message) => {
      expect(refused(state(status), 'mark_shipped', ship)).toBe(message)
    })

    it('con un estado inválido gana el error de estado sobre el de datos', () => {
      expect(refused(state('delivered'), 'mark_shipped', {})).toBe('El pedido ya fue entregado.')
    })
  })

  describe('mark_delivered', () => {
    it('shipped → delivered con delivered_at', () => {
      expect(applied(state('shipped', 'paid'), 'mark_delivered')).toEqual({
        ok: true,
        changed: true,
        notice: 'delivered',
        patch: { status: 'delivered', delivered_at: '2026-10-23T15:30:00.000Z' },
      })
    })

    it('se puede entregar un pedido sin cobrar (queda pendiente por cobrar)', () => {
      const r = applied(state('shipped', 'pending'), 'mark_delivered')
      expect(r.patch).not.toHaveProperty('payment_status')
    })

    describe('retiro en tienda / entrega local (new → delivered)', () => {
      it('se puede entregar directo desde new, con aviso de entrega', () => {
        expect(applied(state('new', 'paid'), 'mark_delivered')).toEqual({
          ok: true,
          changed: true,
          notice: 'delivered',
          patch: { status: 'delivered', delivered_at: '2026-10-23T15:30:00.000Z' },
        })
      })

      it('no pide ciudad, dirección, transportadora ni guía', () => {
        const r = applied(state('new', 'paid', { city: null, address: null }), 'mark_delivered', {})
        expect(r.patch).not.toHaveProperty('shipped_at')
        expect(r.patch).not.toHaveProperty('carrier')
        expect(r.patch).not.toHaveProperty('tracking_number')
        expect(r.patch).not.toHaveProperty('city')
      })

      it('sin cobrar también (queda pendiente por cobrar, y el cobro se marca aparte)', () => {
        const r = applied(state('new', 'pending', {}), 'mark_delivered')
        expect(r.patch).not.toHaveProperty('payment_status')
        expect(pipelineStageFor({ status: 'delivered', payment_status: 'pending' })).toBe('Entregado')
      })

      it('después de entregado ya no se envía, ni se cancela, ni se entrega otra vez', () => {
        const delivered = state('delivered', 'paid')
        expect(applyOrderAction(delivered, 'mark_shipped', ship, NOW).ok).toBe(false)
        expect(applyOrderAction(delivered, 'cancel', {}, NOW).ok).toBe(false)
        expect(applyOrderAction(delivered, 'mark_delivered', {}, NOW).ok).toBe(false)
      })

      it('el camino corto new → paid → delivered encadena', () => {
        let order = state('new')
        for (const action of ['mark_paid', 'mark_delivered'] as const) {
          const r = applied(order, action)
          order = { ...order, ...(r.patch as Partial<OrderState>) }
        }
        expect(order).toMatchObject({ status: 'delivered', payment_status: 'paid' })
      })
    })

    it.each([
      ['delivered', 'El pedido ya fue entregado.'],
      ['cancelled', 'El pedido está cancelado.'],
    ] as const)('desde %s no se puede', (status, message) => {
      expect(refused(state(status), 'mark_delivered')).toBe(message)
    })
  })

  describe('cancel', () => {
    it.each(['new', 'shipped'] as const)('%s → cancelled con cancelled_at y sin aviso', (status) => {
      expect(applied(state(status), 'cancel')).toEqual({
        ok: true,
        changed: true,
        notice: null,
        patch: { status: 'cancelled', cancelled_at: '2026-10-23T15:30:00.000Z' },
      })
    })

    it('no toca el pago (un pedido pagado y cancelado sigue marcado como pagado)', () => {
      expect(applied(state('new', 'paid'), 'cancel').patch).not.toHaveProperty('payment_status')
    })

    it('un pedido entregado o cancelado no se reabre ni se cancela', () => {
      expect(refused(state('delivered', 'paid'), 'cancel')).toBe('Un pedido entregado no se puede cancelar.')
      expect(refused(state('cancelled'), 'cancel')).toBe('El pedido ya está cancelado.')
    })
  })

  it('un pedido entregado o cancelado no admite ninguna acción de estado', () => {
    for (const action of ['mark_shipped', 'mark_delivered', 'cancel'] as const) {
      expect(applyOrderAction(state('delivered', 'paid'), action, ship, NOW).ok).toBe(false)
      expect(applyOrderAction(state('cancelled', 'paid'), action, ship, NOW).ok).toBe(false)
    }
  })

  it('una acción desconocida se rechaza', () => {
    expect(refused(state('new'), 'refund')).toBe('La acción no es válida.')
    expect(refused(state('new'), '')).toBe('La acción no es válida.')
    expect(applyOrderAction(state('new'), undefined as unknown as string, {}, NOW).ok).toBe(false)
  })

  it('no muta el pedido recibido', () => {
    const order = Object.freeze(state('new'))
    expect(() => applyOrderAction(order, 'mark_paid', {}, NOW)).not.toThrow()
  })

  it('usa la hora actual cuando no se le pasa', () => {
    const before = Date.now()
    const r = applyOrderAction(state('new'), 'mark_paid')
    if (!r.ok || !r.patch.paid_at) throw new Error('esperaba ok')
    const at = Date.parse(r.patch.paid_at)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('el camino feliz completo encadena sin saltos', () => {
    let order = state('new')
    const steps: [OrderAction, object][] = [
      ['mark_paid', {}],
      ['mark_shipped', ship],
      ['mark_delivered', {}],
    ]
    for (const [action, extra] of steps) {
      const r = applied(order, action, extra)
      order = { ...order, ...(r.patch as Partial<OrderState>) }
    }
    expect(order).toMatchObject({ status: 'delivered', payment_status: 'paid' })
    // y desde ahí nada más es posible
    expect(applyOrderAction(order, 'cancel', {}, NOW).ok).toBe(false)
  })
})

describe('applyOrderAction — razón del rechazo', () => {
  const NOW = new Date('2026-10-23T15:30:00.000Z')
  const place = { city: 'Bogotá', address: 'Calle 1' }
  const reasonOf = (
    order: Pick<OrderState, 'status' | 'payment_status'>,
    action: string,
    extra = {},
  ) => {
    const r = applyOrderAction({ ...order, ...place }, action, extra, NOW)
    if (r.ok) throw new Error('esperaba rechazo')
    return r.reason
  }

  it('un pedido en estado final o ya movido es "transition" (el estado no lo permite)', () => {
    expect(reasonOf({ status: 'cancelled', payment_status: 'pending' }, 'mark_paid')).toBe('transition')
    expect(reasonOf({ status: 'shipped', payment_status: 'paid' }, 'mark_shipped')).toBe('transition')
    expect(reasonOf({ status: 'delivered', payment_status: 'paid' }, 'mark_shipped')).toBe('transition')
    expect(reasonOf({ status: 'cancelled', payment_status: 'paid' }, 'mark_shipped')).toBe('transition')
    expect(reasonOf({ status: 'delivered', payment_status: 'paid' }, 'mark_delivered')).toBe('transition')
    expect(reasonOf({ status: 'cancelled', payment_status: 'paid' }, 'mark_delivered')).toBe('transition')
    expect(reasonOf({ status: 'delivered', payment_status: 'paid' }, 'cancel')).toBe('transition')
    expect(reasonOf({ status: 'cancelled', payment_status: 'paid' }, 'cancel')).toBe('transition')
  })

  it('datos que faltan o están mal, o una acción desconocida, son "invalid"', () => {
    const open = { status: 'new', payment_status: 'pending' } as const
    expect(reasonOf(open, 'mark_shipped', {})).toBe('invalid')
    expect(reasonOf(open, 'mark_shipped', { carrier: 'X' })).toBe('invalid')
    expect(reasonOf(open, 'mark_shipped', { carrier: 5, tracking_number: 'x' })).toBe('invalid')
    expect(reasonOf(open, 'volar')).toBe('invalid')
  })
})

describe('dealStatusFor', () => {
  const cases: [OrderState['status'], 'open' | 'won' | 'lost'][] = [
    ['new', 'open'],
    ['shipped', 'open'],
    ['delivered', 'won'],
    ['cancelled', 'lost'],
  ]
  it.each(cases)('%s → %s (sin importar el pago)', (status, expected) => {
    expect(dealStatusFor({ status })).toBe(expected)
  })
})

describe('pipelineStageFor', () => {
  const cases: [OrderState, string][] = [
    [{ status: 'new', payment_status: 'pending' }, 'Pago pendiente'],
    [{ status: 'new', payment_status: 'paid' }, 'Pagado'],
    [{ status: 'shipped', payment_status: 'pending' }, 'Enviado'],
    [{ status: 'shipped', payment_status: 'paid' }, 'Enviado'],
    [{ status: 'delivered', payment_status: 'pending' }, 'Entregado'],
    [{ status: 'delivered', payment_status: 'paid' }, 'Entregado'],
    [{ status: 'cancelled', payment_status: 'pending' }, 'Cancelado'],
    [{ status: 'cancelled', payment_status: 'paid' }, 'Cancelado'],
  ]
  it.each(cases)('%j → %s', (order, stage) => {
    expect(pipelineStageFor(order)).toBe(stage)
  })

  it('las etapas del pipeline están en el orden del diseño y cubren todo lo que devuelve el mapeo', () => {
    expect(SALES_STAGES).toEqual(['Nuevo', 'Pago pendiente', 'Pagado', 'Enviado', 'Entregado', 'Cancelado'])
    for (const [order] of cases) expect(SALES_STAGES).toContain(pipelineStageFor(order))
  })
})

describe('isCountedSale — "vendido este mes"', () => {
  it('cuenta lo cobrado y no cancelado', () => {
    expect(isCountedSale({ status: 'new', payment_status: 'paid' })).toBe(true)
    expect(isCountedSale({ status: 'shipped', payment_status: 'paid' })).toBe(true)
    expect(isCountedSale({ status: 'delivered', payment_status: 'paid' })).toBe(true)
  })

  it('no cuenta lo pendiente de pago', () => {
    for (const status of ['new', 'shipped', 'delivered'] as const) {
      expect(isCountedSale({ status, payment_status: 'pending' })).toBe(false)
    }
  })

  it('no cuenta lo cancelado, aunque se hubiera cobrado', () => {
    expect(isCountedSale({ status: 'cancelled', payment_status: 'paid' })).toBe(false)
    expect(isCountedSale({ status: 'cancelled', payment_status: 'pending' })).toBe(false)
  })

  it('el mes se mide por paid_at en la zona horaria de Bogotá', () => {
    expect(SALES_TIME_ZONE).toBe('America/Bogota')
  })
})

describe('noticeFor / isOrderAction', () => {
  it('cada acción de estado avisa al cliente, salvo cancelar', () => {
    expect(noticeFor('mark_paid')).toBe('paid')
    expect(noticeFor('mark_shipped')).toBe('shipped')
    expect(noticeFor('mark_delivered')).toBe('delivered')
    expect(noticeFor('cancel')).toBeNull()
  })

  it('isOrderAction solo acepta las 4 acciones', () => {
    for (const a of ORDER_ACTIONS) expect(isOrderAction(a)).toBe(true)
    expect(ORDER_ACTIONS).toHaveLength(4)
    for (const x of ['', 'refund', null, undefined, 5, 'MARK_PAID']) expect(isOrderAction(x)).toBe(false)
  })
})
