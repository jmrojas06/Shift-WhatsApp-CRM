// ============================================================
// Cliente (navegador) de las rutas de "Para llamar":
//
//   GET  /api/verticals/agenda/calls                la lista
//   POST /api/verticals/agenda/calls                anotar una llamada a mano
//   POST /api/verticals/agenda/calls/robot          "Llamar con el robot ahora"
//
// Como en calendar-api.ts, cada llamada devuelve `{ ok, ... }` en vez de lanzar
// y el `fetch` se inyecta: la vista previa de desarrollo no toca la red.
// ============================================================

import { call, type ApiResult } from './calendar-api'
import type { CallListRow } from './call-list'
import { callListRowFromPayload } from './call-list-payload'
import type { ManualOutcome } from './manual-calls'

export interface CallListData {
  rows: CallListRow[]
  /** Las llamadas salientes están prendidas: se ofrece "Llamar con el robot ahora". */
  outboundEnabled: boolean
}

export interface RecordCallInput {
  appointmentId: string
  outcome: ManualOutcome
  /** Solo importa si la cita se cancela. Por defecto, sí se avisa. */
  notify?: boolean
}

/** Lo que dice la ruta tras anotar una llamada. */
export interface RecordedCall {
  /** La llamada quedó en el historial (si no, la nota dice por qué). */
  recorded: boolean
  note: string | null
  /** Solo al cancelar; null si no aplica. */
  notified: boolean | null
  notifyError: string | null
}

export interface CallListApi {
  list(): Promise<ApiResult<CallListData>>
  record(input: RecordCallInput): Promise<ApiResult<RecordedCall>>
  robotCall(appointmentId: string): Promise<ApiResult<{ attempt: number }>>
}

const URL = '/api/verticals/agenda/calls'

export function createCallListApi(fetchImpl: typeof fetch = fetch): CallListApi {
  return {
    async list() {
      const res = await call(fetchImpl, URL)
      if (!res.ok) return res
      const raw = Array.isArray(res.data.rows) ? res.data.rows : []
      return {
        ok: true,
        data: {
          rows: raw.flatMap((item) => callListRowFromPayload(item) ?? []),
          outboundEnabled: res.data.outbound_enabled === true,
        },
      }
    },

    async record(input) {
      const body: Record<string, unknown> = { appointment_id: input.appointmentId, outcome: input.outcome }
      if (input.notify !== undefined) body.notify = input.notify
      const res = await call(fetchImpl, URL, { method: 'POST', body })
      if (!res.ok) return res
      return {
        ok: true,
        data: {
          recorded: res.data.recorded === true,
          note: typeof res.data.note === 'string' ? res.data.note : null,
          notified: typeof res.data.notified === 'boolean' ? res.data.notified : null,
          notifyError: typeof res.data.notify_error === 'string' ? res.data.notify_error : null,
        },
      }
    },

    async robotCall(appointmentId) {
      const res = await call(fetchImpl, `${URL}/robot`, { method: 'POST', body: { appointment_id: appointmentId } })
      if (!res.ok) return res
      return { ok: true, data: { attempt: typeof res.data.attempt === 'number' ? res.data.attempt : 0 } }
    },
  }
}
