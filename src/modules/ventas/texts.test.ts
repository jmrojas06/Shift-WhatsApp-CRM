import { describe, expect, it } from 'vitest'

import { SALES_STAGES } from './orders'
import {
  NOTICE_TEMPLATES,
  VENTAS_TEXTS,
  buildNoticeTemplate,
  buildNoticeTemplateParams,
  buildNoticeText,
  dealTitle,
  formatMoney,
  noticeStatusText,
  orderLabel,
} from './texts'

describe('buildNoticeText — avisos al cliente (diseño §3.5)', () => {
  it('pagado', () => {
    expect(buildNoticeText('paid', { number: 1001, businessName: 'Águila Dorada' })).toBe(
      '¡Recibimos tu pago! Tu pedido #1001 está confirmado. Te avisamos cuando salga. 🙌',
    )
  })

  it('enviado, con transportadora y guía', () => {
    expect(
      buildNoticeText('shipped', { number: 1002, carrier: 'Servientrega', trackingNumber: 'GU123' }),
    ).toBe('Tu pedido #1002 salió 📦. Transportadora: Servientrega. Guía: GU123.')
  })

  it('entregado', () => {
    expect(buildNoticeText('delivered', { number: 1003 })).toBe(
      'Tu pedido #1003 fue entregado. ¡Gracias por comprarnos! 🙌',
    )
  })

  it('el número va sin separador de miles (es un identificador, no un monto)', () => {
    expect(buildNoticeText('delivered', { number: 12345 })).toContain('#12345')
  })

  it('enviado sin datos de guía no inventa nada', () => {
    expect(buildNoticeText('shipped', { number: 1002 })).toBe('Tu pedido #1002 salió 📦.')
    expect(buildNoticeText('shipped', { number: 1002, carrier: 'Envía' })).toBe(
      'Tu pedido #1002 salió 📦. Transportadora: Envía.',
    )
    expect(buildNoticeText('shipped', { number: 1002, trackingNumber: '77' })).toBe(
      'Tu pedido #1002 salió 📦. Guía: 77.',
    )
  })

  it('en el texto libre colapsa espacios y saltos de línea de los datos del negocio', () => {
    expect(
      buildNoticeText('shipped', { number: 1, carrier: '  Inter   Rapidísimo ', trackingNumber: '7 7' }),
    ).toBe('Tu pedido #1 salió 📦. Transportadora: Inter Rapidísimo. Guía: 7 7.')
  })
})

describe('plantillas de Meta (ventana de 24 h cerrada)', () => {
  it('los nombres son los de WhatsApp Manager', () => {
    expect(NOTICE_TEMPLATES).toEqual({
      paid: 'pedido_pagado',
      shipped: 'pedido_enviado',
      delivered: 'pedido_entregado',
    })
  })

  it('pedido_pagado: {{1}} negocio · {{2}} número', () => {
    expect(buildNoticeTemplateParams('paid', { number: 1001, businessName: 'Águila Dorada' })).toEqual([
      'Águila Dorada',
      '1001',
    ])
  })

  it('pedido_enviado: {{1}} número · {{2}} transportadora · {{3}} guía', () => {
    expect(
      buildNoticeTemplateParams('shipped', { number: 1002, carrier: 'Servientrega', trackingNumber: 'GU123' }),
    ).toEqual(['1002', 'Servientrega', 'GU123'])
  })

  it('pedido_entregado: {{1}} número', () => {
    expect(buildNoticeTemplateParams('delivered', { number: 1003 })).toEqual(['1003'])
  })

  it('Meta rechaza variables vacías, con saltos de línea, tabulaciones o 4+ espacios seguidos', () => {
    const params = buildNoticeTemplateParams('shipped', {
      number: 5,
      carrier: 'Inter\nRapidísimo\t  Express     S.A.',
      trackingNumber: '',
    })
    expect(params).toEqual(['5', 'Inter Rapidísimo Express S.A.', '-'])
    for (const p of params) {
      expect(p).not.toMatch(/[\n\t]/)
      expect(p).not.toMatch(/ {4}/)
      expect(p.length).toBeGreaterThan(0)
    }
  })

  it('sin nombre de negocio usa un genérico en vez de una variable vacía', () => {
    expect(buildNoticeTemplateParams('paid', { number: 1, businessName: '   ' })[0]).toBe('tu tienda')
    expect(buildNoticeTemplateParams('paid', { number: 1 })[0]).toBe('tu tienda')
    expect(buildNoticeTemplateParams('paid', { number: 1, businessName: null })[0]).toBe('tu tienda')
  })

  it('el nombre del negocio se recorta a 60 caracteres (puntos de código) para la variable {{1}}', () => {
    const long = 'N'.repeat(75)
    expect(buildNoticeTemplateParams('paid', { number: 1, businessName: long })[0]).toBe('N'.repeat(60))
    expect(buildNoticeTemplateParams('paid', { number: 1, businessName: 'N'.repeat(60) })[0]).toBe('N'.repeat(60))
    const emojis = buildNoticeTemplateParams('paid', { number: 1, businessName: '💍'.repeat(70) })[0]
    expect(Array.from(emojis)).toHaveLength(60)
    expect(emojis).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/) // sin medio emoji
  })

  it('el recorte no deja un espacio al final de la variable', () => {
    const name = `${'a'.repeat(59)} ${'b'.repeat(10)}`
    expect(buildNoticeTemplateParams('paid', { number: 1, businessName: name })[0]).toBe('a'.repeat(59))
  })

  it('el texto libre no recorta el nombre (el negocio no aparece ahí)', () => {
    expect(buildNoticeText('paid', { number: 1, businessName: 'N'.repeat(75) })).not.toContain('NNN')
  })

  it('buildNoticeTemplate junta nombre y variables', () => {
    expect(buildNoticeTemplate('delivered', { number: 1003 })).toEqual({
      name: 'pedido_entregado',
      params: ['1003'],
    })
    expect(buildNoticeTemplate('paid', { number: 1, businessName: 'X' })).toEqual({
      name: 'pedido_pagado',
      params: ['X', '1'],
    })
  })
})

describe('estado del aviso en el pedido', () => {
  it('sin aviso intentado no hay texto', () => {
    expect(noticeStatusText(null, false)).toBeNull()
  })

  it('enviado / no enviado, por tipo', () => {
    expect(noticeStatusText('paid', false)).toBe('Aviso de pago mandado')
    expect(noticeStatusText('shipped', false)).toBe('Aviso de envío mandado')
    expect(noticeStatusText('delivered', false)).toBe('Aviso de entrega mandado')
    expect(noticeStatusText('paid', true)).toBe('Aviso de pago: no se pudo mandar')
    expect(noticeStatusText('shipped', true)).toBe('Aviso de envío: no se pudo mandar')
    expect(noticeStatusText('delivered', true)).toBe('Aviso de entrega: no se pudo mandar')
  })
})

describe('etiquetas de pedido y dinero', () => {
  it('orderLabel y dealTitle', () => {
    expect(orderLabel(1001)).toBe('Pedido #1001')
    expect(dealTitle(1001)).toBe('Pedido #1001')
  })

  it('formatMoney: pesos enteros con puntos de miles', () => {
    expect(formatMoney(150000, 'COP')).toBe('$150.000')
    expect(formatMoney(0, 'COP')).toBe('$0')
    expect(formatMoney(1234567, 'COP')).toBe('$1.234.567')
  })

  it('formatMoney: muestra los centavos solo cuando existen (coma decimal)', () => {
    expect(formatMoney(12000.5, 'COP')).toBe('$12.000,50')
    expect(formatMoney(10.05, 'USD')).toBe('US$10,05')
    expect(formatMoney(0.3, 'COP')).toBe('$0,30')
    expect(formatMoney(99999999.99, 'COP')).toBe('$99.999.999,99')
  })

  it('formatMoney: no redondea hacia arriba un monto con centavos (0.1 + 0.2)', () => {
    expect(formatMoney(0.1 + 0.2, 'USD')).toBe('US$0,30')
    expect(formatMoney(19.99, 'EUR')).toBe('€19,99')
  })

  it('formatMoney: moneda desconocida usa el código', () => {
    expect(formatMoney(5, 'XYZ')).toBe('XYZ 5')
  })
})

describe('copy del panel', () => {
  const strings: string[] = []
  const walk = (value: unknown, out: string[]): void => {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'function') {
      // Funciones de copy: se prueban con argumentos de ejemplo.
      const fn = value as (...args: unknown[]) => unknown
      const result = fn('ejemplo', 1001)
      if (typeof result === 'string') out.push(result)
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v, out)
    }
  }
  walk(VENTAS_TEXTS, strings)

  it('tiene un buen puñado de textos y ninguno está vacío', () => {
    expect(strings.length).toBeGreaterThan(60)
    for (const s of strings) expect(s.trim().length).toBeGreaterThan(0)
  })

  it('es español neutro: sin voseo, sin "usted", sin la barbería ni la ciudad', () => {
    for (const s of strings) {
      expect(s).not.toMatch(/\b(vos|usted|ustedes|querés|tenés|podés)\b/i)
      expect(s).not.toMatch(/barber/i)
      expect(s).not.toMatch(/\bCali\b/)
    }
  })

  it('no promete lo que el producto no hace ni usa jerga técnica', () => {
    for (const s of strings) {
      expect(s).not.toMatch(/\b(webhook|payload|RLS|endpoint)\b/i)
      expect(s).not.toMatch(/\bagend/i)
    }
  })

  it('los filtros coinciden con el diseño §3.4', () => {
    expect(Object.keys(VENTAS_TEXTS.filters)).toEqual([
      'all',
      'pendingPayment',
      'toShip',
      'shipped',
      'delivered',
      'cancelled',
    ])
  })

  it('los nombres de estado y de etapa son los mismos que los del pipeline', () => {
    expect(VENTAS_TEXTS.status.cancelled).toBe('Cancelado')
    expect(VENTAS_TEXTS.status.delivered).toBe('Entregado')
    expect(VENTAS_TEXTS.status.shipped).toBe('Enviado')
    expect(VENTAS_TEXTS.payment.pending).toBe('Pago pendiente')
    expect(VENTAS_TEXTS.payment.paid).toBe('Pagado')
    expect(SALES_STAGES).toContain(VENTAS_TEXTS.status.new)
  })

  it('la cédula se presenta como opcional y de uso restringido', () => {
    expect(VENTAS_TEXTS.createOrder.idNumberLabel).toMatch(/opcional/i)
    expect(VENTAS_TEXTS.createOrder.idNumberHint).toMatch(/no se muestra/i)
  })

  it('cancelar pide confirmación y avisa que no se reabre', () => {
    expect(VENTAS_TEXTS.cancelDialog.title(1001)).toBe('¿Cancelar el pedido #1001?')
    expect(VENTAS_TEXTS.cancelDialog.body).toMatch(/no se puede reabrir/i)
  })

  it('textos con número', () => {
    expect(VENTAS_TEXTS.createOrder.created(1001)).toBe('Pedido #1001 creado.')
    expect(VENTAS_TEXTS.createOrder.removeLine(2)).toBe('Quitar producto 2')
    expect(VENTAS_TEXTS.readOnly('crear pedidos')).toBe('Solo lectura: tu rol no puede crear pedidos.')
  })
})
