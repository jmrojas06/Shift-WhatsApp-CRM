import { describe, expect, it } from 'vitest'

import { isUndefinedColumnError } from './undefined-column'

describe('isUndefinedColumnError', () => {
  it('reconoce columna ausente de Postgres (42703) y de PostgREST (PGRST204)', () => {
    expect(isUndefinedColumnError({ code: '42703' })).toBe(true)
    expect(isUndefinedColumnError({ code: 'PGRST204' })).toBe(true)
  })

  it('no confunde otros errores, ni la ausencia de error', () => {
    expect(isUndefinedColumnError({ code: '42P01' })).toBe(false)
    expect(isUndefinedColumnError({ code: '57014', message: 'timeout' })).toBe(false)
    expect(isUndefinedColumnError({ message: 'x' })).toBe(false)
    expect(isUndefinedColumnError(null)).toBe(false)
    expect(isUndefinedColumnError(undefined)).toBe(false)
  })
})
