import { describe, expect, it } from 'vitest'

import {
  DEFAULT_END_HOUR,
  DEFAULT_START_HOUR,
  MIN_BLOCK_MINUTES,
  MIN_SPAN_HOURS,
  formatClock,
  formatHourLabel,
  formatWeekRange,
  hourLabels,
  intervalBand,
  layoutDay,
  offHoursBands,
  startOfWeekKey,
  visibleRange,
  weekDayKeys,
} from './calendar-layout'

/** Hora local de Bogotá (UTC-5) como instante: 08:30 de Bogotá = 13:30 UTC. */
const bogota = (dateKey: string, time: string): Date => new Date(`${dateKey}T${time}:00-05:00`)

const DAY = '2026-11-10' // martes
const at = (time: string) => bogota(DAY, time)
const appt = (id: string, from: string, to: string) => ({
  id,
  startsAt: at(from),
  endsAt: at(to),
})

describe('visibleRange', () => {
  it('sin horarios usa la franja de 6 a 22', () => {
    expect(visibleRange([])).toEqual({ startHour: DEFAULT_START_HOUR, endHour: DEFAULT_END_HOUR })
    expect(DEFAULT_START_HOUR).toBe(6)
    expect(DEFAULT_END_HOUR).toBe(22)
  })

  it('se ajusta a los horarios del equipo con una hora de margen', () => {
    const range = visibleRange([
      { startTime: '08:00:00', endTime: '12:00:00' },
      { startTime: '14:00:00', endTime: '18:00:00' },
    ])
    expect(range).toEqual({ startHour: 7, endHour: 19 })
  })

  it('redondea hacia afuera cuando el horario no cae en hora exacta', () => {
    const range = visibleRange([{ startTime: '08:30:00', endTime: '17:15:00' }])
    expect(range).toEqual({ startHour: 7, endHour: 19 })
  })

  it('se estira para que quepa una cita fuera del horario', () => {
    const range = visibleRange(
      [{ startTime: '08:00:00', endTime: '17:00:00' }],
      [appt('a', '05:30', '06:30'), appt('b', '20:15', '21:00')],
    )
    expect(range).toEqual({ startHour: 5, endHour: 21 })
  })

  it('nunca sale del día', () => {
    const range = visibleRange([{ startTime: '00:00:00', endTime: '24:00:00' }])
    expect(range).toEqual({ startHour: 0, endHour: 24 })
  })

  it('mantiene un mínimo de horas visibles', () => {
    const range = visibleRange([{ startTime: '09:00:00', endTime: '10:00:00' }])
    expect(range.endHour - range.startHour).toBeGreaterThanOrEqual(MIN_SPAN_HOURS)
    expect(range.startHour).toBeLessThanOrEqual(8)
    expect(range.endHour).toBeGreaterThanOrEqual(11)
  })
})

describe('hourLabels', () => {
  it('lista cada hora de la franja con su minuto de inicio', () => {
    const labels = hourLabels({ startHour: 8, endHour: 11 })
    expect(labels.map((l) => l.hour)).toEqual([8, 9, 10])
    expect(labels[0]).toMatchObject({ hour: 8, top: 0 })
    expect(labels[1].top).toBeCloseTo(100 / 3, 5)
  })
})

describe('layoutDay', () => {
  const range = { startHour: 8, endHour: 18 } // 10 horas = 600 minutos

  it('posiciona una cita en porcentaje de la franja visible', () => {
    const [block] = layoutDay([appt('a', '09:00', '10:30')], range)
    expect(block.topMinutes).toBe(60)
    expect(block.heightMinutes).toBe(90)
    expect(block.top).toBeCloseTo(10, 5)
    expect(block.height).toBeCloseTo(15, 5)
    expect(block.lane).toBe(0)
    expect(block.lanes).toBe(1)
  })

  it('usa la hora de Bogotá, no la del servidor', () => {
    // 14:00 UTC es 09:00 en Bogotá.
    const [block] = layoutDay(
      [{ id: 'a', startsAt: new Date('2026-11-10T14:00:00Z'), endsAt: new Date('2026-11-10T15:00:00Z') }],
      range,
    )
    expect(block.topMinutes).toBe(60)
  })

  it('dos citas que no se cruzan quedan en un solo carril', () => {
    const blocks = layoutDay([appt('a', '09:00', '10:00'), appt('b', '10:00', '11:00')], range)
    expect(blocks.map((b) => [b.item.id, b.lane, b.lanes])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
    ])
  })

  it('dos citas que se cruzan van en carriles distintos', () => {
    const blocks = layoutDay([appt('a', '09:00', '10:00'), appt('b', '09:30', '10:30')], range)
    const byId = Object.fromEntries(blocks.map((b) => [b.item.id, b]))
    expect(byId.a.lane).toBe(0)
    expect(byId.b.lane).toBe(1)
    expect(byId.a.lanes).toBe(2)
    expect(byId.b.lanes).toBe(2)
  })

  it('reutiliza un carril libre dentro del mismo grupo', () => {
    // a y c comparten carril 0; b cruza con ambas y va en el 1.
    const blocks = layoutDay(
      [appt('a', '09:00', '10:00'), appt('b', '09:30', '11:00'), appt('c', '10:00', '10:30')],
      range,
    )
    const byId = Object.fromEntries(blocks.map((b) => [b.item.id, b]))
    expect(byId.a.lane).toBe(0)
    expect(byId.b.lane).toBe(1)
    expect(byId.c.lane).toBe(0)
    expect([byId.a.lanes, byId.b.lanes, byId.c.lanes]).toEqual([2, 2, 2])
  })

  it('un grupo aparte no hereda los carriles de otro', () => {
    const blocks = layoutDay(
      [
        appt('a', '09:00', '10:00'),
        appt('b', '09:00', '10:00'),
        appt('c', '09:00', '10:00'),
        appt('d', '14:00', '15:00'),
      ],
      range,
    )
    const byId = Object.fromEntries(blocks.map((b) => [b.item.id, b]))
    expect(byId.a.lanes).toBe(3)
    expect(new Set([byId.a.lane, byId.b.lane, byId.c.lane]).size).toBe(3)
    expect(byId.d.lane).toBe(0)
    expect(byId.d.lanes).toBe(1)
  })

  it('no depende del orden en que llegan', () => {
    const forward = layoutDay([appt('a', '09:00', '10:00'), appt('b', '09:30', '10:30')], range)
    const reversed = layoutDay([appt('b', '09:30', '10:30'), appt('a', '09:00', '10:00')], range)
    const lanes = (list: typeof forward) =>
      Object.fromEntries(list.map((b) => [b.item.id, [b.lane, b.lanes]]))
    expect(lanes(reversed)).toEqual(lanes(forward))
  })

  it('una cita muy corta ocupa al menos el alto mínimo', () => {
    const [block] = layoutDay([appt('a', '09:00', '09:05')], range)
    expect(block.heightMinutes).toBe(MIN_BLOCK_MINUTES)
  })

  it('recorta lo que sobresale de la franja visible', () => {
    const [block] = layoutDay([appt('a', '17:30', '19:00')], range)
    expect(block.topMinutes).toBe(570)
    expect(block.heightMinutes).toBe(30)
    expect(block.top + block.height).toBeCloseTo(100, 5)
  })

  it('deja fuera lo que cae por completo fuera de la franja', () => {
    expect(layoutDay([appt('a', '06:00', '07:00'), appt('b', '18:00', '19:00')], range)).toEqual([])
  })

  it('lista vacía, resultado vacío', () => {
    expect(layoutDay([], range)).toEqual([])
  })

  it('conserva el objeto original en `item`', () => {
    const original = { ...appt('a', '09:00', '10:00'), status: 'confirmed' as const }
    const [block] = layoutDay([original], range)
    expect(block.item).toBe(original)
  })
})

describe('offHoursBands', () => {
  const range = { startHour: 8, endHour: 18 }

  it('sombrea lo que queda antes, entre y después de los bloques', () => {
    const bands = offHoursBands(
      [
        { startTime: '09:00:00', endTime: '12:00:00' },
        { startTime: '14:00:00', endTime: '17:00:00' },
      ],
      range,
    )
    // 08-09, 12-14 y 17-18 sobre 600 minutos.
    expect(bands).toHaveLength(3)
    expect(bands[0].top).toBeCloseTo(0, 5)
    expect(bands[0].height).toBeCloseTo(10, 5)
    expect(bands[1].top).toBeCloseTo(40, 5)
    expect(bands[1].height).toBeCloseTo((120 / 600) * 100, 5)
    expect(bands[2].top + bands[2].height).toBeCloseTo(100, 5)
  })

  it('sin bloques ese día, todo queda sombreado', () => {
    expect(offHoursBands([], range)).toEqual([{ top: 0, height: 100 }])
  })

  it('un horario que cubre toda la franja no sombrea nada', () => {
    expect(offHoursBands([{ startTime: '07:00:00', endTime: '19:00:00' }], range)).toEqual([])
  })

  it('une bloques que se tocan o se encimen', () => {
    const bands = offHoursBands(
      [
        { startTime: '09:00:00', endTime: '12:00:00' },
        { startTime: '11:00:00', endTime: '13:00:00' },
        { startTime: '13:00:00', endTime: '15:00:00' },
      ],
      range,
    )
    expect(bands).toHaveLength(2)
  })
})

describe('intervalBand', () => {
  const range = { startHour: 8, endHour: 18 }

  it('ubica un bloqueo dentro del día y la franja', () => {
    const band = intervalBand(at('10:00'), at('11:00'), DAY, range)
    expect(band?.top).toBeCloseTo((120 / 600) * 100, 5)
    expect(band?.height).toBeCloseTo((60 / 600) * 100, 5)
  })

  it('recorta un bloqueo de varios días al día que se muestra', () => {
    const band = intervalBand(bogota('2026-11-09', '12:00'), bogota('2026-11-12', '12:00'), DAY, range)
    expect(band).toEqual({ top: 0, height: 100 })
  })

  it('devuelve null si no toca el día', () => {
    expect(intervalBand(bogota('2026-11-11', '09:00'), bogota('2026-11-11', '10:00'), DAY, range)).toBeNull()
  })

  it('devuelve null si cae fuera de la franja visible', () => {
    expect(intervalBand(at('05:00'), at('07:00'), DAY, range)).toBeNull()
  })
})

describe('semana', () => {
  it('la semana empieza el lunes', () => {
    expect(startOfWeekKey('2026-11-10')).toBe('2026-11-09') // martes -> lunes
    expect(startOfWeekKey('2026-11-09')).toBe('2026-11-09')
    expect(startOfWeekKey('2026-11-15')).toBe('2026-11-09') // domingo -> lunes anterior
  })

  it('cruza el cambio de mes y de año', () => {
    expect(startOfWeekKey('2026-12-31')).toBe('2026-12-28')
    expect(weekDayKeys('2026-12-31', { includeSunday: true })).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ])
  })

  it('puede dejar el domingo fuera', () => {
    const days = weekDayKeys('2026-11-10', { includeSunday: false })
    expect(days).toHaveLength(6)
    expect(days[0]).toBe('2026-11-09')
    expect(days[5]).toBe('2026-11-14')
  })
})

describe('textos de fecha y hora', () => {
  it('la hora de la columna se lee en 12 horas', () => {
    expect(formatHourLabel(0)).toBe('12 a. m.')
    expect(formatHourLabel(7)).toBe('7 a. m.')
    expect(formatHourLabel(12)).toBe('12 p. m.')
    expect(formatHourLabel(18)).toBe('6 p. m.')
  })

  it('la hora dentro de una cita va corta, sin a. m. ni p. m.', () => {
    expect(formatClock(at('09:05'))).toBe('9:05')
    expect(formatClock(at('13:30'))).toBe('1:30')
    expect(formatClock(at('00:15'))).toBe('12:15')
  })

  it('el título de la semana dentro de un mismo mes', () => {
    expect(formatWeekRange('2026-11-10')).toBe('9 al 15 de noviembre de 2026')
  })

  it('el título de la semana que cruza de mes', () => {
    expect(formatWeekRange('2026-11-30')).toBe('30 de noviembre al 6 de diciembre de 2026')
  })

  it('el título de la semana que cruza de año', () => {
    expect(formatWeekRange('2026-12-31')).toBe('28 de diciembre de 2026 al 3 de enero de 2027')
  })

  it('sin domingo, la semana termina el sábado', () => {
    expect(formatWeekRange('2026-11-10', { includeSunday: false })).toBe('9 al 14 de noviembre de 2026')
  })
})
