// ============================================================
// Arma las columnas del calendario del panel — puro, sin React.
//
//   Día:    una columna por profesional (más "Sin asignar" si alguna cita
//           perdió a su profesional).
//   Semana: una columna por día, con el filtro de profesional.
//
// Cada columna trae lo que se dibuja: sus citas (ya sin las canceladas si
// no se piden), el horario que se sombrea y los bloqueos. La franja de
// horas es una sola para todo el calendario, para que las columnas se
// alineen.
// ============================================================

import { weekdayOfKey, zonedDateKey, zonedParts } from './agent/time'
import { visibleRange, weekDayKeys, type HourRange } from './calendar-layout'
import type { CalendarAppointment, CalendarData, CalendarTimeOff } from './calendar-data'

export type CalendarView = 'day' | 'week'

export interface HoursBlock {
  startTime: string
  endTime: string
}

export interface CalendarColumn {
  /** Clave estable para React. */
  key: string
  /** Día local 'YYYY-MM-DD' de esta columna. */
  dateKey: string
  /** Profesional de la columna; null = "Sin asignar" (día) o "todos" (semana). */
  staffId: string | null
  staffName: string | null
  isToday: boolean
  /** Horario a respetar ese día; null = la cuenta no ha cargado horarios (no se sombrea). */
  workBlocks: HoursBlock[] | null
  timeOff: CalendarTimeOff[]
  /** Citas del día en orden de hora. */
  appointments: CalendarAppointment[]
}

export interface BuildColumnsArgs {
  view: CalendarView
  /** En día: el día mostrado. En semana: cualquier día de esa semana. */
  dateKey: string
  data: CalendarData
  /** null = todos. */
  staffFilter: string | null
  showCancelled: boolean
  now: Date
}

export interface BuiltColumns {
  columns: CalendarColumn[]
  range: HourRange
  /** Canceladas que no se dibujan porque el interruptor está apagado. */
  hiddenCancelled: number
}

const dayOf = (a: CalendarAppointment): string => zonedParts(a.startsAt).dateKey

const byStart = (a: CalendarAppointment, b: CalendarAppointment): number =>
  a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id)

/** ¿El bloqueo toca ese día local? */
function touchesDay(off: CalendarTimeOff, dateKey: string): boolean {
  const first = zonedParts(off.startsAt).dateKey
  // El fin es exclusivo: un bloqueo que termina a la medianoche no toca el día siguiente.
  const last = zonedParts(new Date(off.endsAt.getTime() - 1)).dateKey
  return first <= dateKey && dateKey <= last
}

export function buildColumns(args: BuildColumnsArgs): BuiltColumns {
  const { view, dateKey, data, staffFilter, showCancelled, now } = args
  const today = zonedDateKey(now)

  const days = view === 'day' ? [dateKey] : weekDayKeys(dateKey, { includeSunday: true })
  const inView = new Set(days)

  // Citas de los días que se cargan, ya filtradas por profesional.
  const known = new Set(data.staff.map((s) => s.id))
  const inScope = data.appointments.filter((a) => {
    if (!inView.has(dayOf(a))) return false
    if (staffFilter) return a.staffId === staffFilter
    return true
  })
  const hiddenCancelled = showCancelled ? 0 : inScope.filter((a) => a.status === 'cancelled').length
  const visible = (showCancelled ? inScope : inScope.filter((a) => a.status !== 'cancelled')).sort(byStart)

  // Qué profesionales cuentan para el horario y la franja visible.
  const relevantStaff = data.staff.filter((s) => {
    if (staffFilter) return s.id === staffFilter
    return s.isActive || visible.some((a) => a.staffId === s.id)
  })
  const relevantIds = new Set(relevantStaff.map((s) => s.id))
  const relevantBlocks = data.workBlocks.filter((b) => relevantIds.has(b.staffId))
  const hasAnyHours = relevantBlocks.length > 0

  const range = visibleRange(relevantBlocks, visible)

  const blocksFor = (staffIds: Set<string>, dayKey: string): HoursBlock[] | null => {
    if (!hasAnyHours) return null
    const weekday = weekdayOfKey(dayKey)
    return relevantBlocks
      .filter((b) => staffIds.has(b.staffId) && b.weekday === weekday)
      .map((b) => ({ startTime: b.startTime, endTime: b.endTime }))
  }

  if (view === 'day') {
    const columns: CalendarColumn[] = relevantStaff.map((staff) => ({
      key: staff.id,
      dateKey,
      staffId: staff.id,
      staffName: staff.name,
      isToday: dateKey === today,
      workBlocks: blocksFor(new Set([staff.id]), dateKey),
      timeOff: data.timeOff.filter((t) => t.staffId === staff.id && touchesDay(t, dateKey)),
      appointments: visible.filter((a) => a.staffId === staff.id),
    }))

    // Citas cuyo profesional se borró: no se pierden, van a su propia columna.
    const orphans = visible.filter((a) => a.staffId === null || !known.has(a.staffId))
    if (orphans.length > 0 && !staffFilter) {
      columns.push({
        key: 'unassigned',
        dateKey,
        staffId: null,
        staffName: null,
        isToday: dateKey === today,
        workBlocks: null,
        timeOff: [],
        appointments: orphans,
      })
    }
    return { columns, range, hiddenCancelled }
  }

  // Semana: el domingo solo se dibuja si alguien trabaja o hay citas ese día.
  const sunday = days[6]
  const sundayUsed =
    visible.some((a) => dayOf(a) === sunday) || relevantBlocks.some((b) => b.weekday === 0)
  const weekKeys = sundayUsed ? days : days.slice(0, 6)

  const staffIds = staffFilter ? new Set([staffFilter]) : relevantIds
  const columns: CalendarColumn[] = weekKeys.map((dayKey) => ({
    key: dayKey,
    dateKey: dayKey,
    staffId: staffFilter,
    staffName: staffFilter ? (data.staff.find((s) => s.id === staffFilter)?.name ?? null) : null,
    isToday: dayKey === today,
    workBlocks: blocksFor(staffIds, dayKey),
    timeOff: staffFilter
      ? data.timeOff.filter((t) => t.staffId === staffFilter && touchesDay(t, dayKey))
      : [],
    appointments: visible.filter((a) => dayOf(a) === dayKey),
  }))
  return { columns, range, hiddenCancelled }
}
