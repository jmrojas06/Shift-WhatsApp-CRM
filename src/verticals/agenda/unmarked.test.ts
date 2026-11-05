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
