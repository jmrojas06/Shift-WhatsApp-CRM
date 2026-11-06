import { describe, expect, it } from 'vitest'

import { colombianHolidays, easterSunday, isColombianHoliday } from './co-holidays'

// Listas oficiales (decretos y calendarios del Gobierno de Colombia).
//
// Además de los 18 festivos de siempre, la Ley 2578 del 1 de junio de 2026
// (Diario Oficial 53.510, vigente desde su promulgación) declaró el 9 de
// julio de cada año como festivo, el Día de Nuestra Señora del Rosario de
// Chiquinquirá, y manda aplicar la Ley 51 de 1983 (Emiliani, pasa al lunes
// siguiente): en 2026 se descansa el lunes 13 de julio y en 2027 el lunes 12.
const OFFICIAL_2026 = [
  '2026-01-01', // Año Nuevo
  '2026-01-12', // Reyes Magos
  '2026-03-23', // San José
  '2026-04-02', // Jueves Santo
  '2026-04-03', // Viernes Santo
  '2026-05-01', // Día del Trabajo
  '2026-05-18', // Ascensión
  '2026-06-08', // Corpus Christi
  '2026-06-15', // Sagrado Corazón
  '2026-06-29', // San Pedro y San Pablo
  '2026-07-13', // Virgen de Chiquinquirá (Ley 2578 de 2026)
  '2026-07-20', // Independencia
  '2026-08-07', // Batalla de Boyacá
  '2026-08-17', // Asunción
  '2026-10-12', // Día de la Raza
  '2026-11-02', // Todos los Santos
  '2026-11-16', // Independencia de Cartagena
  '2026-12-08', // Inmaculada Concepción
  '2026-12-25', // Navidad
]

const OFFICIAL_2027 = [
  '2027-01-01',
  '2027-01-11',
  '2027-03-22',
  '2027-03-25',
  '2027-03-26',
  '2027-05-01', // sábado
  '2027-05-10',
  '2027-05-31',
  '2027-06-07',
  '2027-07-05',
  '2027-07-12', // Virgen de Chiquinquirá (Ley 2578 de 2026)
  '2027-07-20',
  '2027-08-07', // sábado
  '2027-08-16',
  '2027-10-18',
  '2027-11-01',
  '2027-11-15',
  '2027-12-08',
  '2027-12-25', // sábado
]

// Antes de la Ley 2578 (año 2025): 17 fechas, porque el Sagrado Corazón y
// San Pedro y San Pablo cayeron el mismo lunes 30 de junio.
const OFFICIAL_2025 = [
  '2025-01-01',
  '2025-01-06',
  '2025-03-24',
  '2025-04-17',
  '2025-04-18',
  '2025-05-01',
  '2025-06-02',
  '2025-06-23',
  '2025-06-30',
  '2025-07-20',
  '2025-08-07',
  '2025-08-18',
  '2025-10-13',
  '2025-11-03',
  '2025-11-17',
  '2025-12-08',
  '2025-12-25',
]

describe('easterSunday', () => {
  it('Pascua 2026 es el 5 de abril y la de 2027 el 28 de marzo', () => {
    expect(easterSunday(2026)).toBe('2026-04-05')
    expect(easterSunday(2027)).toBe('2027-03-28')
  })

  it('coincide con otras Pascuas conocidas', () => {
    expect(easterSunday(2019)).toBe('2019-04-21')
    expect(easterSunday(2024)).toBe('2024-03-31')
    expect(easterSunday(2025)).toBe('2025-04-20')
    expect(easterSunday(2028)).toBe('2028-04-16')
    expect(easterSunday(2030)).toBe('2030-04-21')
    // La más tardía y la más temprana del calendario gregoriano.
    expect(easterSunday(2038)).toBe('2038-04-25')
    expect(easterSunday(2285)).toBe('2285-03-22')
  })
})

describe('colombianHolidays', () => {
  it('2026 es la lista oficial', () => {
    expect(colombianHolidays(2026)).toEqual(OFFICIAL_2026)
  })

  it('2027 es la lista oficial', () => {
    expect(colombianHolidays(2027)).toEqual(OFFICIAL_2027)
  })

  it('2025 (antes de la Ley 2578) es la lista oficial, sin repetir el 30 de junio', () => {
    expect(colombianHolidays(2025)).toEqual(OFFICIAL_2025)
  })

  it('viene ordenada, sin repetidos y con formato YYYY-MM-DD', () => {
    for (const year of [2024, 2026, 2027, 2028, 2030, 2035]) {
      const list = colombianHolidays(year)
      expect(list).toEqual([...new Set(list)].sort())
      for (const key of list) expect(key).toMatch(new RegExp(`^${year}-\\d{2}-\\d{2}$`))
    }
  })

  it('cada festivo Emiliani cae en el primer lunes desde su fecha (calculado aparte, 2026–2040)', () => {
    const emiliani = ['01-06', '03-19', '06-29', '07-09', '08-15', '10-12', '11-01', '11-11']
    for (let year = 2026; year <= 2040; year++) {
      const list = colombianHolidays(year)
      for (const monthDay of emiliani) {
        const [m, d] = monthDay.split('-').map(Number)
        const base = new Date(Date.UTC(year, m - 1, d))
        const shift = (8 - base.getUTCDay()) % 7 // domingo +1, lunes +0, martes +6…
        const monday = new Date(base.getTime() + shift * 86_400_000)
        expect(monday.getUTCDay()).toBe(1)
        expect(list).toContain(monday.toISOString().slice(0, 10))
      }
    }
  })

  it('los de Semana Santa y los que dependen de ella quedan donde toca (2028)', () => {
    // Pascua 2028 = 16 de abril.
    const list = colombianHolidays(2028)
    expect(list).toContain('2028-04-13') // Jueves Santo
    expect(list).toContain('2028-04-14') // Viernes Santo
    expect(list).toContain('2028-05-29') // Ascensión (Pascua + 43, lunes)
    expect(list).toContain('2028-06-19') // Corpus Christi (+ 64, lunes)
    expect(list).toContain('2028-06-26') // Sagrado Corazón (+ 71, lunes)
  })

  it('un festivo Emiliani que ya cae en lunes no se mueve (29 de junio 2026, 1 de noviembre 2027)', () => {
    expect(colombianHolidays(2026)).toContain('2026-06-29')
    expect(colombianHolidays(2027)).toContain('2027-11-01')
  })

  it('un festivo fijo no se mueve aunque caiga en fin de semana', () => {
    expect(colombianHolidays(2027)).toContain('2027-05-01') // sábado
    expect(colombianHolidays(2027)).toContain('2027-12-25') // sábado
    expect(colombianHolidays(2027)).not.toContain('2027-05-03')
  })

  it('el 9 de julio solo es festivo desde 2026', () => {
    expect(colombianHolidays(2025).some((key) => key.startsWith('2025-07-1'))).toBe(false)
    expect(colombianHolidays(2024).some((key) => key.startsWith('2024-07-1'))).toBe(false)
    expect(colombianHolidays(2028)).toContain('2028-07-10') // 9 de julio de 2028 es domingo
  })

  it('devuelve una copia: modificarla no daña el caché', () => {
    const first = colombianHolidays(2026)
    first.pop()
    expect(colombianHolidays(2026)).toEqual(OFFICIAL_2026)
  })
})

describe('isColombianHoliday', () => {
  it('reconoce festivos y días normales', () => {
    expect(isColombianHoliday('2026-11-02')).toBe(true)
    expect(isColombianHoliday('2026-11-03')).toBe(false)
    expect(isColombianHoliday('2027-03-26')).toBe(true)
    expect(isColombianHoliday('2026-07-13')).toBe(true)
  })
})
