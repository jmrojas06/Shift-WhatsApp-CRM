// ============================================================
// Horarios del robot de voz: atención a asesores, ventana de llamadas
// salientes y cómo decir una hora en voz alta. Todo puro.
//
// La hora es la de Bogotá (`agent/time.ts`), nunca la del servidor.
// Un festivo de Colombia cuenta como cerrado: ni se llama ni se pasa
// a un asesor.
// ============================================================

import { zonedParts } from '@/verticals/agenda/agent/time'

import { isColombianHoliday } from './co-holidays'

/**
 * Horario por día de la semana, igual que en `booking_call_settings.office_hours`:
 * `{"1": [["08:00","18:00"]], …, "6": [["08:00","13:00"]]}`. La clave es el día
 * (0 = domingo … 6 = sábado); un día sin clave está cerrado. Cada tramo es
 * `[abre, cierra]`; el minuto de cierre ya no cuenta como abierto.
 */
export type OfficeHours = Record<string, [string, string][]>

// ------------------------------------------------------------
// Lectura de horas
// ------------------------------------------------------------

/** 'H:MM', 'HH:MM' o 'HH:MM:SS' → 'HH:MM'; null si no es una hora de 00:00 a 23:59. */
export function normalizeClock(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${match[2]}`
}

/** Minutos desde la medianoche de un 'HH:MM'; null si no es una hora. */
function clockMinutes(value: unknown): number | null {
  const clock = normalizeClock(value)
  if (!clock) return null
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
}

const minutesToClock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/**
 * Lee un horario guardado (jsonb) sin lanzar: se queda con los días 0–6 y con
 * los tramos válidos (hora de inicio antes que la de cierre), los ordena y
 * junta los que se tocan o se cruzan. Lo demás se descarta.
 */
export function parseOfficeHours(raw: unknown): OfficeHours {
  const out: OfficeHours = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out

  for (let day = 0; day <= 6; day++) {
    const blocks = (raw as Record<string, unknown>)[String(day)]
    if (!Array.isArray(blocks)) continue

    const valid: [number, number][] = []
    for (const block of blocks) {
      if (!Array.isArray(block) || block.length !== 2) continue
      const start = clockMinutes(block[0])
      const end = clockMinutes(block[1])
      if (start === null || end === null || start >= end) continue
      valid.push([start, end])
    }
    valid.sort((a, b) => a[0] - b[0])

    const merged: [number, number][] = []
    for (const [start, end] of valid) {
      const last = merged[merged.length - 1]
      if (last && start <= last[1]) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    if (merged.length > 0) {
      out[String(day)] = merged.map(([start, end]) => [minutesToClock(start), minutesToClock(end)])
    }
  }
  return out
}

// ------------------------------------------------------------
// ¿Es hora de atender / de llamar?
// ------------------------------------------------------------

/** ¿`now` cae dentro del horario de atención? Un festivo es cerrado. */
export function isWithinOfficeHours(officeHours: OfficeHours, now: Date): boolean {
  const { dateKey, weekday, hour, minute } = zonedParts(now)
  if (isColombianHoliday(dateKey)) return false

  const blocks = officeHours[String(weekday)]
  if (!Array.isArray(blocks)) return false
  const current = hour * 60 + minute
  return blocks.some((block) => {
    if (!Array.isArray(block)) return false
    const start = clockMinutes(block[0])
    const end = clockMinutes(block[1])
    return start !== null && end !== null && current >= start && current < end
  })
}

/** Lo que `isWithinCallWindow` necesita de la configuración de llamadas. */
export interface CallWindow {
  windowStart: string
  windowEnd: string
  callSaturday: boolean
}

/**
 * ¿Se puede llamar ahora? De lunes a viernes, y el sábado solo si
 * `callSaturday`; nunca domingo ni festivo. Entre `windowStart` (incluida) y
 * `windowEnd` (no incluida). Una ventana dañada o al revés no llama nunca.
 */
export function isWithinCallWindow(settings: CallWindow, now: Date): boolean {
  const { dateKey, weekday, hour, minute } = zonedParts(now)
  if (weekday === 0) return false
  if (weekday === 6 && !settings.callSaturday) return false
  if (isColombianHoliday(dateKey)) return false

  const start = clockMinutes(settings.windowStart)
  const end = clockMinutes(settings.windowEnd)
  if (start === null || end === null || start >= end) return false
  const current = hour * 60 + minute
  return current >= start && current < end
}

// ------------------------------------------------------------
// Decir la hora
// ------------------------------------------------------------

/**
 * Parte del día como se dice en Colombia: de 1 a 4 es "de la madrugada", las
 * 6 p. m. todavía son "de la tarde" y desde las 7 p. m. "de la noche".
 */
function dayPeriod(hour: number): string {
  if (hour === 0) return 'de la noche'
  if (hour < 5) return 'de la madrugada'
  if (hour < 12) return 'de la mañana'
  if (hour === 12) return 'del día'
  if (hour < 19) return 'de la tarde'
  return 'de la noche'
}

/**
 * La hora como se dice en Colombia, sin "a las": "8 de la mañana",
 * "3 y media de la tarde", "12 del día". Nada de "a. m." ni "p. m.", que la
 * voz sintética lee mal.
 */
export function spokenClockTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  let minutes = ''
  if (minute === 15) minutes = ' y cuarto'
  else if (minute === 30) minutes = ' y media'
  else if (minute !== 0) minutes = ` y ${minute}`
  return `${h12}${minutes} ${dayPeriod(hour)}`
}

/** Igual, con la preposición: "a las 3 y media de la tarde", "a la 1 de la tarde". */
export function spokenAtTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12 === 1 ? 'a la' : 'a las'} ${spokenClockTime(hour, minute)}`
}

// ------------------------------------------------------------
// Horario escrito o dicho
// ------------------------------------------------------------

/** '8 a. m.', '4:30 p. m.' (sin minutos si son 0). */
function writtenClock(minutes: number): string {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const mm = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`
  return `${h12}${mm} ${hour < 12 ? 'a. m.' : 'p. m.'}`
}

const DAY_SINGULAR = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const DAY_PLURAL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados']
/** La semana empieza el lunes. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

export interface FormatOfficeHoursOptions {
  /** Para leerlo con voz sintética: "8 de la mañana" en vez de "8 a. m.". */
  spoken?: boolean
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`
}

/**
 * "de lunes a viernes de 8 a. m. a 6 p. m. y los sábados de 8 a. m. a 1 p. m."
 * Junta los días seguidos que tienen el mismo horario. Sin horario: ''.
 */
export function formatOfficeHours(
  officeHours: OfficeHours,
  options: FormatOfficeHoursOptions = {},
): string {
  const hours = parseOfficeHours(officeHours)
  const clock = (minutes: number): string =>
    options.spoken ? spokenClockTime(Math.floor(minutes / 60), minutes % 60) : writtenClock(minutes)

  // Un texto de horario por día (o null si está cerrado).
  const perDay = new Map<number, string>()
  for (const day of WEEK_ORDER) {
    const blocks = hours[String(day)]
    if (!blocks) continue
    perDay.set(
      day,
      blocks
        .map(([start, end]) => `de ${clock(clockMinutes(start) ?? 0)} a ${clock(clockMinutes(end) ?? 0)}`)
        .join(' y '),
    )
  }

  // Corridas de días seguidos (en orden lunes → domingo) con el mismo horario.
  const groups: string[] = []
  let index = 0
  while (index < WEEK_ORDER.length) {
    const text = perDay.get(WEEK_ORDER[index])
    if (text === undefined) {
      index++
      continue
    }
    let last = index
    while (last + 1 < WEEK_ORDER.length && perDay.get(WEEK_ORDER[last + 1]) === text) last++

    const first = WEEK_ORDER[index]
    const end = WEEK_ORDER[last]
    const length = last - index + 1
    let days: string
    if (length === WEEK_ORDER.length) days = 'todos los días'
    else if (length === 1) days = `los ${DAY_PLURAL[first]}`
    else if (length === 2) days = `los ${DAY_PLURAL[first]} y ${DAY_PLURAL[end]}`
    else days = `de ${DAY_SINGULAR[first]} a ${DAY_SINGULAR[end]}`
    groups.push(`${days} ${text}`)
    index = last + 1
  }

  return joinList(groups)
}
