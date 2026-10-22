// ============================================================
// Helpers de zona horaria para el controlador de barbería.
//
// Toda la lógica es pura y recibe las fechas como `Date` (UTC):
//   - Las horas de la conversación se calculan y muestran en
//     America/Bogota; en base de datos se guarda siempre
//     `timestamptz` (instantes UTC).
//   - La zona horaria llega por parámetro (default Bogotá) y se
//     resuelve con Intl, NUNCA con la zona del proceso: los tests
//     corren igual en cualquier máquina.
//
// Bogotá no tiene horario de verano (UTC-5 fijo), pero el cálculo
// de desfase es genérico para que la próxima vertical reutilice
// estos helpers sin cambios.
// ============================================================

export const AGENDA_TZ = 'America/Bogota'

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Desfase (ms) de la zona en un instante: local = UTC + desfase. */
function zoneOffsetMs(instantMs: number, tz: string): number {
  // Redondeo a segundos: los bookings siempre están al minuto, y
  // así el desfase no arrastra milisegundos del instante.
  const base = Math.floor(instantMs / 1000) * 1000
  const parts = formatter(tz).formatToParts(new Date(base))
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - base
}

export interface ZonedParts {
  /** 'YYYY-MM-DD' en la zona. */
  dateKey: string
  /** 0 = domingo … 6 = sábado, igual que `extract(dow)` y JS. */
  weekday: number
  /** Hora local (0–23). */
  hour: number
  /** Minuto local (0–59). */
  minute: number
}

/** Descompone un instante en su hora local de la zona. */
export function zonedParts(instant: Date, tz: string = AGENDA_TZ): ZonedParts {
  const shifted = new Date(instant.getTime() + zoneOffsetMs(instant.getTime(), tz))
  return {
    dateKey: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/** 'YYYY-MM-DD' de la zona para un instante. */
export function zonedDateKey(instant: Date, tz: string = AGENDA_TZ): string {
  return zonedParts(instant, tz).dateKey
}

/** Instante UTC de una hora local 'YYYY-MM-DD' + 'HH:MM'. */
export function zonedTimeToUtc(
  dateKey: string,
  time: string,
  tz: string = AGENDA_TZ,
): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const target = Date.UTC(y, m - 1, d, hh, mm)
  // Dos pasadas: la primera aproxima, la segunda corrige si el
  // desfase cambia en la frontera (DST en otras zonas; Bogotá no).
  let guess = target
  for (let i = 0; i < 2; i++) guess = target - zoneOffsetMs(guess, tz)
  return new Date(guess)
}

/** Medianoche local de 'YYYY-MM-DD' como instante UTC. */
export function startOfZonedDay(
  dateKey: string,
  tz: string = AGENDA_TZ,
): Date {
  return zonedTimeToUtc(dateKey, '00:00', tz)
}

/** Día de la semana (0 = domingo) de una fecha local. */
export function weekdayOfKey(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Suma días a una fecha local (cruce de mes/año incluido). */
export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
}
