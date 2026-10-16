import { describe, expect, it } from 'vitest'

import {
  addDaysToKey,
  BARBERIA_TZ,
  startOfZonedDay,
  weekdayOfKey,
  zonedDateKey,
  zonedParts,
  zonedTimeToUtc,
} from './time'

// ============================================================
// Helpers de zona horaria — America/Bogota.
//
// Bogotá no tiene horario de verano (UTC-5 fijo), pero los
// helpers son genéricos vía Intl: nunca usan la zona del
// sistema donde corren los tests.
// ============================================================

const TZ = BARBERIA_TZ

describe('zonedDateKey / zonedParts', () => {
  it('convierte un instante UTC a la fecha local de Bogotá', () => {
    // 02:30 UTC del 20 = 21:30 del 19 en Bogotá.
    expect(zonedDateKey(new Date('2026-10-20T02:30:00Z'), TZ)).toBe(
      '2026-10-19',
    )
    expect(zonedDateKey(new Date('2026-10-20T05:00:00Z'), TZ)).toBe(
      '2026-10-20',
    )
  })

  it('descompone hora y minuto locales (hora 24)', () => {
    expect(zonedParts(new Date('2026-10-20T14:00:00Z'), TZ)).toEqual({
      dateKey: '2026-10-20',
      weekday: 2,
      hour: 9,
      minute: 0,
    })
    // 00:00 local = 05:00 UTC del mismo día.
    expect(zonedParts(new Date('2026-10-20T05:00:00Z'), TZ)).toMatchObject({
      dateKey: '2026-10-20',
      hour: 0,
      minute: 0,
    })
    // 19:30 local = 00:30 UTC del día siguiente.
    expect(zonedParts(new Date('2026-10-21T00:30:00Z'), TZ)).toMatchObject({
      dateKey: '2026-10-20',
      hour: 19,
      minute: 30,
    })
  })
})

describe('zonedTimeToUtc / startOfZonedDay', () => {
  it('convierte una hora local a su instante UTC', () => {
    expect(zonedTimeToUtc('2026-10-20', '09:00', TZ).toISOString()).toBe(
      '2026-10-20T14:00:00.000Z',
    )
    expect(zonedTimeToUtc('2026-10-20', '19:30', TZ).toISOString()).toBe(
      '2026-10-21T00:30:00.000Z',
    )
  })

  it('startOfZonedDay apunta a la medianoche local', () => {
    expect(startOfZonedDay('2026-10-20', TZ).toISOString()).toBe(
      '2026-10-20T05:00:00.000Z',
    )
  })
})

describe('weekdayOfKey / addDaysToKey', () => {
  it('calcula el día de la semana de una fecha local (0 = domingo)', () => {
    expect(weekdayOfKey('2026-10-18')).toBe(0) // domingo
    expect(weekdayOfKey('2026-10-19')).toBe(1) // lunes
    expect(weekdayOfKey('2026-10-24')).toBe(6) // sábado
  })

  it('suma días cruzando fin de mes y de año', () => {
    expect(addDaysToKey('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToKey('2026-10-19', 7)).toBe('2026-10-26')
  })
})
