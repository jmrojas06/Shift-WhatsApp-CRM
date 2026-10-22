import { describe, expect, it } from 'vitest'

import { formatDayLabel, formatLongDate, formatPrice, formatTimeLabel, truncate } from './format'

// ============================================================
// Etiquetas humanas (es-CO) — deterministas, sin Intl de fechas.
// ============================================================

describe('formatTimeLabel', () => {
  it('formatea la hora en formato de 12 horas, estilo WhatsApp', () => {
    expect(formatTimeLabel({ hour: 9, minute: 0 })).toBe('9:00 a. m.')
    expect(formatTimeLabel({ hour: 12, minute: 0 })).toBe('12:00 p. m.')
    expect(formatTimeLabel({ hour: 14, minute: 30 })).toBe('2:30 p. m.')
    expect(formatTimeLabel({ hour: 0, minute: 5 })).toBe('12:05 a. m.')
    expect(formatTimeLabel({ hour: 23, minute: 59 })).toBe('11:59 p. m.')
  })
})

describe('formatDayLabel / formatLongDate', () => {
  it('etiqueta corta para menús: "mar 20 oct"', () => {
    expect(formatDayLabel('2026-10-20')).toBe('mar 20 oct')
    expect(formatDayLabel('2026-10-18')).toBe('dom 18 oct')
    expect(formatDayLabel('2027-01-01')).toBe('vie 1 ene')
  })

  it('etiqueta larga para el resumen: "martes 20 de octubre de 2026"', () => {
    expect(formatLongDate('2026-10-20')).toBe('martes 20 de octubre de 2026')
    expect(formatLongDate('2026-10-18')).toBe('domingo 18 de octubre de 2026')
  })
})

describe('formatPrice / truncate', () => {
  it('formatea pesos con separador de miles colombiano', () => {
    expect(formatPrice(25000, 'COP')).toBe('$25.000')
    expect(formatPrice(15000, 'COP')).toBe('$15.000')
    expect(formatPrice(1000000, 'COP')).toBe('$1.000.000')
  })

  it('usa el símbolo de otras monedas conocidas y el código como último recurso', () => {
    expect(formatPrice(40, 'USD')).toBe('US$40')
    expect(formatPrice(40, 'EUR')).toBe('€40')
    expect(formatPrice(40, 'CHF')).toBe('CHF 40')
  })

  it('truncate recorta con puntos suspensivos solo cuando hace falta', () => {
    expect(truncate('Corte clásico', 20)).toBe('Corte clásico')
    expect(truncate('Perfilado de barba premium', 20)).toBe('Perfilado de barba…')
    expect(truncate('1234567890', 10)).toBe('1234567890')
  })

  it('truncate mide unidades UTF-16 y no parte un emoji por la mitad', () => {
    const out = truncate('Corte \u{1F485}\u{1F485}\u{1F485}\u{1F485}', 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out).toBe('Corte \u{1F485}…')
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    // un texto que ya cabe (en unidades UTF-16) no se toca
    expect(truncate('\u{1F485}\u{1F485}', 4)).toBe('\u{1F485}\u{1F485}')
  })
})
