import { describe, expect, it } from 'vitest'

import { formatMinutes } from './today-summary'

describe('formatMinutes', () => {
  it('keeps a decimal under 10 seconds so close values stay distinct', () => {
    expect(formatMinutes(1 / 60, 'es')).toBe('1 s')
    expect(formatMinutes(1.5 / 60, 'es')).toBe('1,5 s')
  })

  it('uses whole seconds, then minutes, then hours', () => {
    expect(formatMinutes(0.5, 'es')).toBe('30 s')
    expect(formatMinutes(4.5, 'es')).toBe('4,5 min')
    expect(formatMinutes(90, 'en')).toBe('1.5 h')
  })
})
