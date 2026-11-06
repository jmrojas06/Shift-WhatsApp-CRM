import { describe, expect, it } from 'vitest'

import { bogotaMonthRange } from './usage'

// ============================================================
// Mes de calendario de Bogotá para contar el uso de llamadas.
// ============================================================

describe('bogotaMonthRange', () => {
  it('toma el mes de la hora de Bogotá, no el del servidor (UTC)', () => {
    // 1 dic 03:00 UTC = 30 nov 22:00 en Bogotá: todavía es noviembre.
    const range = bogotaMonthRange(new Date('2026-12-01T03:00:00Z'))

    expect(range.month).toBe('2026-11')
    expect(range.start.toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-12-01T05:00:00.000Z')
  })

  it('a las 00:00 del día 1 en Bogotá ya es el mes nuevo', () => {
    const range = bogotaMonthRange(new Date('2026-12-01T05:00:00Z'))

    expect(range.month).toBe('2026-12')
    expect(range.start.toISOString()).toBe('2026-12-01T05:00:00.000Z')
  })

  it('en diciembre el fin cae el 1 de enero del año siguiente', () => {
    const range = bogotaMonthRange(new Date('2026-12-15T15:00:00Z'))

    expect(range.month).toBe('2026-12')
    expect(range.end.toISOString()).toBe('2027-01-01T05:00:00.000Z')
  })

  it('a mitad de mes devuelve el mes completo', () => {
    const range = bogotaMonthRange(new Date('2026-11-05T12:00:00Z'))

    expect(range.month).toBe('2026-11')
    expect(range.start.toISOString()).toBe('2026-11-01T05:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-12-01T05:00:00.000Z')
  })
})
