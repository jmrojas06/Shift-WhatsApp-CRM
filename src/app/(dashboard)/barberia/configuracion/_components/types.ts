// ============================================================
// Tipos de las filas que la página de Configuración lee con el
// cliente RLS del usuario y reparte entre las secciones.
// ============================================================

export interface ServiceRow {
  id: string
  name: string
  description: string | null
  duration_minutes: number
  /** numeric(12,2): PostgREST puede serializarlo como número o texto. */
  price: number | string
  is_active: boolean
  position: number
}

export interface StaffRow {
  id: string
  name: string
  bio: string | null
  is_active: boolean
  position: number
}

export interface WorkingHoursRow {
  id: string
  staff_id: string
  /** 0 = domingo … 6 = sábado. */
  weekday: number
  /** 'HH:MM:SS' tal como lo devuelve Postgres. */
  start_time: string
  end_time: string
}

export interface TimeOffRow {
  id: string
  staff_id: string
  starts_at: string
  ends_at: string
  reason: string | null
}

export interface SettingsRow {
  address: string | null
  reminders_2h_enabled: boolean
  bot_texts: Record<string, string>
}

/** service_id[] que atiende cada barbero. */
export type StaffServicesMap = Record<string, string[]>

export const EMPTY_SETTINGS: SettingsRow = {
  address: null,
  reminders_2h_enabled: false,
  bot_texts: {},
}
