import { describe, expect, it } from 'vitest'

import { describeError } from './describe-error'

describe('describeError', () => {
  it('un Error: su nombre y su mensaje, sin la pila', () => {
    const error = new TypeError('algo falló')
    expect(describeError(error)).toBe('TypeError: algo falló')
    expect(describeError(error)).not.toContain('at ')
  })

  it('un error de PostgREST: el código y el mensaje, sin details ni hint', () => {
    const postgrest = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "contacts_pkey"',
      details: 'Key (name, phone)=(Marta Gómez, 573001112233) already exists.',
      hint: 'Marta Gómez',
    }
    const text = describeError(postgrest)
    expect(text).toBe('23505: duplicate key value violates unique constraint "contacts_pkey"')
    expect(text).not.toContain('Marta')
    expect(text).not.toContain('573001112233')
  })

  it('un objeto solo con mensaje, o solo con código', () => {
    expect(describeError({ message: 'base caída' })).toBe('base caída')
    expect(describeError({ code: '42P01' })).toBe('42P01')
  })

  it('quita teléfonos e identificadores que el mensaje repita', () => {
    expect(describeError(new Error('invalid input syntax for type uuid: "573001112233"'))).not.toContain('573001112233')
    expect(describeError({ code: '22P02', message: 'valor +57 300 111 2233 no válido' })).not.toMatch(/300 111 2233/)
  })

  it('corta un mensaje muy largo', () => {
    expect(describeError(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(200)
  })

  it('lo que no es un error no se vuelca', () => {
    expect(describeError(null)).toBe('error desconocido')
    expect(describeError(undefined)).toBe('error desconocido')
    expect(describeError('Marta Gómez 573001112233')).toBe('error desconocido')
    expect(describeError({ nombre: 'Marta' })).toBe('error desconocido')
  })
})
