// ============================================================
// Reglas de las citas que la recepción crea o mueve desde el
// panel — puro, sin base de datos ni red.
//
// El bot solo ofrece horas que caben en el horario del profesional
// (availability.ts). El panel es más flexible a propósito: la
// recepción puede agendar "fuera de horario" si lo confirma
// (`outsideHoursOk`). Pero hay límites que nunca se saltan: la hora
// no puede estar en el pasado, el profesional debe atender el
// servicio y, en una clínica, tiene que quedar un sillón libre.
//
// La ruta de crear y la de mover llaman a `validatePanelBooking`
// con los datos ya leídos; el choque exacto con otra cita del
// profesional (23P01) lo decide la base y la ruta lo traduce a
// `slot_taken`.
// ============================================================

import type { WorkBlock } from './agent/availability'
import { chairsFreeAt, type ChairContext } from './agent/chairs'
import { zonedParts, zonedTimeToUtc } from './agent/time'
import type { AppointmentStatus } from './appointments'
import { DEFAULT_LABELS, type AgendaLabels } from './labels'

export type PanelBookingRejection =
  | 'invalid_input'
  | 'past'
  | 'staff_not_for_service'
  | 'outside_hours'
  | 'not_editable'
  | 'chairs_full'

/** Todo lo que el panel le puede decir a la recepción al crear o mover. */
export type PanelBookingMessageCode = PanelBookingRejection | 'slot_taken' | 'stale'

/** Tope de duración que pone la base (CHECK de `booking_services`). */
const MAX_DURATION_MINUTES = 480

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime())

/**
 * ¿La cita cabe ENTERA en un bloque de trabajo del día local? Igual que el
 * bot: el día de la semana es el local de Bogotá y la cita no puede repartirse
 * entre dos bloques ni cruzar la medianoche.
 */
function fitsInWorkBlock(startsAt: Date, endsAt: Date, workBlocks: WorkBlock[]): boolean {
  const { dateKey, weekday } = zonedParts(startsAt)
  return workBlocks.some((block) => {
    if (block.weekday !== weekday) return false
    const from = zonedTimeToUtc(dateKey, block.startTime).getTime()
    const to = zonedTimeToUtc(dateKey, block.endTime).getTime()
    return startsAt.getTime() >= from && endsAt.getTime() <= to
  })
}

export interface ValidatePanelBookingArgs {
  startsAt: Date
  durationMinutes: number
  now: Date
  /** El profesional elegido atiende el servicio elegido. */
  staffServesService: boolean
  /** Bloques de trabajo semanales del profesional. */
  workBlocks: WorkBlock[]
  /** Bloqueos del profesional (vacaciones, permisos…). */
  timeOff: { startsAt: Date; endsAt: Date }[]
  /** La recepción confirmó agendar fuera del horario o sobre un bloqueo. */
  outsideHoursOk: boolean
  /**
   * Sillones de la clínica y citas activas de toda la cuenta que tocan la
   * franja; `null` si la cuenta no es clínica. Al mover, la propia cita no
   * debe venir en `active`.
   */
  chairs: ChairContext | null
}

export type ValidatePanelBookingResult =
  | { ok: true; endsAt: Date }
  | { ok: false; code: PanelBookingRejection }

/**
 * Orden de las revisiones (la primera que falla es la que se informa):
 * datos inválidos → hora pasada → profesional no atiende el servicio →
 * fuera de horario o en un bloqueo (se salta con `outsideHoursOk`) →
 * sin sillones libres.
 */
export function validatePanelBooking(args: ValidatePanelBookingArgs): ValidatePanelBookingResult {
  const { startsAt, durationMinutes, now } = args

  if (
    !isValidDate(startsAt) ||
    !isValidDate(now) ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes > MAX_DURATION_MINUTES
  ) {
    return { ok: false, code: 'invalid_input' }
  }

  if (startsAt.getTime() < now.getTime()) return { ok: false, code: 'past' }
  if (!args.staffServesService) return { ok: false, code: 'staff_not_for_service' }

  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000)

  if (!args.outsideHoursOk) {
    const inBlock = fitsInWorkBlock(startsAt, endsAt, args.workBlocks)
    // Intervalos semiabiertos [inicio, fin): un bloqueo que empieza justo
    // cuando termina la cita (o viceversa) no la toca.
    const blocked = args.timeOff.some(
      (off) =>
        off.startsAt.getTime() < endsAt.getTime() && off.endsAt.getTime() > startsAt.getTime(),
    )
    if (!inBlock || blocked) return { ok: false, code: 'outside_hours' }
  }

  if (args.chairs && !chairsFreeAt({ startsAt, endsAt, ...args.chairs })) {
    return { ok: false, code: 'chairs_full' }
  }

  return { ok: true, endsAt }
}

/**
 * ¿Se puede mover esta cita desde el panel? Solo si sigue activa (pendiente o
 * confirmada) y todavía no ha pasado. Una que empieza exactamente ahora aún
 * cuenta como futura.
 */
export function canMove(status: AppointmentStatus, startsAt: Date, now: Date): boolean {
  if (status !== 'pending' && status !== 'confirmed') return false
  if (!isValidDate(startsAt) || !isValidDate(now)) return false
  return startsAt.getTime() >= now.getTime()
}

/**
 * Texto para la pantalla, en palabras simples. Las palabras de la cuenta
 * ("doctor", "turno"…) cambian de género de un negocio a otro, por eso nunca
 * llevan artículo delante: se usan solo con "de", "con" o solas, igual que en
 * el resto de textos de la agenda.
 */
export function panelBookingMessage(code: PanelBookingMessageCode, labels: AgendaLabels): string {
  switch (code) {
    case 'invalid_input':
      return 'La hora o la duración no son válidas. Revisa los datos e intenta de nuevo.'
    case 'past':
      return 'Esa hora ya pasó. Elige una más adelante.'
    case 'staff_not_for_service':
      return `Quien elegiste no atiende eso. Cambia de ${labels.profesional} o de ${labels.servicio}.`
    case 'outside_hours':
      return 'Esa hora queda fuera del horario de quien elegiste, o en un bloqueo suyo.'
    case 'not_editable':
      return 'Solo se puede mover lo que sigue pendiente o confirmado y aún no ha pasado.'
    case 'chairs_full':
      return 'No quedan sillones libres a esa hora.'
    case 'slot_taken':
      return `Quien elegiste ya tiene una cita a esa hora. Cambia la hora o cambia de ${labels.profesional}.`
    case 'stale':
      return 'Alguien cambió esto mientras lo editabas. Recarga e intenta de nuevo.'
  }
}

const MESSAGE_CODES: readonly PanelBookingMessageCode[] = [
  'invalid_input',
  'past',
  'staff_not_for_service',
  'outside_hours',
  'not_editable',
  'chairs_full',
  'slot_taken',
  'stale',
]

/** Los mismos textos con las palabras por defecto (cuentas sin palabras propias). */
export const PANEL_BOOKING_MESSAGES: Record<PanelBookingMessageCode, string> = Object.freeze(
  Object.fromEntries(
    MESSAGE_CODES.map((code) => [code, panelBookingMessage(code, DEFAULT_LABELS)]),
  ),
) as Record<PanelBookingMessageCode, string>
