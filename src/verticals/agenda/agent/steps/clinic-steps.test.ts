import { describe, expect, it } from 'vitest'

import { routeClinicText } from './clinic-steps'

describe('routeClinicText', () => {
  it.each([
    'quiero una cita',
    'necesito cita para mi hijo',
    'cita',
    'agendar',
    '¿me das una cita?',
    '¿puedo agendar una cita para mañana?',
    'Qué pena, necesito una cita',
    'Tienen citas disponibles',
    'me pueden dar una cita?',
    '¿me agendan una cita?',
    '¿puedo cancelar mi cita?',
    '¿tienen cita hoy?',
    'quiero una cita para una radiografía',
    'necesito cita, traigo la radiografía',
    'quiero agendar, ya hice el pago',
  ])('book: %j', (text) => {
    expect(routeClinicText(text)).toBe('book')
  })

  it.each(['hola', 'buenas', 'buenos días', 'buen día', 'buenas tardes'])('greeting: %j', (text) => {
    expect(routeClinicText(text)).toBe('greeting')
  })

  it.each([
    'quiero pagar',
    'tengo una queja',
    'el saldo',
    'documento de identidad',
    'necesito mi historia clínica',
  ])('human: %j', (text) => {
    expect(routeClinicText(text)).toBe('human')
  })

  it.each([
    'cuánto vale una cita',
    'dónde es la cita',
    'qué precio tiene la cita',
    'cuánto vale una limpieza',
    '¿aceptan tarjeta?',
    '¿puedo pagar con tarjeta?',
    '¿dónde quedan?',
    'gracias, buenas noches',
    'excelente, no tengo ninguna queja',
    'muchas gracias por la receta',
  ])('ai: %j', (text) => {
    expect(routeClinicText(text)).toBe('ai')
  })

  describe('book', () => {
    it('una palabra de cita sola, o en tres palabras o menos, basta', () => {
      expect(routeClinicText('una cita hoy')).toBe('book')
      expect(routeClinicText('reservar')).toBe('book')
      expect(routeClinicText('turno')).toBe('book')
      expect(routeClinicText('agenda')).toBe('book')
    })

    it('con más de tres palabras necesita además un verbo de pedir', () => {
      expect(routeClinicText('cuánto vale una cita')).toBe('ai')
      expect(routeClinicText('sacar una cita hoy mismo')).toBe('book')
      expect(routeClinicText('quisiera reservar para el lunes')).toBe('book')
      expect(routeClinicText('hay turno para mañana')).toBe('book')
    })

    it('usa las palabras que la clínica le da a la cita', () => {
      expect(routeClinicText('cuándo tienen sesiones para el viernes')).toBe('ai')
      expect(routeClinicText('cuándo tienen sesiones para el viernes', ['sesión', 'sesiones'])).toBe('book')
    })

    it('gana sobre las palabras de quejas, pagos y documentos', () => {
      expect(routeClinicText('quiero una cita para una radiografía')).toBe('book')
      expect(routeClinicText('necesito cita, traigo la receta')).toBe('book')
    })

    it('sin tildes, mayúsculas ni puntuación', () => {
      expect(routeClinicText('¡NECESITO UNA CITA!')).toBe('book')
      expect(routeClinicText('Quiero    una cita...')).toBe('book')
    })
  })

  describe('human', () => {
    it('quejas, pagos y documentos', () => {
      for (const text of [
        'Necesito mi factura',
        'Hice un abono ayer',
        'Voy a pagar hoy',
        'Una pqrs por favor',
        'Necesito la incapacidad',
        'Necesito la radiografía de mi hijo',
        'Hola, quiero pagar mi factura',
      ]) {
        expect(routeClinicText(text)).toBe('human')
      }
    })

    it('una negación antes de la palabra la anula', () => {
      expect(routeClinicText('no tengo ninguna queja')).toBe('ai')
      expect(routeClinicText('sin ninguna queja, todo bien')).toBe('ai')
      expect(routeClinicText('nunca he recibido una factura')).toBe('ai')
    })

    it('un agradecimiento antes de la palabra la anula', () => {
      expect(routeClinicText('gracias por la factura')).toBe('ai')
      expect(routeClinicText('agradezco el certificado')).toBe('ai')
    })

    it('una negación después de la palabra no la anula', () => {
      expect(routeClinicText('tengo una queja, no me atendieron')).toBe('human')
    })

    it('una pregunta no es un pedido: ni con signo ni con palabra interrogativa', () => {
      expect(routeClinicText('¿Cuánto cuesta el certificado?')).toBe('ai')
      expect(routeClinicText('¿puedo pagar con tarjeta')).toBe('ai')
      expect(routeClinicText('cómo pago')).toBe('ai')
      expect(routeClinicText('dónde recojo mi factura')).toBe('ai')
      expect(routeClinicText('qué documentos piden para el primer día')).toBe('ai')
      expect(routeClinicText('cuánto cuesta la radiografía')).toBe('ai')
    })

    it('una palabra más larga no cuenta: "pagado" no es "pago"', () => {
      expect(routeClinicText('ya está pagado, gracias')).toBe('ai')
    })
  })

  describe('greeting', () => {
    it('solo si el mensaje arranca con el saludo y no pasa de cuatro palabras', () => {
      expect(routeClinicText('Hola, buenas tardes')).toBe('greeting')
      expect(routeClinicText('buenas noches doctor')).toBe('greeting')
      expect(routeClinicText('¡Hola!')).toBe('greeting')
      expect(routeClinicText('hola buenos días doctora')).toBe('greeting')
      expect(routeClinicText('hola buenos días a todos')).toBe('ai')
    })

    it('un saludo en medio del mensaje no cuenta', () => {
      expect(routeClinicText('gracias, buenas noches')).toBe('ai')
      expect(routeClinicText('ok hola')).toBe('ai')
    })

    it('una palabra que solo empieza como el saludo no cuenta', () => {
      expect(routeClinicText('holanda')).toBe('ai')
      expect(routeClinicText('buenazo')).toBe('ai')
    })

    it('el saludo con una duda larga es una duda', () => {
      expect(routeClinicText('hola, cuánto vale la limpieza dental')).toBe('ai')
    })
  })

  it('lo demás, y un mensaje vacío, es para la IA', () => {
    expect(routeClinicText('')).toBe('ai')
    expect(routeClinicText('   ')).toBe('ai')
    expect(routeClinicText('ok')).toBe('ai')
    expect(routeClinicText('me duele una muela y no sé qué hacer')).toBe('ai')
  })
})
