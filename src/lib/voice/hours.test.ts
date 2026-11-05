import { describe, expect, it } from 'vitest'

import {
  formatOfficeHours,
  isWithinCallWindow,
  isWithinOfficeHours,
  normalizeClock,
  parseOfficeHours,
  spokenAtTime,
  spokenClockTime,
  type OfficeHours,
} from './hours'

// Bogotá es UTC-5 todo el año: 10:00 local = 15:00Z.
const at = (isoLocal: string): Date => new Date(`${isoLocal}-05:00`)

const WEEK: OfficeHours = {
  '1': [['08:00', '18:00']],
  '2': [['08:00', '18:00']],
  '3': [['08:00', '18:00']],
  '4': [['08:00', '18:00']],
  '5': [['08:00', '18:00']],
  '6': [['08:00', '13:00']],
}

describe('normalizeClock', () => {
  it('normaliza a HH:MM y acepta segundos de una columna time', () => {
    expect(normalizeClock('8:00')).toBe('08:00')
    expect(normalizeClock('08:00')).toBe('08:00')
    expect(normalizeClock('18:30:00')).toBe('18:30')
    expect(normalizeClock(' 07:05 ')).toBe('07:05')
  })

  it('rechaza lo que no es una hora', () => {
    for (const bad of ['24:00', '12:60', '8', '8am', '', 'ab:cd', null, undefined, 800]) {
      expect(normalizeClock(bad)).toBeNull()
    }
  })
})

describe('parseOfficeHours', () => {
  it('respeta un horario válido', () => {
    expect(parseOfficeHours(WEEK)).toEqual(WEEK)
  })

  it('ordena los tramos, junta los que se tocan y normaliza las horas', () => {
    expect(
      parseOfficeHours({
        '1': [
          ['14:00', '18:00'],
          ['8:00', '12:00'],
        ],
        '2': [
          ['08:00', '12:00'],
          ['12:00', '13:00'],
          ['11:00', '12:30'],
        ],
      }),
    ).toEqual({
      '1': [
        ['08:00', '12:00'],
        ['14:00', '18:00'],
      ],
      '2': [['08:00', '13:00']],
    })
  })

  it('descarta lo inválido sin lanzar', () => {
    expect(parseOfficeHours(null)).toEqual({})
    expect(parseOfficeHours('x')).toEqual({})
    expect(parseOfficeHours([['08:00', '18:00']])).toEqual({})
    expect(
      parseOfficeHours({
        '7': [['08:00', '18:00']], // no existe el día 7
        lunes: [['08:00', '18:00']],
        '1': [['18:00', '08:00']], // al revés
        '2': 'todo el día',
        '3': [['08:00']],
        '4': [['08:00', '18:00', 'x']],
        '5': [['08:00', '18:00'], 'basura', null, [1, 2]],
        '6': [],
      }),
    ).toEqual({ '5': [['08:00', '18:00']] })
  })
})

describe('isWithinOfficeHours', () => {
  it('dentro, justo al abrir y fuera (el cierre no cuenta)', () => {
    expect(isWithinOfficeHours(WEEK, at('2026-11-03T10:00:00'))).toBe(true) // martes
    expect(isWithinOfficeHours(WEEK, at('2026-11-03T08:00:00'))).toBe(true)
    expect(isWithinOfficeHours(WEEK, at('2026-11-03T07:59:00'))).toBe(false)
    expect(isWithinOfficeHours(WEEK, at('2026-11-03T17:59:00'))).toBe(true)
    expect(isWithinOfficeHours(WEEK, at('2026-11-03T18:00:00'))).toBe(false)
  })

  it('sábado según su horario y domingo cerrado', () => {
    expect(isWithinOfficeHours(WEEK, at('2026-11-07T12:59:00'))).toBe(true)
    expect(isWithinOfficeHours(WEEK, at('2026-11-07T13:00:00'))).toBe(false)
    expect(isWithinOfficeHours(WEEK, at('2026-11-08T10:00:00'))).toBe(false)
  })

  it('un festivo cuenta como cerrado aunque el día tenga horario', () => {
    expect(isWithinOfficeHours(WEEK, at('2026-11-02T10:00:00'))).toBe(false) // lunes festivo
    expect(isWithinOfficeHours(WEEK, at('2026-12-25T10:00:00'))).toBe(false) // viernes festivo
    expect(isWithinOfficeHours(WEEK, at('2027-03-26T10:00:00'))).toBe(false) // Viernes Santo
    expect(isWithinOfficeHours(WEEK, at('2026-11-09T10:00:00'))).toBe(true) // lunes normal
  })

  it('usa el día de Bogotá, no el de UTC', () => {
    const evening: OfficeHours = { '2': [['20:00', '23:59']] }
    // 03:30Z del miércoles = martes 22:30 en Bogotá.
    expect(isWithinOfficeHours(evening, new Date('2026-11-04T03:30:00Z'))).toBe(true)
    expect(isWithinOfficeHours(evening, new Date('2026-11-04T13:30:00Z'))).toBe(false)
  })

  it('con dos tramos al día queda cerrado a la hora de almuerzo', () => {
    const split: OfficeHours = {
      '3': [
        ['08:00', '12:00'],
        ['14:00', '18:00'],
      ],
    }
    expect(isWithinOfficeHours(split, at('2026-11-04T11:59:00'))).toBe(true)
    expect(isWithinOfficeHours(split, at('2026-11-04T12:30:00'))).toBe(false)
    expect(isWithinOfficeHours(split, at('2026-11-04T14:00:00'))).toBe(true)
  })

  it('sin horario o con horario dañado queda cerrado', () => {
    expect(isWithinOfficeHours({}, at('2026-11-03T10:00:00'))).toBe(false)
    expect(
      isWithinOfficeHours({ '2': [['xx', 'yy']] } as unknown as OfficeHours, at('2026-11-03T10:00:00')),
    ).toBe(false)
  })
})

describe('isWithinCallWindow', () => {
  const settings = { windowStart: '08:00', windowEnd: '19:00', callSaturday: true }

  it('de lunes a viernes entre el inicio y el fin (el fin no cuenta)', () => {
    expect(isWithinCallWindow(settings, at('2026-11-03T08:00:00'))).toBe(true)
    expect(isWithinCallWindow(settings, at('2026-11-03T07:59:00'))).toBe(false)
    expect(isWithinCallWindow(settings, at('2026-11-03T18:59:00'))).toBe(true)
    expect(isWithinCallWindow(settings, at('2026-11-03T19:00:00'))).toBe(false)
  })

  it('el sábado solo si call_saturday', () => {
    expect(isWithinCallWindow(settings, at('2026-11-07T10:00:00'))).toBe(true)
    expect(isWithinCallWindow({ ...settings, callSaturday: false }, at('2026-11-07T10:00:00'))).toBe(false)
  })

  it('nunca el domingo, ni con call_saturday', () => {
    expect(isWithinCallWindow(settings, at('2026-11-08T10:00:00'))).toBe(false)
  })

  it('nunca en festivo, aunque sea entre semana y en la ventana', () => {
    expect(isWithinCallWindow(settings, at('2026-11-02T10:00:00'))).toBe(false)
    expect(isWithinCallWindow(settings, at('2026-07-13T10:00:00'))).toBe(false)
    expect(isWithinCallWindow(settings, at('2026-12-25T10:00:00'))).toBe(false)
    // Un sábado festivo tampoco, aunque se llame los sábados.
    expect(isWithinCallWindow(settings, at('2027-05-01T10:00:00'))).toBe(false)
    expect(isWithinCallWindow(settings, at('2026-11-03T10:00:00'))).toBe(true)
  })

  it('usa la hora de Bogotá y no la de UTC', () => {
    // 13:30Z = 08:30 Bogotá.
    expect(isWithinCallWindow(settings, new Date('2026-11-03T13:30:00Z'))).toBe(true)
    // 01:00Z del miércoles = martes 20:00 Bogotá.
    expect(isWithinCallWindow(settings, new Date('2026-11-04T01:00:00Z'))).toBe(false)
  })

  it('una ventana dañada o al revés no llama nunca', () => {
    expect(isWithinCallWindow({ ...settings, windowStart: 'x' }, at('2026-11-03T10:00:00'))).toBe(false)
    expect(isWithinCallWindow({ ...settings, windowStart: '19:00', windowEnd: '08:00' }, at('2026-11-03T10:00:00'))).toBe(
      false,
    )
  })
})

describe('formatOfficeHours', () => {
  it('agrupa los días seguidos con el mismo horario', () => {
    expect(formatOfficeHours(WEEK)).toBe(
      'de lunes a viernes de 8 a. m. a 6 p. m. y los sábados de 8 a. m. a 1 p. m.',
    )
  })

  it('separa con comas cuando hay más de dos grupos', () => {
    expect(
      formatOfficeHours({
        ...WEEK,
        '5': [['08:00', '16:30']],
      }),
    ).toBe(
      'de lunes a jueves de 8 a. m. a 6 p. m., los viernes de 8 a. m. a 4:30 p. m. y los sábados de 8 a. m. a 1 p. m.',
    )
  })

  it('un solo grupo, un solo día, todos los días y el domingo', () => {
    expect(formatOfficeHours({ '1': [['09:00', '17:00']] })).toBe('los lunes de 9 a. m. a 5 p. m.')
    expect(formatOfficeHours({ '0': [['10:00', '14:00']] })).toBe('los domingos de 10 a. m. a 2 p. m.')
    expect(
      formatOfficeHours({
        '0': [['08:00', '12:00']],
        '1': [['08:00', '12:00']],
        '2': [['08:00', '12:00']],
        '3': [['08:00', '12:00']],
        '4': [['08:00', '12:00']],
        '5': [['08:00', '12:00']],
        '6': [['08:00', '12:00']],
      }),
    ).toBe('todos los días de 8 a. m. a 12 p. m.')
  })

  it('dos días seguidos se dicen con "y" y tres o más con "de … a …"', () => {
    expect(formatOfficeHours({ '6': [['08:00', '13:00']], '0': [['08:00', '13:00']] })).toBe(
      'los sábados y domingos de 8 a. m. a 1 p. m.',
    )
    expect(
      formatOfficeHours({
        '1': [['09:00', '17:00']],
        '2': [['09:00', '17:00']],
      }),
    ).toBe('los lunes y martes de 9 a. m. a 5 p. m.')
    expect(
      formatOfficeHours({
        '5': [['09:00', '17:00']],
        '6': [['09:00', '17:00']],
        '0': [['09:00', '17:00']],
      }),
    ).toBe('de viernes a domingo de 9 a. m. a 5 p. m.')
  })

  it('días con el mismo horario pero no seguidos van en grupos aparte', () => {
    expect(
      formatOfficeHours({ '1': [['09:00', '17:00']], '3': [['09:00', '17:00']] }),
    ).toBe('los lunes de 9 a. m. a 5 p. m. y los miércoles de 9 a. m. a 5 p. m.')
  })

  it('dos tramos en un día', () => {
    expect(
      formatOfficeHours({
        '1': [
          ['08:00', '12:00'],
          ['14:00', '18:00'],
        ],
      }),
    ).toBe('los lunes de 8 a. m. a 12 p. m. y de 2 p. m. a 6 p. m.')
  })

  it('sin horario devuelve texto vacío', () => {
    expect(formatOfficeHours({})).toBe('')
  })

  it('en voz alta no lleva a. m. ni p. m.', () => {
    const spoken = formatOfficeHours(WEEK, { spoken: true })
    expect(spoken).toBe(
      'de lunes a viernes de 8 de la mañana a 6 de la tarde y los sábados de 8 de la mañana a 1 de la tarde',
    )
    expect(spoken).not.toMatch(/[ap]\. ?m\./)
  })
})

describe('spokenClockTime', () => {
  it.each([
    [8, 0, '8 de la mañana'],
    [11, 59, '11 y 59 de la mañana'],
    [12, 0, '12 del día'],
    [12, 30, '12 y media del día'],
    [13, 0, '1 de la tarde'],
    [15, 30, '3 y media de la tarde'],
    [15, 15, '3 y cuarto de la tarde'],
    [15, 45, '3 y 45 de la tarde'],
    [16, 5, '4 y 5 de la tarde'],
    [18, 0, '6 de la tarde'],
    [19, 0, '7 de la noche'],
    [23, 30, '11 y media de la noche'],
    [0, 0, '12 de la noche'],
    [3, 0, '3 de la madrugada'],
    [4, 59, '4 y 59 de la madrugada'],
    [5, 0, '5 de la mañana'],
    [6, 0, '6 de la mañana'],
  ])('%i:%i → %s', (hour, minute, expected) => {
    expect(spokenClockTime(hour, minute)).toBe(expected)
  })
})

describe('spokenAtTime', () => {
  it('"a las" salvo la una, que es "a la"', () => {
    expect(spokenAtTime(15, 30)).toBe('a las 3 y media de la tarde')
    expect(spokenAtTime(8, 0)).toBe('a las 8 de la mañana')
    expect(spokenAtTime(13, 0)).toBe('a la 1 de la tarde')
    expect(spokenAtTime(13, 30)).toBe('a la 1 y media de la tarde')
    expect(spokenAtTime(12, 0)).toBe('a las 12 del día')
  })
})
