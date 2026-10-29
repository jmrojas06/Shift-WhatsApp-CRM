import { describe, expect, it } from 'vitest'

import { minutesOfDayInZone } from './time-zone'

describe('minutesOfDayInZone', () => {
  it('usa la hora de Colombia, no la del servidor (UTC)', () => {
    // 23:30 UTC = 18:30 en Bogotá (UTC-5).
    expect(minutesOfDayInZone(new Date('2026-10-28T23:30:00Z'))).toBe(18 * 60 + 30)
  })

  it('cruza la medianoche hacia atrás', () => {
    // 03:15 UTC = 22:15 del día anterior en Bogotá.
    expect(minutesOfDayInZone(new Date('2026-10-28T03:15:00Z'))).toBe(22 * 60 + 15)
  })

  it('acepta otra zona', () => {
    expect(minutesOfDayInZone(new Date('2026-10-28T12:00:00Z'), 'UTC')).toBe(12 * 60)
  })
})
