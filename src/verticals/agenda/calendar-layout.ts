// ============================================================
// Geometría del calendario del panel (/agenda/calendario) — puro,
// sin React ni base de datos.
//
// Todo se mide en minutos del día local de Bogotá y se entrega en
// porcentaje de la franja visible, para que la pantalla solo ponga
// `top` y `height` en CSS sin saber de horas:
//
//   - `visibleRange`   qué horas se muestran (6 a 22 por defecto,
//                      ajustadas al horario del equipo y a las citas).
//   - `layoutDay`      posición de cada cita y carril cuando se cruzan.
//   - `offHoursBands`  lo que queda fuera del horario de un profesional.
//   - `intervalBand`   un bloqueo, o cualquier tramo, dentro de un día.
//   - `startOfWeekKey` y `weekDayKeys`: la semana empieza el lunes.
// ============================================================

import { addDaysToKey, startOfZonedDay, weekdayOfKey, zonedParts } from './agent/time'

/** Franja por defecto cuando aún no hay horarios cargados. */
export const DEFAULT_START_HOUR = 6
export const DEFAULT_END_HOUR = 22
/** Nunca se muestran menos horas que estas, aunque el horario sea corto. */
export const MIN_SPAN_HOURS = 4
/** Una cita muy corta (o sin duración) se dibuja como mínimo de este largo. */
export const MIN_BLOCK_MINUTES = 15

export interface HourRange {
  /** Primera hora visible, 0 a 23. */
  startHour: number
  /** Hora donde termina la franja, 1 a 24 (no se dibuja esa hora). */
  endHour: number
}

/** Un tramo vertical, en porcentaje de la franja visible (0 a 100). */
export interface Band {
  top: number
  height: number
}

export interface LayoutItem {
  id: string
  startsAt: Date
  endsAt: Date
}

export interface PositionedItem<T extends LayoutItem> extends Band {
  item: T
  /** Minutos desde el inicio de la franja visible. */
  topMinutes: number
  heightMinutes: number
  /** Carril (columna) dentro del grupo de citas que se cruzan, desde 0. */
  lane: number
  /** Cuántos carriles tiene ese grupo: el ancho de la cita es 1/lanes. */
  lanes: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** 'HH:MM' o 'HH:MM:SS' → minutos desde la medianoche ('24:00:00' vale 1440). */
function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + (m || 0)
}

/** Minutos desde la medianoche local en que cae un instante. */
function localMinutes(instant: Date): number {
  const { hour, minute } = zonedParts(instant)
  return hour * 60 + minute
}

/**
 * Horas que se muestran. Sin horarios: de 6 a 22. Con horarios: del primer
 * inicio al último fin del equipo, con una hora de margen a cada lado para
 * poder agendar apenas fuera de horario. Si hay citas que sobresalen, la
 * franja se estira para que se vean. Siempre dentro del día y de al menos
 * MIN_SPAN_HOURS.
 */
export function visibleRange(
  workBlocks: { startTime: string; endTime: string }[],
  items: { startsAt: Date; endsAt: Date }[] = [],
): HourRange {
  let startHour = DEFAULT_START_HOUR
  let endHour = DEFAULT_END_HOUR

  if (workBlocks.length > 0) {
    const first = Math.min(...workBlocks.map((b) => toMinutes(b.startTime)))
    const last = Math.max(...workBlocks.map((b) => toMinutes(b.endTime)))
    startHour = Math.floor(first / 60) - 1
    endHour = Math.ceil(last / 60) + 1
  }

  for (const item of items) {
    const start = localMinutes(item.startsAt)
    const end = start + Math.max(MIN_BLOCK_MINUTES, (item.endsAt.getTime() - item.startsAt.getTime()) / 60_000)
    startHour = Math.min(startHour, Math.floor(start / 60))
    endHour = Math.max(endHour, Math.ceil(end / 60))
  }

  startHour = clamp(startHour, 0, 23)
  endHour = clamp(endHour, 1, 24)
  if (endHour - startHour < MIN_SPAN_HOURS) {
    endHour = Math.min(24, startHour + MIN_SPAN_HOURS)
    startHour = Math.max(0, endHour - MIN_SPAN_HOURS)
  }
  return { startHour, endHour }
}

const spanMinutes = (range: HourRange): number => (range.endHour - range.startHour) * 60

/** Cada hora de la franja con su posición, para las líneas y la columna de horas. */
export function hourLabels(range: HourRange): { hour: number; top: number }[] {
  const out: { hour: number; top: number }[] = []
  for (let hour = range.startHour; hour < range.endHour; hour++) {
    out.push({ hour, top: ((hour - range.startHour) / (range.endHour - range.startHour)) * 100 })
  }
  return out
}

/** Un tramo [from, to) en minutos del día → porcentaje de la franja, o null si no la toca. */
function bandFromMinutes(from: number, to: number, range: HourRange): Band | null {
  const rangeStart = range.startHour * 60
  const rangeEnd = range.endHour * 60
  const start = Math.max(from, rangeStart)
  const end = Math.min(to, rangeEnd)
  if (end <= start) return null
  const span = spanMinutes(range)
  return { top: ((start - rangeStart) / span) * 100, height: ((end - start) / span) * 100 }
}

/**
 * Posiciona las citas de UN día. Las que se cruzan se reparten en carriles
 * (como el calendario de Google): el grupo de citas encadenadas por cruces
 * comparte el mismo número de carriles. Lo que cae por completo fuera de la
 * franja no se devuelve: quien llama debe estirar la franja con
 * `visibleRange(…, items)`.
 */
export function layoutDay<T extends LayoutItem>(
  items: T[],
  range: HourRange,
): PositionedItem<T>[] {
  const rangeStart = range.startHour * 60
  const rangeEnd = range.endHour * 60
  const span = spanMinutes(range)

  const measured = items
    .map((item) => {
      const start = localMinutes(item.startsAt)
      const length = Math.max(
        MIN_BLOCK_MINUTES,
        Math.round((item.endsAt.getTime() - item.startsAt.getTime()) / 60_000),
      )
      return { item, start, end: start + length }
    })
    .filter((m) => m.end > rangeStart && m.start < rangeEnd)
    // Primero la que empieza antes; a igual hora, la más larga.
    .sort((a, b) => a.start - b.start || b.end - a.end || a.item.id.localeCompare(b.item.id))

  const placed: PositionedItem<T>[] = []
  let cluster: PositionedItem<T>[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity

  const closeCluster = () => {
    for (const block of cluster) block.lanes = laneEnds.length
    cluster = []
    laneEnds = []
  }

  for (const m of measured) {
    if (m.start >= clusterEnd) {
      closeCluster()
      clusterEnd = -Infinity
    }
    let lane = laneEnds.findIndex((end) => end <= m.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(m.end)
    } else {
      laneEnds[lane] = m.end
    }
    clusterEnd = Math.max(clusterEnd, m.end)

    const from = Math.max(m.start, rangeStart)
    const to = Math.min(m.end, rangeEnd)
    const block: PositionedItem<T> = {
      item: m.item,
      topMinutes: from - rangeStart,
      heightMinutes: to - from,
      top: ((from - rangeStart) / span) * 100,
      height: ((to - from) / span) * 100,
      lane,
      lanes: 1,
    }
    cluster.push(block)
    placed.push(block)
  }
  closeCluster()

  return placed
}

/**
 * Tramos fuera del horario de un profesional ese día, para sombrearlos. Sin
 * bloques de trabajo, todo el día queda sombreado.
 */
export function offHoursBands(
  blocks: { startTime: string; endTime: string }[],
  range: HourRange,
): Band[] {
  const rangeStart = range.startHour * 60
  const rangeEnd = range.endHour * 60
  const sorted = blocks
    .map((b) => ({ from: toMinutes(b.startTime), to: toMinutes(b.endTime) }))
    .filter((b) => b.to > b.from)
    .sort((a, b) => a.from - b.from)

  const bands: Band[] = []
  let cursor = rangeStart
  for (const block of sorted) {
    if (block.from > cursor) {
      const band = bandFromMinutes(cursor, block.from, range)
      if (band) bands.push(band)
    }
    cursor = Math.max(cursor, block.to)
  }
  if (cursor < rangeEnd) {
    const band = bandFromMinutes(cursor, rangeEnd, range)
    if (band) bands.push(band)
  }
  return bands
}

/**
 * El tramo [startsAt, endsAt) recortado al día local `dateKey` y a la franja
 * visible. Sirve para los bloqueos (vacaciones, permisos), que pueden durar
 * varios días, y para la línea de "ahora".
 */
export function intervalBand(
  startsAt: Date,
  endsAt: Date,
  dateKey: string,
  range: HourRange,
): Band | null {
  const dayStart = startOfZonedDay(dateKey).getTime()
  const dayEnd = startOfZonedDay(addDaysToKey(dateKey, 1)).getTime()
  const from = Math.max(startsAt.getTime(), dayStart)
  const to = Math.min(endsAt.getTime(), dayEnd)
  if (to <= from) return null
  return bandFromMinutes((from - dayStart) / 60_000, (to - dayStart) / 60_000, range)
}

/** Posición (0 a 100) de un instante dentro de la franja de su día, o null si queda fuera. */
export function pointPosition(instant: Date, dateKey: string, range: HourRange): number | null {
  const dayStart = startOfZonedDay(dateKey).getTime()
  const minutes = (instant.getTime() - dayStart) / 60_000
  const rangeStart = range.startHour * 60
  const rangeEnd = range.endHour * 60
  if (minutes < rangeStart || minutes >= rangeEnd) return null
  return ((minutes - rangeStart) / spanMinutes(range)) * 100
}

/** El lunes de la semana de `dateKey`. */
export function startOfWeekKey(dateKey: string): string {
  const weekday = weekdayOfKey(dateKey) // 0 = domingo
  return addDaysToKey(dateKey, -((weekday + 6) % 7))
}

/** Los días de la semana de `dateKey`, de lunes a domingo (o hasta el sábado). */
export function weekDayKeys(dateKey: string, opts: { includeSunday: boolean }): string[] {
  const monday = startOfWeekKey(dateKey)
  const count = opts.includeSunday ? 7 : 6
  return Array.from({ length: count }, (_, i) => addDaysToKey(monday, i))
}

// ------------------------------------------------------------
// Textos de fecha y hora (deterministas: sin Intl de fechas)
// ------------------------------------------------------------

const MONTH_LONG = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

/** 7 → '7 a. m.', 12 → '12 p. m.' (columna de horas). */
export function formatHourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${hour % 24 < 12 ? 'a. m.' : 'p. m.'}`
}

/** Hora local corta para dentro de una cita: '9:05', '1:30'. */
export function formatClock(instant: Date): string {
  const { hour, minute } = zonedParts(instant)
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${String(minute).padStart(2, '0')}`
}

/** '9 al 15 de noviembre de 2026', con el mes y el año donde cambian. */
export function formatWeekRange(
  dateKey: string,
  opts: { includeSunday: boolean } = { includeSunday: true },
): string {
  const days = weekDayKeys(dateKey, opts)
  const [y1, m1, d1] = days[0].split('-').map(Number)
  const [y2, m2, d2] = days[days.length - 1].split('-').map(Number)
  if (y1 !== y2) return `${d1} de ${MONTH_LONG[m1 - 1]} de ${y1} al ${d2} de ${MONTH_LONG[m2 - 1]} de ${y2}`
  if (m1 !== m2) return `${d1} de ${MONTH_LONG[m1 - 1]} al ${d2} de ${MONTH_LONG[m2 - 1]} de ${y2}`
  return `${d1} al ${d2} de ${MONTH_LONG[m2 - 1]} de ${y2}`
}
