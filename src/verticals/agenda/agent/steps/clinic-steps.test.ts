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
    '¿tienen cita hoy?',
    'quiero una cita para una radiografía',
    'necesito cita, traigo la radiografía',
    'quiero agendar, ya hice el pago',
    'me regala una cita',
    'quería una cita para mañana',
    'me gustaría agendar una cita',
    'cita para mi hijo',
    'quiero una valoración',
    'tienen cupo para hoy',
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
    'no me ha llegado la factura',
    'no me atendieron bien y quiero poner una queja',
    'necesito mis radiografías',
    'ya pagué',
    'quiero poner una queja por mi cita',
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
    'hola cuánto vale una radiografía',
    'puedo pagar con tarjeta',
    'dan factura',
    'tengo que llevar documentos',
  ])('ai: %j', (text) => {
    expect(routeClinicText(text)).toBe('ai')
  })

  // La Task 11 agrega la ruta a "Mis citas": hasta entonces cancelar o no poder ir
  // a una cita no es pedir una, y va a la IA (que no la cancela) en vez de abrir el menú.
  describe('cancelar o no poder ir no es pedir una cita (hasta la Task 11)', () => {
    it.each([
      'quiero cancelar mi cita',
      '¿puedo cancelar mi cita?',
      'necesito cambiar mi cita',
      'quiero reprogramar la cita',
      'no puedo ir a la cita',
      'no voy a poder asistir a mi cita de mañana',
    ])('ai: %j', (text) => {
      expect(routeClinicText(text)).toBe('ai')
    })

    it('una queja por la cita es una queja, no una cita', () => {
      expect(routeClinicText('quiero poner una queja por mi cita')).toBe('human')
      expect(routeClinicText('tengo un reclamo sobre mi cita')).toBe('human')
    })
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

    it('un pedido que arranca con la cita ("cita para mi hijo") es una cita, pero no una duda', () => {
      expect(routeClinicText('cita para mi hijo')).toBe('book')
      expect(routeClinicText('citas para esta semana')).toBe('book')
      expect(routeClinicText('cita de valoración, ¿cuánto vale?')).toBe('ai')
      expect(routeClinicText('cita de valoración cuánto vale')).toBe('ai')
    })

    it('"valoración" y "cupo" son palabras de cita', () => {
      expect(routeClinicText('valoración')).toBe('book')
      expect(routeClinicText('hay cupo mañana')).toBe('book')
      expect(routeClinicText('cuánto vale la valoración')).toBe('ai')
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

    it('una negación justo antes de la palabra la anula', () => {
      expect(routeClinicText('no tengo ninguna queja')).toBe('ai')
      expect(routeClinicText('sin ninguna queja, todo bien')).toBe('ai')
      expect(routeClinicText('no hay reclamo')).toBe('ai')
    })

    it('una negación lejos de la palabra no la anula: "no me ha llegado la factura" es una queja', () => {
      expect(routeClinicText('no me ha llegado la factura')).toBe('human')
      expect(routeClinicText('nunca he recibido una factura')).toBe('human')
      expect(routeClinicText('no llegó la factura')).toBe('human')
      expect(routeClinicText('no me atendieron bien y quiero poner una queja')).toBe('human')
    })

    it('un agradecimiento antes de la palabra la anula', () => {
      expect(routeClinicText('gracias por la factura')).toBe('ai')
      expect(routeClinicText('agradezco el certificado')).toBe('ai')
    })

    it('una negación después de la palabra no la anula', () => {
      expect(routeClinicText('tengo una queja, no me atendieron')).toBe('human')
    })

    it('el saludo del principio no esconde la pregunta', () => {
      expect(routeClinicText('hola cuánto vale una radiografía')).toBe('ai')
      expect(routeClinicText('Hola, buenas tardes, ¿cuánto cuesta el certificado?')).toBe('ai')
      expect(routeClinicText('hola, quiero pagar mi factura')).toBe('human')
    })

    it('una pregunta con "puedo", "dan" o "tengo que" no es un pedido', () => {
      expect(routeClinicText('puedo pagar con tarjeta')).toBe('ai')
      expect(routeClinicText('dan factura')).toBe('ai')
      expect(routeClinicText('tengo que llevar documentos')).toBe('ai')
      expect(routeClinicText('tengo una queja')).toBe('human')
    })

    it('el plural y el pasado también cuentan', () => {
      expect(routeClinicText('necesito mis radiografías')).toBe('human')
      expect(routeClinicText('ya pagué')).toBe('human')
      expect(routeClinicText('tengo unas quejas')).toBe('human')
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
