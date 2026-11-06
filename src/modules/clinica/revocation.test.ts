import { describe, expect, it } from 'vitest'

import { consentRevocation, isConsentRevocation } from './revocation'

describe('revocar la autorización escribiendo', () => {
  describe('un mensaje completo', () => {
    it.each([
      'no acepto',
      'No acepto',
      'NO ACEPTO.',
      'ya no acepto',
      'Ya no acepto!',
      'no autorizo',
      'ya no autorizo',
      '  no   acepto  ',
    ])('%j revoca', (text) => {
      expect(isConsentRevocation(text)).toBe(true)
    })

    it('sin pedir que borren nada', () => {
      expect(consentRevocation('no acepto')).toEqual({ deleteData: false })
      expect(consentRevocation('ya no autorizo')).toEqual({ deleteData: false })
    })
  })

  describe('una frase con un verbo y la autorización o los datos', () => {
    it.each([
      'ya no autorizo el uso de mis datos',
      'revoco mi autorización',
      'Quiero revocar la autorización que di',
      'retiro mi autorización',
      'quiero que borren mis datos',
      'por favor eliminen mis datos',
      'suprima mis datos de su sistema',
      'quiten mis datos',
      'no quiero que usen mis datos',
      'no usen mis datos, por favor',
      'no autorizo que guarden mis datos',
      'no autorizo el tratamiento de mis datos',
      'revoco la autorización de mis datos',
      'Ya no autorizo, borren mis datos',
      '¿cómo borro mis datos?',
    ])('%j revoca', (text) => {
      expect(isConsentRevocation(text)).toBe(true)
    })

    it.each([
      'quiero que borren mis datos',
      'por favor eliminen mis datos',
      'suprima mis datos de su sistema',
      'quiten mis datos',
      'Ya no autorizo, borren mis datos',
      '¿cómo borro mis datos?',
    ])('y %j pide borrar los datos: hay que atenderlo a mano', (text) => {
      expect(consentRevocation(text)).toEqual({ deleteData: true })
    })

    it.each([
      'ya no autorizo el uso de mis datos',
      'revoco mi autorización',
      'retiro mi autorización',
      'no quiero que usen mis datos',
    ])('pero %j solo revoca', (text) => {
      expect(consentRevocation(text)).toEqual({ deleteData: false })
    })
  })

  describe('lo que NO es una revocación', () => {
    it.each([
      'no acepto esa hora',
      'no acepto tarjeta',
      'no acepto el precio',
      'no acepto, gracias',
      'borré el mensaje',
      'borre el mensaje por error',
      'quiero borrar mi cita',
      'elimina el último mensaje',
      'quiero quitar la cita de mi hijo',
      'no autorizo ese cobro',
      'no autorizo a mi hijo a ir solo',
      'autorizo',
      'acepto',
      'sí acepto',
      'mis datos son Marta Ruiz',
      'quiero actualizar mis datos',
      '¿qué hacen con mis datos?',
      'envío mis datos por aquí',
      'la autorización',
      'retiro mi hijo del colegio a las 3',
      'no quiero que usen la sala de espera',
      '',
      '   ',
      '😀',
    ])('%j no revoca', (text) => {
      expect(isConsentRevocation(text)).toBe(false)
      expect(consentRevocation(text)).toBeNull()
    })
  })

  it('no se confunde por mayúsculas, tildes ni signos', () => {
    expect(isConsentRevocation('¡REVOCO MI AUTORIZACIÓN!')).toBe(true)
    expect(isConsentRevocation('Ya no autorizó el uso de mis datos')).toBe(true)
    expect(isConsentRevocation('Quiero que BORREN mis datos...')).toBe(true)
  })
})
