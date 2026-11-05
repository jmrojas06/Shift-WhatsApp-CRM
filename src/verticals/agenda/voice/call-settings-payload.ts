// ============================================================
// Lo que /api/verticals/agenda/call-settings le entrega a la pantalla
// (GET y PATCH responden lo mismo).
//
// Las claves van en snake_case, igual que las del PATCH, para que la
// pantalla pueda comparar lo que tiene con lo que mandó. NO viaja `voice`
// ni `provider` (la pantalla no los usa) y nunca viaja ningún valor de las
// variables de entorno de Telnyx: solo si están puestas o no.
// ============================================================

import type { OfficeHours } from '@/lib/voice/hours'

import type { CallSettings } from './settings'

export interface CallSettingsPayload {
  outbound_enabled: boolean
  inbound_enabled: boolean
  /** Lo fija Shift: la pantalla lo muestra, no lo cambia. */
  inbound_number: string | null
  /** Lo fija Shift: la pantalla lo muestra, no lo cambia. */
  caller_id: string | null
  advisor_phones: string[]
  office_hours: OfficeHours
  info_text: string
  call_after_minutes: number
  min_lead_minutes: number
  max_attempts: number
  retry_minutes: number
  window_start: string
  window_end: string
  call_saturday: boolean
  /** Lo fija Shift: la pantalla lo muestra, no lo cambia. */
  monthly_limit: number
}

export interface CallSettingsResponse {
  settings: CallSettingsPayload
  /** Llamadas salientes del robot en el mes de calendario de Bogotá. */
  usage: { month: string; used: number }
  /** ¿El servidor tiene las variables de Telnyx? Nunca sus valores. */
  telnyx: { configured: boolean }
}

export function callSettingsToPayload(settings: CallSettings): CallSettingsPayload {
  return {
    outbound_enabled: settings.outboundEnabled,
    inbound_enabled: settings.inboundEnabled,
    inbound_number: settings.inboundNumber,
    caller_id: settings.callerId,
    advisor_phones: settings.advisorPhones,
    office_hours: settings.officeHours,
    info_text: settings.infoText,
    call_after_minutes: settings.callAfterMinutes,
    min_lead_minutes: settings.minLeadMinutes,
    max_attempts: settings.maxAttempts,
    retry_minutes: settings.retryMinutes,
    window_start: settings.windowStart,
    window_end: settings.windowEnd,
    call_saturday: settings.callSaturday,
    monthly_limit: settings.monthlyLimit,
  }
}
