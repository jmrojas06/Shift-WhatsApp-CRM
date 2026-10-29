import { describe, expect, it } from 'vitest'

import { isOptedOutPhone, isOptOutMessage } from './opt-out'

describe('isOptOutMessage', () => {
  it.each(['BAJA', 'baja', ' Baja. ', 'STOP', 'Stop!', 'Darme de baja', 'no más mensajes', 'PARAR'])(
    'reconoce "%s"',
    (text) => {
      expect(isOptOutMessage(text)).toBe(true)
    },
  )

  it.each([
    '',
    'hola',
    'cancelar',
    'quiero bajar de peso',
    'la baja del precio?',
    'stop motion',
    'no puedo parar de comprar',
  ])('no confunde "%s" con una baja', (text) => {
    expect(isOptOutMessage(text)).toBe(false)
  })
})

describe('isOptedOutPhone', () => {
  it('compara solo los dígitos del teléfono', () => {
    const optedOut = new Set(['573001234567'])
    expect(isOptedOutPhone(optedOut, '+57 300 123 4567')).toBe(true)
    expect(isOptedOutPhone(optedOut, '+57 300 999 0000')).toBe(false)
  })
})
