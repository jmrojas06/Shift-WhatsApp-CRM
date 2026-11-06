import { describe, expect, it } from 'vitest'

import { selectUnmarked } from './unmarked'

// Jueves 5 de noviembre de 2026, 15:00 en Bogotá.
const NOW = new Date('2026-11-05T20:00:00.000Z')

const at = (time: string) => `2026-11-05T${time}:00.000Z`

const appt = (id: string, startsAt: string, status = 'confirmed') => ({ id, starts_at: startsAt, status })

describe('selectUnmarked', () => {
  it('trae las citas pendientes o confirmadas que ya empezaron', () => {
    const list = [appt('a', at('14:00'), 'confirmed'), appt('b', at('15:00'), 'pending')]
    expect(selectUnmarked(list, NOW).map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('la que empieza justo ahora cuenta como empezada', () => {
    expect(selectUnmarked([appt('a', NOW.toISOString())], NOW)).toHaveLength(1)
  })

  it('las que todavía no empiezan no', () => {
    expect(selectUnmarked([appt('a', at('20:00:01'))], NOW)).toHaveLength(0)
  })

  it.each(['completed', 'no_show', 'cancelled'])('una cita %s ya está marcada', (status) => {
    expect(selectUnmarked([appt('a', at('14:00'), status)], NOW)).toHaveLength(0)
  })

  it('en orden de hora, la más temprana primero, sin importar cómo llegaron', () => {
    const list = [appt('tarde', at('19:00')), appt('temprano', at('13:00')), appt('medio', at('16:00'))]
    expect(selectUnmarked(list, NOW).map((a) => a.id)).toEqual(['temprano', 'medio', 'tarde'])
  })

  it('conserva lo demás de cada cita y no cambia la lista de entrada', () => {
    const list = [{ ...appt('a', at('14:00')), serviceName: 'Limpieza' }]
    const copy = structuredClone(list)
    expect(selectUnmarked(list, NOW)[0]).toMatchObject({ serviceName: 'Limpieza' })
    expect(list).toEqual(copy)
  })

  it('sin citas, una lista vacía', () => {
    expect(selectUnmarked([], NOW)).toEqual([])
  })
})

// La página carga las citas al abrir y no las recarga sola: pasada la
// medianoche de Bogotá, lo que tiene en memoria es de ayer.
describe('selectUnmarked cruzando la medianoche de Bogotá', () => {
  // Viernes 6 de noviembre, 00:30 en Bogotá (05:30 UTC).
  const AFTER_MIDNIGHT = new Date('2026-11-06T05:30:00.000Z')

  it('una cita de ayer sin marcar ya no es de hoy', () => {
    // Jueves 5 de noviembre, 15:00 en Bogotá.
    const yesterday = appt('ayer', '2026-11-05T20:00:00.000Z', 'confirmed')
    expect(selectUnmarked([yesterday], AFTER_MIDNIGHT)).toEqual([])
  })

  it('una cita de las 23:59 de ayer tampoco', () => {
    const lastMinute = appt('ayer', '2026-11-06T04:59:00.000Z', 'pending')
    expect(selectUnmarked([lastMinute], AFTER_MIDNIGHT)).toEqual([])
  })

  it('una cita de la madrugada de hoy sí', () => {
    // 00:10 en Bogotá.
    const today = appt('hoy', '2026-11-06T05:10:00.000Z', 'pending')
    expect(selectUnmarked([today], AFTER_MIDNIGHT).map((a) => a.id)).toEqual(['hoy'])
  })

  it('con ayer y hoy mezclados, solo sale la de hoy', () => {
    const list = [appt('ayer', '2026-11-05T20:00:00.000Z'), appt('hoy', '2026-11-06T05:10:00.000Z')]
    expect(selectUnmarked(list, AFTER_MIDNIGHT).map((a) => a.id)).toEqual(['hoy'])
  })

  it('el día es el de Bogotá, no el de UTC: las 22:00 de hoy en Bogotá ya son mañana en UTC', () => {
    // Jueves 5 de noviembre, 22:00 en Bogotá = viernes 03:00 UTC.
    const late = new Date('2026-11-06T03:00:00.000Z')
    const evening = appt('noche', '2026-11-06T02:00:00.000Z', 'confirmed')
    expect(selectUnmarked([evening], late).map((a) => a.id)).toEqual(['noche'])
  })

  it('el mismo instante cambia de respuesta al pasar la medianoche', () => {
    const lastMinute = appt('cita', '2026-11-06T04:59:00.000Z', 'pending')
    expect(selectUnmarked([lastMinute], new Date('2026-11-06T04:59:59.000Z'))).toHaveLength(1)
    expect(selectUnmarked([lastMinute], new Date('2026-11-06T05:00:00.000Z'))).toHaveLength(0)
  })
})
