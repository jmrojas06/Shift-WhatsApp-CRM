// ============================================================
// Horas libres que el panel ofrece al crear o mover una cita — puro,
// sin base de datos.
//
// La ruta GET /api/verticals/agenda/slots lee la query con
// `parseSlotsQuery` y devuelve las horas con `toPanelSlots`. El cálculo
// de las horas es el del bot (InternalBackend), así que el panel y el
// bot ofrecen exactamente lo mismo.
// ============================================================

import type { MergedSlot } from './agent/availability'
import { isUuid, type InputResult } from './panel-booking-input'

export interface SlotsQuery {
  serviceId: string
  /** null = cualquiera de los que atienden el servicio. */
  staffId: string | null
  /** Día local 'YYYY-MM-DD'. */
  dateKey: string
  /** Cita que no debe ocupar su propia hora: la que se está moviendo. */
  excludeAppointmentId: string | null
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message })

/** 'AAAA-MM-DD' que existe en el calendario (el 30 de febrero no). */
function isRealDateKey(value: string): boolean {
  const match = DATE_KEY.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

/** Un parámetro opcional: ausente o vacío es "no elegido". */
const optional = (params: URLSearchParams, key: string): string | null => {
  const value = params.get(key)?.trim()
  return value ? value : null
}

export function parseSlotsQuery(params: URLSearchParams): InputResult<SlotsQuery> {
  const serviceId = params.get('service_id')?.trim() ?? ''
  if (!isUuid(serviceId)) return fail('Elige la atención.')

  const staffId = optional(params, 'staff_id')
  if (staffId !== null && !isUuid(staffId)) return fail('Elige quién atiende.')

  const dateKey = params.get('date')?.trim() ?? ''
  if (!isRealDateKey(dateKey)) return fail('Elige un día válido.')

  const excludeAppointmentId = optional(params, 'exclude')
  if (excludeAppointmentId !== null && !isUuid(excludeAppointmentId)) {
    return fail('La cita elegida no es válida.')
  }

  return { ok: true, value: { serviceId, staffId, dateKey, excludeAppointmentId } }
}

export interface PanelSlot {
  /** Inicio de la hora, ISO en UTC. */
  starts_at: string
  /** Profesionales libres a esa hora, en el orden en que se leyeron. */
  staff_ids: string[]
}

export function toPanelSlots(slots: MergedSlot[]): PanelSlot[] {
  return slots.map((slot) => ({
    starts_at: slot.startsAt.toISOString(),
    staff_ids: [...slot.staffIds],
  }))
}
