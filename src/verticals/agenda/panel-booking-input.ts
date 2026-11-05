// ============================================================
// Lectura del cuerpo de las llamadas del panel para crear, mover y
// cancelar citas — puro, sin base de datos.
//
// Solo revisa la FORMA de lo que llega (tipos, largos, uuid, fecha con
// zona). Las reglas de agenda (horario, sillones, choques) viven en
// panel-booking.ts y en la base. Los mensajes van en palabras simples:
// la pantalla los muestra tal cual.
// ============================================================

import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'

export type InputResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** Como el CHECK de `clinic_patients.full_name` y el nombre de un contacto. */
const NAME_MAX = 120
const PHONE_MAX = 30
/** Motivo por defecto de una cancelación hecha por la clínica. */
export const CANCEL_REASON_DEFAULT = 'clinic'
/** Tope del motivo de cancelación que se guarda. */
export const CANCEL_REASON_MAX = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Una hora ISO debe traer su zona (Z o +hh:mm): sin ella dependería del servidor. */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** Espacios repetidos o en los bordes fuera. */
const tidy = (value: string): string => value.replace(/\s+/gu, ' ').trim()

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean | null {
  const value = body[key]
  if (value === undefined) return fallback
  return typeof value === 'boolean' ? value : null
}

function readStartsAt(value: unknown): Date | null {
  if (typeof value !== 'string' || !HAS_ZONE.test(value.trim())) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

const BAD_BODY = 'La solicitud no es válida. Recarga la página e intenta de nuevo.'
const BAD_START = 'Elige una fecha y una hora válidas.'

export interface CreateAppointmentInput {
  contact: { id: string } | { name: string; phone: string }
  /** Paciente ya registrado del contacto (solo clínicas). */
  patientId: string | null
  /** Paciente nuevo por nombre (solo clínicas). */
  newPatientName: string | null
  serviceId: string
  staffId: string
  startsAt: Date
  outsideHoursOk: boolean
  notify: boolean
}

export function parseCreateBody(body: unknown): InputResult<CreateAppointmentInput> {
  if (!isRecord(body)) return fail(BAD_BODY)

  const hasId = body.contact_id !== undefined && body.contact_id !== null
  const hasNew = body.new_contact !== undefined && body.new_contact !== null
  if (hasId === hasNew) {
    return fail('Elige un contacto que ya exista o escribe los datos de uno nuevo.')
  }

  let contact: CreateAppointmentInput['contact']
  if (hasId) {
    if (!isUuid(body.contact_id)) return fail('El contacto elegido no es válido.')
    contact = { id: body.contact_id }
  } else {
    const raw = body.new_contact
    if (!isRecord(raw)) return fail('Los datos del contacto nuevo no son válidos.')
    const name = typeof raw.name === 'string' ? tidy(raw.name) : ''
    if (!name) return fail('Escribe el nombre del contacto nuevo.')
    if ([...name].length > NAME_MAX) return fail('El nombre del contacto es demasiado largo.')
    const phone = typeof raw.phone === 'string' ? raw.phone.trim() : ''
    if (!phone || phone.length > PHONE_MAX || !parseInternationalPhone(phone)) {
      return fail(
        'El teléfono debe llevar el indicativo del país con +, por ejemplo +573001234567.',
      )
    }
    contact = { name, phone }
  }

  const hasPatientId = body.patient_id !== undefined && body.patient_id !== null
  const hasPatientName = body.new_patient_name !== undefined && body.new_patient_name !== null
  if (hasPatientId && hasPatientName) {
    return fail('Elige un paciente que ya exista o escribe el nombre de uno nuevo, no los dos.')
  }
  let patientId: string | null = null
  let newPatientName: string | null = null
  if (hasPatientId) {
    if (!isUuid(body.patient_id)) return fail('El paciente elegido no es válido.')
    patientId = body.patient_id
  }
  if (hasPatientName) {
    const name = typeof body.new_patient_name === 'string' ? tidy(body.new_patient_name) : ''
    if (!name) return fail('Escribe el nombre del paciente.')
    if ([...name].length > NAME_MAX) return fail('El nombre del paciente es demasiado largo.')
    newPatientName = name
  }

  if (!isUuid(body.service_id)) return fail('Elige la atención.')
  if (!isUuid(body.staff_id)) return fail('Elige quién atiende.')
  const startsAt = readStartsAt(body.starts_at)
  if (!startsAt) return fail(BAD_START)

  const outsideHoursOk = readBoolean(body, 'outside_hours_ok', false)
  const notify = readBoolean(body, 'notify', true)
  if (outsideHoursOk === null || notify === null) return fail(BAD_BODY)

  return {
    ok: true,
    value: {
      contact,
      patientId,
      newPatientName,
      serviceId: body.service_id,
      staffId: body.staff_id,
      startsAt,
      outsideHoursOk,
      notify,
    },
  }
}

export interface MoveAppointmentInput {
  startsAt: Date
  /** null = el mismo profesional de ahora. */
  staffId: string | null
  notify: boolean
  outsideHoursOk: boolean
}

export function parseMoveBody(body: unknown): InputResult<MoveAppointmentInput> {
  if (!isRecord(body)) return fail(BAD_BODY)

  const startsAt = readStartsAt(body.starts_at)
  if (!startsAt) return fail(BAD_START)

  let staffId: string | null = null
  if (body.staff_id !== undefined && body.staff_id !== null) {
    if (!isUuid(body.staff_id)) return fail('Elige quién atiende.')
    staffId = body.staff_id
  }

  const notify = readBoolean(body, 'notify', true)
  const outsideHoursOk = readBoolean(body, 'outside_hours_ok', false)
  if (notify === null || outsideHoursOk === null) return fail(BAD_BODY)

  return { ok: true, value: { startsAt, staffId, notify, outsideHoursOk } }
}

export interface CancelAppointmentInput {
  reason: string
  notify: boolean
  /** La persona ya confirmó que cancela una cita que pasó. */
  confirmPast: boolean
}

export function parseCancelBody(body: unknown): InputResult<CancelAppointmentInput> {
  if (!isRecord(body)) return fail(BAD_BODY)

  let reason = CANCEL_REASON_DEFAULT
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string') return fail('El motivo debe ser un texto.')
    const text = tidy(body.reason)
    if ([...text].length > CANCEL_REASON_MAX) {
      return fail(`El motivo puede tener hasta ${CANCEL_REASON_MAX} caracteres.`)
    }
    if (text) reason = text
  }

  const notify = readBoolean(body, 'notify', true)
  const confirmPast = readBoolean(body, 'confirm_past', false)
  if (notify === null || confirmPast === null) return fail(BAD_BODY)

  return { ok: true, value: { reason, notify, confirmPast } }
}
