// ============================================================
// Cliente HTTP de la configuración del vertical (navegador).
//
// Las escrituras pasan SIEMPRE por las rutas /api/verticals/
// agenda/*, que validan rol y datos en el servidor: aquí solo se
// da forma al request y se traduce la respuesta a un resultado
// plano `{ ok }` para que las secciones no repitan try/catch.
// ============================================================

import type { AgendaLabelKey } from '@/verticals/agenda/labels'
import type { PresetKey } from '@/verticals/agenda/presets'
import type { AgendaQuestion, QuestionKind } from '@/verticals/agenda/questions'
import type { AgendaInstallReport } from '@/verticals/agenda/seed'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'
import type { CallSettingsResponse } from '@/verticals/agenda/voice/call-settings-payload'

import { CALLS_TEXTS } from './calls-texts'
import { GOOGLE_TEXTS, type CalendarOption } from './google-calendar-texts'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

async function request<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  /** Mensaje si el servidor no explica el error (por defecto, "no se pudo guardar"). */
  fallbackError: string = T.config.saveFailed,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    const payload = (await res.json().catch(() => null)) as
      | (T & { error?: string })
      | null
    if (!res.ok) {
      return { ok: false, error: payload?.error ?? fallbackError }
    }
    return { ok: true, data: (payload ?? {}) as T }
  } catch {
    return { ok: false, error: fallbackError }
  }
}

// ------------------------------------------------------------
// Formas de las respuestas del servidor
// ------------------------------------------------------------

export interface ServicePayload {
  id: string
  name: string
  description: string | null
  durationMinutes: number
  price: number
  isActive: boolean
  position: number
}

export interface StaffPayload {
  id: string
  name: string
  bio: string | null
  isActive: boolean
  position: number
  googleCalendarId: string | null
}

export interface TimeOffPayload {
  id: string
  staffId: string
  startsAt: string
  endsAt: string
  reason: string | null
}

export interface SettingsPayload {
  address: string | null
  reminders2hEnabled: boolean
  botTexts: Record<string, string>
}

export interface ConfigPatchBody {
  address?: string | null
  currency?: string
  reminders_2h_enabled?: boolean
  bot_texts?: Record<string, string>
  /** Las seis palabras; una vacía vuelve a su valor por defecto. */
  labels?: Record<AgendaLabelKey, string>
  /** Piezas por columna (snake_case): { choose_staff: false }. */
  toggles?: Record<string, boolean>
  // El tipo de negocio NO viaja aquí: el servidor rechaza `preset_key`.
  // Se cambia solo con installPreset (POST /setup).
}

/** Definición completa de una pregunta (el PATCH reemplaza todo). */
export interface QuestionBody {
  label: string
  kind: QuestionKind
  required: boolean
  options: string[]
}

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------

export const agendaConfigApi = {
  patchConfig: (body: ConfigPatchBody) =>
    request<{ settings: SettingsPayload | null; currency: string | null }>(
      '/api/verticals/agenda/config',
      'PATCH',
      body,
    ),

  renameAccount: (name: string) =>
    request<{ account: { id: string; name: string } }>(
      '/api/account',
      'PATCH',
      { name },
    ),

  createService: (body: {
    name: string
    description: string | null
    duration_minutes: number
    price: number
  }) =>
    request<{ service: ServicePayload }>(
      '/api/verticals/agenda/services',
      'POST',
      body,
    ),

  updateService: (
    id: string,
    body: {
      name?: string
      description?: string | null
      duration_minutes?: number
      price?: number
      is_active?: boolean
    },
  ) =>
    request<{ service: ServicePayload }>(
      `/api/verticals/agenda/services/${id}`,
      'PATCH',
      body,
    ),

  reorderServices: (ids: string[]) =>
    request<{ ok: true }>('/api/verticals/agenda/services', 'PUT', { ids }),

  createStaff: (body: { name: string; bio: string | null }) =>
    request<{ staff: StaffPayload }>(
      '/api/verticals/agenda/staff',
      'POST',
      body,
    ),

  updateStaff: (
    id: string,
    body: {
      name?: string
      bio?: string | null
      is_active?: boolean
      /** Calendario de Google de esta persona; null = el general. */
      google_calendar_id?: string | null
    },
  ) =>
    request<{ staff: StaffPayload }>(
      `/api/verticals/agenda/staff/${id}`,
      'PATCH',
      body,
    ),

  reorderStaff: (ids: string[]) =>
    request<{ ok: true }>('/api/verticals/agenda/staff', 'PUT', { ids }),

  setStaffServices: (id: string, serviceIds: string[]) =>
    request<{ ok: true; count: number }>(
      `/api/verticals/agenda/staff/${id}/services`,
      'PUT',
      { service_ids: serviceIds },
    ),

  saveHours: (
    id: string,
    hours: { weekday: number; start_time: string; end_time: string }[],
  ) =>
    request<{ ok: true; count: number }>(
      `/api/verticals/agenda/staff/${id}/hours`,
      'PUT',
      { hours },
    ),

  createTimeOff: (body: {
    staff_id: string
    starts_at: string
    ends_at: string
    reason: string | null
  }) =>
    request<{ timeOff: TimeOffPayload }>(
      '/api/verticals/agenda/time-off',
      'POST',
      body,
    ),

  deleteTimeOff: (id: string) =>
    request<{ ok: true }>(`/api/verticals/agenda/time-off/${id}`, 'DELETE'),

  createQuestion: (body: QuestionBody) =>
    request<{ question: AgendaQuestion }>(
      '/api/verticals/agenda/questions',
      'POST',
      body,
    ),

  updateQuestion: (id: string, body: QuestionBody) =>
    request<{ question: AgendaQuestion }>(
      `/api/verticals/agenda/questions/${id}`,
      'PATCH',
      body,
    ),

  /** Desactiva la pregunta: las respuestas ya guardadas se conservan. */
  deleteQuestion: (id: string) =>
    request<{ ok: true }>(`/api/verticals/agenda/questions/${id}`, 'DELETE'),

  /**
   * Aplica un punto de partida (POST /setup). Sin clave reinstala el de la
   * cuenta (o barbería si no tiene uno). Una respuesta 200 sin reporte no
   * cuenta como instalada.
   */
  installPreset: async (
    presetKey?: PresetKey,
  ): Promise<ApiResult<{ report: AgendaInstallReport }>> => {
    const res = await request<{ report?: AgendaInstallReport }>(
      '/api/verticals/agenda/setup',
      'POST',
      presetKey ? { preset_key: presetKey } : undefined,
    )
    if (!res.ok) return res
    const report = res.data.report
    if (!report || typeof report !== 'object') {
      return { ok: false, error: T.installFailed }
    }
    return { ok: true, data: { report } }
  },
}

// ------------------------------------------------------------
// Google Calendar (/api/integrations/google-calendar/*)
// ------------------------------------------------------------

/** Estado de la conexión; el servidor nunca manda el permiso guardado. */
export interface GoogleSettingsPayload {
  /** El servidor tiene las variables de Google. */
  configured: boolean
  /** Hay una conexión que no fue revocada. */
  connected: boolean
  google_email: string | null
  status: 'active' | 'error' | 'revoked' | null
  last_error: string | null
  last_sync_at: string | null
  default_calendar_id: string | null
}

const GOOGLE_API = '/api/integrations/google-calendar'

export const googleCalendarApi = {
  /** Enlace normal (no fetch): el navegador viaja a Google y vuelve al callback. */
  connectUrl: `${GOOGLE_API}/connect`,

  getSettings: () =>
    request<GoogleSettingsPayload>(
      `${GOOGLE_API}/settings`,
      'GET',
      undefined,
      GOOGLE_TEXTS.loadFailed,
    ),

  saveDefaultCalendar: (calendarId: string) =>
    request<GoogleSettingsPayload>(
      `${GOOGLE_API}/settings`,
      'PATCH',
      { default_calendar_id: calendarId },
      GOOGLE_TEXTS.calendarSaveFailed,
    ),

  getCalendars: () =>
    request<{ calendars: CalendarOption[] }>(
      `${GOOGLE_API}/calendars`,
      'GET',
      undefined,
      GOOGLE_TEXTS.calendarsFailed,
    ),

  disconnect: () =>
    request<{ ok: true }>(
      `${GOOGLE_API}/disconnect`,
      'POST',
      undefined,
      GOOGLE_TEXTS.disconnectFailed,
    ),
}

// ------------------------------------------------------------
// Llamadas (/api/verticals/agenda/call-settings y calls/test)
// ------------------------------------------------------------

const CALL_SETTINGS_API = '/api/verticals/agenda/call-settings'

export const callSettingsApi = {
  get: () =>
    request<CallSettingsResponse>(CALL_SETTINGS_API, 'GET', undefined, CALLS_TEXTS.loadFailed),

  /** Solo lo que cambió, con las claves del PATCH (nunca los campos de Shift). */
  save: (patch: Record<string, unknown>) =>
    request<CallSettingsResponse>(CALL_SETTINGS_API, 'PATCH', patch, CALLS_TEXTS.saveFailed),

  /** Llama a `to` (E.164) con un guion de ejemplo marcado como prueba. */
  test: (to: string) =>
    request<Record<string, unknown>>(
      '/api/verticals/agenda/calls/test',
      'POST',
      { to },
      CALLS_TEXTS.testFailed,
    ),
}
