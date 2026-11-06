// ============================================================
// Festivos de Colombia, calculados (sin lista a mano ni red).
//
// El robot nunca llama en festivo y la atención de asesores tampoco
// cuenta un festivo como horario de atención. Hay tres clases:
//
//   1. Fijos: no se mueven aunque caigan en fin de semana
//      (1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic).
//   2. Ley Emiliani (Ley 51 de 1983): si no caen en lunes, pasan al lunes
//      siguiente (6 ene, 19 mar, 29 jun, 15 ago, 12 oct, 1 nov, 11 nov y,
//      desde 2026, el 9 de julio).
//   3. De Pascua: Jueves y Viernes Santo no se mueven; Ascensión (Pascua +
//      43 días), Corpus Christi (+ 64) y Sagrado Corazón (+ 71) ya son lunes.
//
// 9 de julio: la Ley 2578 del 1 de junio de 2026 (Diario Oficial 53.510,
// vigente desde su promulgación) declaró festivo el Día de Nuestra Señora
// del Rosario de Chiquinquirá y manda aplicar la Ley 51 de 1983. En 2026 se
// descansó el lunes 13 de julio; en 2027 será el lunes 12.
//
// Si el mismo lunes cae por dos reglas (en 2025 el Sagrado Corazón y San
// Pedro y San Pablo cayeron el 30 de junio), la fecha sale una sola vez.
// ============================================================

import { addDaysToKey, weekdayOfKey } from '@/verticals/agenda/agent/time'

/** Primer año en que el 9 de julio es festivo (Ley 2578 de 2026). */
const CHIQUINQUIRA_FIRST_YEAR = 2026

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Domingo de Pascua ('YYYY-MM-DD'): algoritmo de Meeus/Jones/Butcher (calendario gregoriano). */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** El mismo día si es lunes; si no, el lunes siguiente (Ley Emiliani). */
function toMonday(dateKey: string): string {
  const weekday = weekdayOfKey(dateKey) // 0 = domingo
  return addDaysToKey(dateKey, (8 - weekday) % 7)
}

const cache = new Map<number, readonly string[]>()

/**
 * Festivos de Colombia de un año, 'YYYY-MM-DD', ordenados y sin repetidos.
 * Devuelve una copia nueva cada vez.
 */
export function colombianHolidays(year: number): string[] {
  let list = cache.get(year)
  if (!list) {
    const fixed = [`${year}-01-01`, `${year}-05-01`, `${year}-07-20`, `${year}-08-07`, `${year}-12-08`, `${year}-12-25`]

    const emiliani = [
      `${year}-01-06`,
      `${year}-03-19`,
      `${year}-06-29`,
      `${year}-08-15`,
      `${year}-10-12`,
      `${year}-11-01`,
      `${year}-11-11`,
    ]
    if (year >= CHIQUINQUIRA_FIRST_YEAR) emiliani.push(`${year}-07-09`)

    const easter = easterSunday(year)
    const easterBased = [
      addDaysToKey(easter, -3), // Jueves Santo
      addDaysToKey(easter, -2), // Viernes Santo
      addDaysToKey(easter, 43), // Ascensión
      addDaysToKey(easter, 64), // Corpus Christi
      addDaysToKey(easter, 71), // Sagrado Corazón
    ]

    list = [...new Set([...fixed, ...emiliani.map(toMonday), ...easterBased])].sort()
    cache.set(year, list)
  }
  return [...list]
}

/** ¿'YYYY-MM-DD' es festivo en Colombia? */
export function isColombianHoliday(dateKey: string): boolean {
  const year = Number(dateKey.slice(0, 4))
  if (!Number.isInteger(year)) return false
  return colombianHolidays(year).includes(dateKey)
}
