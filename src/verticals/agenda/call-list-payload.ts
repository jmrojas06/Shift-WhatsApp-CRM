// ============================================================
// Lo que /api/verticals/agenda/calls entrega en GET, en snake_case como el
// resto de las rutas de la agenda, y su vuelta a las filas de la pantalla.
//
// Sin dependencias del servidor (solo tipos): lo usan la ruta y el navegador.
// ============================================================

import type { CallListLastCall, CallListReason, CallListRow } from './call-list'

export interface CallListLastCallPayload {
  outcome: CallListLastCall['outcome']
  status: CallListLastCall['status']
  at: string
}

export interface CallListRowPayload {
  appointment_id: string
  starts_at: string
  contact_id: string
  patient_name: string | null
  contact_name: string | null
  phone: string | null
  staff_name: string | null
  reason: CallListReason
  robot_attempts: number
  manual_attempts: number
  last_robot: CallListLastCallPayload | null
  last_manual: CallListLastCallPayload | null
  robot_in_progress: boolean
  can_robot_call: boolean
}

export interface CallListResponse {
  rows: CallListRowPayload[]
  /** Las llamadas salientes están prendidas: se muestra "Llamar con el robot ahora". */
  outbound_enabled: boolean
}

const lastToPayload = (last: CallListLastCall | null): CallListLastCallPayload | null =>
  last ? { outcome: last.outcome, status: last.status, at: last.at } : null

export function callListRowToPayload(row: CallListRow): CallListRowPayload {
  return {
    appointment_id: row.appointmentId,
    starts_at: row.startsAt,
    contact_id: row.contactId,
    patient_name: row.patientName,
    contact_name: row.contactName,
    phone: row.phone,
    staff_name: row.staffName,
    reason: row.reason,
    robot_attempts: row.robotAttempts,
    manual_attempts: row.manualAttempts,
    last_robot: lastToPayload(row.lastRobot),
    last_manual: lastToPayload(row.lastManual),
    robot_in_progress: row.robotInProgress,
    can_robot_call: row.canRobotCall,
  }
}

const REASONS: readonly CallListReason[] = [
  'reminder_unanswered',
  'robot_human',
  'robot_advisor_missed',
  'robot_no_response',
  'robot_failed',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

function lastFromPayload(value: unknown): CallListLastCall | null {
  if (!isRecord(value) || typeof value.status !== 'string' || typeof value.at !== 'string') return null
  return {
    outcome: (str(value.outcome) as CallListLastCall['outcome']) ?? null,
    status: value.status as CallListLastCall['status'],
    at: value.at,
  }
}

/** Lee una fila que llegó por la red; descarta la que viene rota en vez de romper la pantalla. */
export function callListRowFromPayload(raw: unknown): CallListRow | null {
  if (!isRecord(raw)) return null
  const appointmentId = str(raw.appointment_id)
  const startsAt = str(raw.starts_at)
  const contactId = str(raw.contact_id)
  const reason = REASONS.find((r) => r === raw.reason)
  if (!appointmentId || !startsAt || !contactId || !reason) return null

  return {
    appointmentId,
    startsAt,
    contactId,
    patientName: str(raw.patient_name),
    contactName: str(raw.contact_name),
    phone: str(raw.phone),
    staffName: str(raw.staff_name),
    reason,
    robotAttempts: typeof raw.robot_attempts === 'number' ? raw.robot_attempts : 0,
    manualAttempts: typeof raw.manual_attempts === 'number' ? raw.manual_attempts : 0,
    lastRobot: lastFromPayload(raw.last_robot),
    lastManual: lastFromPayload(raw.last_manual),
    robotInProgress: raw.robot_in_progress === true,
    canRobotCall: raw.can_robot_call === true,
  }
}
