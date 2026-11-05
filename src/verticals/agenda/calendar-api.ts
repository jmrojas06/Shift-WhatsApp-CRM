// ============================================================
// Cliente (navegador) de las rutas de citas del panel:
//
//   GET   /api/verticals/agenda/slots                 horas libres
//   POST  /api/verticals/agenda/appointments           crear
//   PATCH /api/verticals/agenda/appointments/[id]      mover, cancelar y estado
//
// Cada llamada devuelve `{ ok, ... }` en vez de lanzar: la pantalla
// decide qué decirle a la recepción según `code` (por ejemplo
// `outside_hours` pregunta "¿Agendar igual?"). El `fetch` se inyecta
// para poder probar y para la vista previa, que no toca la red.
// ============================================================

import type { AppointmentStatus } from './appointments'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; error: string }

export interface SlotOption {
  /** Inicio de la hora, ISO en UTC. */
  startsAt: string
  /** Quiénes están libres a esa hora. */
  staffIds: string[]
}

/** Lo que dice una ruta de escritura sobre el aviso por WhatsApp. */
export interface WriteOutcome {
  notified: boolean
  /** Por qué no se pudo avisar, ya en palabras simples. */
  notifyError: string | null
}

export type ContactChoice = { id: string } | { name: string; phone: string }
export type PatientChoice = { id: string } | { name: string } | null

export interface CreateInput {
  contact: ContactChoice
  /** Solo clínicas; null en el resto. */
  patient: PatientChoice
  serviceId: string
  staffId: string
  startsAtIso: string
  outsideHoursOk: boolean
  notify: boolean
}

export interface MoveInput {
  startsAtIso: string
  staffId: string | null
  notify: boolean
  outsideHoursOk: boolean
}

export interface CancelInput {
  reason: string
  notify: boolean
  confirmPast: boolean
}

export interface CalendarApi {
  listSlots(args: {
    serviceId: string
    dateKey: string
    staffId?: string | null
    excludeId?: string | null
  }): Promise<ApiResult<{ slots: SlotOption[] }>>
  create(input: CreateInput): Promise<ApiResult<WriteOutcome & { id: string }>>
  move(id: string, input: MoveInput): Promise<ApiResult<WriteOutcome>>
  cancel(id: string, input: CancelInput): Promise<ApiResult<WriteOutcome>>
  setStatus(id: string, status: AppointmentStatus, confirmPast: boolean): Promise<ApiResult<null>>
}

const BASE = '/api/verticals/agenda'
const GENERIC_ERROR = 'No se pudo completar la acción. Revisa tu conexión e inténtalo de nuevo.'

export interface RawBody {
  error?: unknown
  code?: unknown
  [key: string]: unknown
}

export async function call(
  fetchImpl: typeof fetch,
  url: string,
  init?: { method: string; body: unknown },
): Promise<ApiResult<RawBody>> {
  let res: Response
  try {
    res = await fetchImpl(
      url,
      init
        ? {
            method: init.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(init.body),
          }
        : undefined,
    )
  } catch {
    return { ok: false, status: 0, code: 'network', error: GENERIC_ERROR }
  }

  const body = (await res.json().catch(() => null)) as RawBody | null
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: typeof body?.code === 'string' ? body.code : null,
      error: typeof body?.error === 'string' && body.error ? body.error : GENERIC_ERROR,
    }
  }
  return { ok: true, data: body ?? {} }
}

function outcomeOf(body: RawBody): WriteOutcome {
  return {
    notified: body.notified === true,
    notifyError: typeof body.notify_error === 'string' ? body.notify_error : null,
  }
}

export function createCalendarApi(fetchImpl: typeof fetch = fetch): CalendarApi {
  return {
    async listSlots({ serviceId, dateKey, staffId, excludeId }) {
      const params = new URLSearchParams({ service_id: serviceId, date: dateKey })
      if (staffId) params.set('staff_id', staffId)
      if (excludeId) params.set('exclude', excludeId)
      const res = await call(fetchImpl, `${BASE}/slots?${params.toString()}`)
      if (!res.ok) return res
      const raw = Array.isArray(res.data.slots) ? res.data.slots : []
      const slots: SlotOption[] = (raw as { starts_at?: unknown; staff_ids?: unknown }[]).flatMap((s) =>
        typeof s.starts_at === 'string'
          ? [
              {
                startsAt: s.starts_at,
                staffIds: Array.isArray(s.staff_ids) ? (s.staff_ids as string[]) : [],
              },
            ]
          : [],
      )
      return { ok: true, data: { slots } }
    },

    async create(input) {
      const body: Record<string, unknown> = {
        service_id: input.serviceId,
        staff_id: input.staffId,
        starts_at: input.startsAtIso,
        outside_hours_ok: input.outsideHoursOk,
        notify: input.notify,
      }
      if ('id' in input.contact) body.contact_id = input.contact.id
      else body.new_contact = { name: input.contact.name, phone: input.contact.phone }
      if (input.patient) {
        if ('id' in input.patient) body.patient_id = input.patient.id
        else body.new_patient_name = input.patient.name
      }
      const res = await call(fetchImpl, `${BASE}/appointments`, { method: 'POST', body })
      if (!res.ok) return res
      return { ok: true, data: { id: String(res.data.id ?? ''), ...outcomeOf(res.data) } }
    },

    async move(id, input) {
      const body: Record<string, unknown> = {
        action: 'move',
        starts_at: input.startsAtIso,
        notify: input.notify,
        outside_hours_ok: input.outsideHoursOk,
      }
      if (input.staffId) body.staff_id = input.staffId
      const res = await call(fetchImpl, `${BASE}/appointments/${id}`, { method: 'PATCH', body })
      if (!res.ok) return res
      return { ok: true, data: outcomeOf(res.data) }
    },

    async cancel(id, input) {
      const body: Record<string, unknown> = {
        action: 'cancel',
        notify: input.notify,
        confirm_past: input.confirmPast,
      }
      const reason = input.reason.trim()
      if (reason) body.reason = reason
      const res = await call(fetchImpl, `${BASE}/appointments/${id}`, { method: 'PATCH', body })
      if (!res.ok) return res
      return { ok: true, data: outcomeOf(res.data) }
    },

    async setStatus(id, status, confirmPast) {
      const res = await call(fetchImpl, `${BASE}/appointments/${id}`, {
        method: 'PATCH',
        body: { status, confirm_past: confirmPast },
      })
      if (!res.ok) return res
      return { ok: true, data: null }
    },
  }
}
