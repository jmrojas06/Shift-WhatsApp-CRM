// ============================================================
// Estado del calendario en la dirección de la página — puro.
//
//   /agenda/calendario?vista=semana&dia=2026-11-12&profesional=<uuid>
//
// Así recargar, volver atrás o compartir el enlace deja la misma vista.
// Solo se escribe lo que cambia respecto a lo de siempre (día, hoy,
// todos); lo que no es válido se descarta sin avisar.
// ============================================================

import type { CalendarView } from './calendar-columns'
import { isUuid } from './panel-booking-input'

export interface CalendarUrlState {
  view?: CalendarView
  dateKey?: string
  staffId?: string
}

/** 'AAAA-MM-DD' que existe en el calendario (el 30 de febrero no). */
function isRealDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function parseCalendarUrl(search: string): CalendarUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const out: CalendarUrlState = {}

  const view = params.get('vista')
  if (view === 'semana') out.view = 'week'
  else if (view === 'dia') out.view = 'day'

  const day = params.get('dia')
  if (day && isRealDateKey(day)) out.dateKey = day

  const staff = params.get('profesional')
  if (staff && isUuid(staff)) out.staffId = staff

  return out
}

/** '' cuando todo está en lo de siempre; si no, '?…' listo para pegar a la ruta. */
export function buildCalendarSearch(
  state: { view: CalendarView; dateKey: string; staffId: string | null },
  todayKey: string,
): string {
  const params = new URLSearchParams()
  if (state.view === 'week') params.set('vista', 'semana')
  if (state.dateKey !== todayKey) params.set('dia', state.dateKey)
  if (state.staffId) params.set('profesional', state.staffId)
  const text = params.toString()
  return text ? `?${text}` : ''
}
