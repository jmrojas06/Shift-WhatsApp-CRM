// ============================================================
// Cambios de estado de citas desde la agenda (/agenda) — puro.
//
// El bot crea citas `confirmed`; el equipo las cierra desde la
// agenda (completed / no_show / cancelled). Este módulo concentra
// las reglas que comparten la ruta API y la UI:
//
//   - Solo estados válidos del CHECK de la migración 047.
//   - No se sale de un estado terminal (cancelled/completed/no_show).
//   - Las citas ya pasadas exigen confirmación explícita
//     (`confirm_past`): editar historia nunca es un clic accidental.
//
// La ruta aplica la regla; la UI la usa para pedir la confirmación
// antes de reintentar. Una sola fuente de verdad.
// ============================================================

export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
] as const

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return (
    typeof value === 'string' &&
    (APPOINTMENT_STATUSES as readonly string[]).includes(value)
  )
}

/** Estados finales: la agenda no ofrece más cambios desde ellos. */
export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'cancelled',
  'completed',
  'no_show',
]

/** Transiciones que la agenda puede aplicar (el flujo del bot va aparte). */
const TRANSITIONS: Record<
  'pending' | 'confirmed',
  readonly AppointmentStatus[]
> = {
  pending: ['confirmed', 'completed', 'no_show', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
}

export type StatusChangeRejection =
  | 'invalid_status'
  | 'terminal_status'
  | 'invalid_transition'
  | 'past_confirmation_required'

export interface ValidateStatusChangeArgs {
  currentStatus: AppointmentStatus
  /** Estado pedido tal como llegó del cliente (sin confiar en su tipo). */
  nextStatus: unknown
  startsAt: Date
  now: Date
  /** El humano ya confirmó que edita una cita pasada. */
  confirmPast: boolean
}

export type StatusChangeResult =
  | { ok: true; nextStatus: AppointmentStatus }
  | { ok: false; code: StatusChangeRejection }

export function validateStatusChange(
  args: ValidateStatusChangeArgs,
): StatusChangeResult {
  const { currentStatus, nextStatus, startsAt, now, confirmPast } = args

  if (!isAppointmentStatus(nextStatus)) {
    return { ok: false, code: 'invalid_status' }
  }
  if (TERMINAL_APPOINTMENT_STATUSES.includes(currentStatus)) {
    return { ok: false, code: 'terminal_status' }
  }
  if (nextStatus === currentStatus) {
    return { ok: false, code: 'invalid_transition' }
  }
  const allowed = TRANSITIONS[currentStatus as 'pending' | 'confirmed']
  if (!allowed.includes(nextStatus)) {
    return { ok: false, code: 'invalid_transition' }
  }
  if (startsAt.getTime() < now.getTime() && !confirmPast) {
    return { ok: false, code: 'past_confirmation_required' }
  }
  return { ok: true, nextStatus }
}
