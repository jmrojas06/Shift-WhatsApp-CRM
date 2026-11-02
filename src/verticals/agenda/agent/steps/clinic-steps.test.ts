import { describe, expect, it } from 'vitest'

import { looksLikeQuestion } from './clinic-steps'

describe('looksLikeQuestion', () => {
  it.each([
    'quiero una cita',
    'necesito cita para mi hijo',
    'cita',
    'hola',
    'buenas',
    'buenos días',
    'buenas tardes',
    '¿me das una cita?',
    '¿puedo agendar una cita para mañana?',
    'Qué pena, necesito una cita',
    'Tienen citas disponibles',
  ])('abre el menú: %j', (text) => {
    expect(looksLikeQuestion(text)).toBe(false)
  })

  it.each([
    'qué precio tiene',
    'cómo agendo',
    '¿Cuánto vale una cita de valoración?',
    '¿aceptan tarjeta?',
    '¿dónde quedan?',
  ])('va a la IA: %j', (text) => {
    expect(looksLikeQuestion(text)).toBe(true)
  })

  it.each([
    ['¡Hola!', false],
    ['Hola, buenas tardes.', false],
    ['¿Qué horario tienen', true],
    ['¿cuánto vale la limpieza', true],
    ['  ¿Cómo  llego?  ', true],
    ['Cuánto cuesta la limpieza', true],
    ['dónde están ubicados', true],
    ['Quisiera una cita', false],
    ['me da una cita para el lunes', false],
    ['¿puedo agendar?', false],
  ])('quita la puntuación y los espacios antes de leer la primera palabra: %j', (text, expected) => {
    expect(looksLikeQuestion(text)).toBe(expected)
  })

  it('un verbo de pedir gana sobre el signo de pregunta', () => {
    expect(looksLikeQuestion('¿quiero una cita, se puede?')).toBe(false)
    expect(looksLikeQuestion('¿me das una cita para hoy?')).toBe(false)
  })

  it('una palabra de cita sin signo de pregunta abre el menú, con la palabra que usa la clínica', () => {
    expect(looksLikeQuestion('Tienen turnos disponibles')).toBe(true)
    expect(looksLikeQuestion('Tienen turnos disponibles', ['turno', 'turnos'])).toBe(false)
  })

  it('una palabra de cita con signo de pregunta sigue siendo una duda', () => {
    expect(looksLikeQuestion('¿Tienen citas disponibles?')).toBe(true)
  })
})
