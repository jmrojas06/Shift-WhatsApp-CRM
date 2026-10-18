// ============================================================
// Cliente HTTP de la configuración del vertical (navegador).
//
// Las escrituras pasan SIEMPRE por las rutas /api/verticals/
// barberia/*, que validan rol y datos en el servidor: aquí solo se
// da forma al request y se traduce la respuesta a un resultado
// plano `{ ok }` para que las secciones no repitan try/catch.
// ============================================================

import { BARBERIA_TEXTS as T } from '@/verticals/barberia/texts'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

async function request<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
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
      return { ok: false, error: payload?.error ?? T.config.saveFailed }
    }
    return { ok: true, data: (payload ?? {}) as T }
  } catch {
    return { ok: false, error: T.config.saveFailed }
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
}

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------

export const barberiaConfigApi = {
  patchConfig: (body: ConfigPatchBody) =>
    request<{ settings: SettingsPayload | null; currency: string | null }>(
      '/api/verticals/barberia/config',
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
      '/api/verticals/barberia/services',
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
      `/api/verticals/barberia/services/${id}`,
      'PATCH',
      body,
    ),

  reorderServices: (ids: string[]) =>
    request<{ ok: true }>('/api/verticals/barberia/services', 'PUT', { ids }),

  createStaff: (body: { name: string; bio: string | null }) =>
    request<{ staff: StaffPayload }>(
      '/api/verticals/barberia/staff',
      'POST',
      body,
    ),

  updateStaff: (
    id: string,
    body: { name?: string; bio?: string | null; is_active?: boolean },
  ) =>
    request<{ staff: StaffPayload }>(
      `/api/verticals/barberia/staff/${id}`,
      'PATCH',
      body,
    ),

  reorderStaff: (ids: string[]) =>
    request<{ ok: true }>('/api/verticals/barberia/staff', 'PUT', { ids }),

  setStaffServices: (id: string, serviceIds: string[]) =>
    request<{ ok: true; count: number }>(
      `/api/verticals/barberia/staff/${id}/services`,
      'PUT',
      { service_ids: serviceIds },
    ),

  saveHours: (
    id: string,
    hours: { weekday: number; start_time: string; end_time: string }[],
  ) =>
    request<{ ok: true; count: number }>(
      `/api/verticals/barberia/staff/${id}/hours`,
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
      '/api/verticals/barberia/time-off',
      'POST',
      body,
    ),

  deleteTimeOff: (id: string) =>
    request<{ ok: true }>(`/api/verticals/barberia/time-off/${id}`, 'DELETE'),
}
