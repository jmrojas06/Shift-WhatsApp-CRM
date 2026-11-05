// ============================================================
// Configuración de las llamadas por cuenta (`booking_call_settings`, 056).
//
//   - `loadCallSettings` lee la fila de la cuenta; sin fila usa los valores
//     por defecto, que dejan todo apagado.
//   - `callSettingsFromRow` lee una fila sin lanzar: lo dañado vuelve al valor
//     por defecto y NUNCA prende nada por error.
//   - `validateCallSettingsPatch` valida lo que manda el panel (claves en
//     snake_case, como `reminders_2h_enabled`) y devuelve el parche en
//     camelCase; `callSettingsToRow` lo pasa a columnas para guardarlo.
//   - `mergeAndValidateWindow` revisa la ventana de llamadas contra lo ya
//     guardado cuando el parche trae solo la hora de inicio o solo la de fin.
//
// Cuatro columnas NO son del panel: `provider`, `monthly_limit`,
// `inbound_number` y `caller_id` las fija Shift con service role, y un trigger
// de la migración 056 rechaza (42501) que un admin las cambie. Por eso el
// parche las rechaza con un mensaje claro en vez de dejar que falle la base.
//
// Los límites van alineados con los CHECK de la migración 056.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizeClock, parseOfficeHours, type OfficeHours } from '@/lib/voice/hours'
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils'
import type { Valid } from '@/verticals/agenda/config'

// ------------------------------------------------------------
// Modelo
// ------------------------------------------------------------

export interface CallSettings {
  provider: 'telnyx'
  outboundEnabled: boolean
  inboundEnabled: boolean
  /** E.164. Único en toda la plataforma: la cuenta de una llamada se encuentra por él. */
  inboundNumber: string | null
  /** Número que verá el paciente; si es null se usa `inboundNumber`. */
  callerId: string | null
  /** De 0 a 3 teléfonos E.164 a los que pasa la llamada en horario de atención. */
  advisorPhones: string[]
  officeHours: OfficeHours
  /** Texto de horario y dirección que lee la opción 3. */
  infoText: string
  callAfterMinutes: number
  minLeadMinutes: number
  maxAttempts: number
  retryMinutes: number
  /** 'HH:MM', hora de Bogotá. */
  windowStart: string
  windowEnd: string
  callSaturday: boolean
  monthlyLimit: number
  /** null = la voz de la plataforma (`VOICE_DEFAULT_VOICE`). */
  voice: string | null
  updatedAt: string | null
}

/**
 * Lo que el panel puede cambiar. Sin `provider`, `monthlyLimit`,
 * `inboundNumber` ni `callerId`: esas las controla Shift (ver arriba).
 */
export type CallSettingsPatch = Partial<
  Omit<CallSettings, 'provider' | 'updatedAt' | 'inboundNumber' | 'callerId' | 'monthlyLimit'>
>

/** Voz si ni la cuenta ni la plataforma eligieron una: español de México. */
export const DEFAULT_VOICE = 'Polly.Mia-Neural'

export const MAX_ADVISOR_PHONES = 3
export const MAX_INFO_TEXT = 500
export const MAX_OFFICE_BLOCKS_PER_DAY = 4
const VOICE_MAX = 80

/** Sin fila, todo apagado y con los valores del diseño (§6.4). */
export const DEFAULT_CALL_SETTINGS: Readonly<CallSettings> = Object.freeze({
  provider: 'telnyx',
  outboundEnabled: false,
  inboundEnabled: false,
  inboundNumber: null,
  callerId: null,
  advisorPhones: [],
  officeHours: {},
  infoText: '',
  callAfterMinutes: 180,
  minLeadMinutes: 120,
  maxAttempts: 2,
  retryMinutes: 90,
  windowStart: '08:00',
  windowEnd: '19:00',
  callSaturday: true,
  monthlyLimit: 300,
  voice: null,
  updatedAt: null,
})

/** Rango (inclusive) de cada número entero que se puede cambiar. */
const INTEGER_FIELDS = {
  call_after_minutes: {
    key: 'callAfterMinutes',
    label: 'Los minutos de espera tras el recordatorio',
    min: 0,
    max: 2880,
  },
  min_lead_minutes: {
    key: 'minLeadMinutes',
    label: 'Los minutos mínimos antes de la cita',
    min: 0,
    max: 4320,
  },
  max_attempts: { key: 'maxAttempts', label: 'Los intentos por cita', min: 1, max: 3 },
  retry_minutes: { key: 'retryMinutes', label: 'Los minutos entre intentos', min: 1, max: 2880 },
} as const

/** camelCase → columna, de lo que el panel puede guardar. */
const COLUMN_OF: Record<keyof CallSettingsPatch, string> = {
  outboundEnabled: 'outbound_enabled',
  inboundEnabled: 'inbound_enabled',
  advisorPhones: 'advisor_phones',
  officeHours: 'office_hours',
  infoText: 'info_text',
  callAfterMinutes: 'call_after_minutes',
  minLeadMinutes: 'min_lead_minutes',
  maxAttempts: 'max_attempts',
  retryMinutes: 'retry_minutes',
  windowStart: 'window_start',
  windowEnd: 'window_end',
  callSaturday: 'call_saturday',
  voice: 'voice',
}

/**
 * Columnas que controla Shift, con el nombre que se le muestra al admin. Se
 * leen, pero no se guardan desde el panel (las fija Shift con service role).
 */
const SHIFT_CONTROLLED: Readonly<Record<string, string>> = {
  provider: 'El proveedor de llamadas',
  monthly_limit: 'El tope de llamadas del mes',
  inbound_number: 'El número de llamadas entrantes',
  caller_id: 'El número que marca',
}

/** Columnas que lee `loadCallSettings` (también las necesita quien busca por `inbound_number`). */
export const CALL_SETTINGS_COLUMNS = [
  ...Object.keys(SHIFT_CONTROLLED),
  ...Object.values(COLUMN_OF),
  'updated_at',
].join(', ')

// ------------------------------------------------------------
// Ayudas
// ------------------------------------------------------------

/** '+57 300 123 4567' → '+573001234567'; null si no es un E.164 con el indicativo. */
export function toE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = parseInternationalPhone(raw)
  return digits ? `+${digits}` : null
}

/** ¿El inicio va antes que el fin? Las dos deben ser horas válidas. */
export function isValidCallWindow(start: string, end: string): boolean {
  const from = normalizeClock(start)
  const to = normalizeClock(end)
  return from !== null && to !== null && from < to
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

const has = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key)

function intOr(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

function uniquePhones(values: unknown[]): string[] {
  return [...new Set(values.map(toE164).filter((phone): phone is string => phone !== null))]
}

// ------------------------------------------------------------
// Lectura
// ------------------------------------------------------------

/** Lee una fila sin lanzar. Lo dañado vuelve al valor por defecto. */
export function callSettingsFromRow(row: Record<string, unknown> | null | undefined): CallSettings {
  const defaults = DEFAULT_CALL_SETTINGS
  if (!row) return { ...defaults, advisorPhones: [], officeHours: {} }

  const windowStart = normalizeClock(row.window_start)
  const windowEnd = normalizeClock(row.window_end)
  const windowOk = windowStart !== null && windowEnd !== null && windowStart < windowEnd

  const voice = typeof row.voice === 'string' ? row.voice.trim() : ''

  return {
    provider: 'telnyx',
    outboundEnabled: row.outbound_enabled === true,
    inboundEnabled: row.inbound_enabled === true,
    inboundNumber: toE164(row.inbound_number),
    callerId: toE164(row.caller_id),
    advisorPhones: Array.isArray(row.advisor_phones)
      ? uniquePhones(row.advisor_phones).slice(0, MAX_ADVISOR_PHONES)
      : [],
    officeHours: parseOfficeHours(row.office_hours),
    infoText: typeof row.info_text === 'string' ? row.info_text : '',
    callAfterMinutes: intOr(row.call_after_minutes, 0, 2880, defaults.callAfterMinutes),
    minLeadMinutes: intOr(row.min_lead_minutes, 0, 4320, defaults.minLeadMinutes),
    maxAttempts: intOr(row.max_attempts, 1, 3, defaults.maxAttempts),
    retryMinutes: intOr(row.retry_minutes, 1, 2880, defaults.retryMinutes),
    windowStart: windowOk ? windowStart : defaults.windowStart,
    windowEnd: windowOk ? windowEnd : defaults.windowEnd,
    callSaturday: typeof row.call_saturday === 'boolean' ? row.call_saturday : defaults.callSaturday,
    monthlyLimit: intOr(row.monthly_limit, 0, 100000, defaults.monthlyLimit),
    voice: voice !== '' ? voice : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  }
}

/**
 * Configuración de llamadas de la cuenta; sin fila, los valores por defecto
 * (todo apagado). Si la lectura falla LANZA: un error de la base no es "sin
 * configurar", y quien llama decide cómo avisarlo.
 */
export async function loadCallSettings(db: SupabaseClient, accountId: string): Promise<CallSettings> {
  const { data, error } = await db
    .from('booking_call_settings')
    .select(CALL_SETTINGS_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la configuración de llamadas: ${error.message}`)
  return callSettingsFromRow((data as Record<string, unknown> | null) ?? null)
}

/** Voz de una cuenta: la suya, si no la de la plataforma, si no Polly Mia (español de México). */
export function resolveVoice(
  settings: Pick<CallSettings, 'voice'>,
  env: Record<string, string | undefined> = process.env,
): string {
  return settings.voice?.trim() || env.VOICE_DEFAULT_VOICE?.trim() || DEFAULT_VOICE
}

// ------------------------------------------------------------
// Validación del parche
// ------------------------------------------------------------

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

const PHONE_HELP = 'debe incluir el indicativo del país con el +, por ejemplo +573001234567.'

/** Claves de solo lectura: el panel puede devolverlas junto con lo demás y se ignoran. */
const READ_ONLY_KEYS = new Set(['updated_at', 'account_id'])

const KNOWN_KEYS = new Set<string>([
  ...Object.values(COLUMN_OF),
  ...READ_ONLY_KEYS,
])

function validateBoolean(value: unknown, label: string): Valid<boolean> {
  if (typeof value !== 'boolean') return { ok: false, message: `${label} debe ser sí o no.` }
  return { ok: true, value }
}

function validateAdvisorPhones(value: unknown): Valid<string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'Los teléfonos de los asesores deben ser una lista.' }
  }
  const phones: string[] = []
  for (const item of value) {
    const phone = toE164(item)
    if (!phone) return { ok: false, message: `Cada teléfono de asesor ${PHONE_HELP}` }
    if (!phones.includes(phone)) phones.push(phone)
  }
  if (phones.length > MAX_ADVISOR_PHONES) {
    return { ok: false, message: `Puedes poner hasta ${MAX_ADVISOR_PHONES} teléfonos de asesores.` }
  }
  return { ok: true, value: phones }
}

function validateOfficeHours(value: unknown): Valid<OfficeHours> {
  const record = asRecord(value)
  if (!record) return { ok: false, message: 'El horario de atención no es válido.' }

  const out: OfficeHours = {}
  for (const key of Object.keys(record)) {
    if (!/^[0-6]$/.test(key)) {
      return { ok: false, message: `El horario tiene un día que no existe ("${key}").` }
    }
    const day = DAY_NAMES[Number(key)]
    const blocks = record[key]
    if (!Array.isArray(blocks)) {
      return { ok: false, message: `El horario del ${day} no es válido.` }
    }
    if (blocks.length > MAX_OFFICE_BLOCKS_PER_DAY) {
      return {
        ok: false,
        message: `Un día admite hasta ${MAX_OFFICE_BLOCKS_PER_DAY} tramos de horario (el ${day} tiene más).`,
      }
    }

    const parsed: [string, string][] = []
    for (const block of blocks) {
      if (!Array.isArray(block) || block.length !== 2) {
        return { ok: false, message: `Cada tramo del ${day} debe tener hora de apertura y de cierre.` }
      }
      const start = normalizeClock(block[0])
      const end = normalizeClock(block[1])
      if (!start || !end) {
        return { ok: false, message: `Las horas del ${day} deben ser HH:MM, por ejemplo 08:00.` }
      }
      if (start >= end) {
        return { ok: false, message: `En el ${day}, la hora de apertura debe ser antes que la de cierre.` }
      }
      parsed.push([start, end])
    }
    parsed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

    const merged: [string, string][] = []
    for (const [start, end] of parsed) {
      const last = merged[merged.length - 1]
      if (last && start < last[1]) {
        return { ok: false, message: `Los tramos del ${day} se cruzan.` }
      }
      // Dos tramos que solo se tocan (12:00–14:00 y 14:00–18:00) son uno.
      if (last && start === last[1]) last[1] = end
      else merged.push([start, end])
    }
    if (merged.length > 0) out[key] = merged
  }
  return { ok: true, value: out }
}

function validateInfoText(value: unknown): Valid<string> {
  if (value === null) return { ok: true, value: '' }
  if (typeof value !== 'string') return { ok: false, message: 'El texto de horario y dirección debe ser texto.' }
  // Postgres no admite el carácter NUL, y los demás de control no se pueden decir en voz alta.
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if ([...text].length > MAX_INFO_TEXT) {
    return {
      ok: false,
      message: `El texto de horario y dirección no puede pasar de ${MAX_INFO_TEXT} caracteres.`,
    }
  }
  return { ok: true, value: text }
}

function validateVoice(value: unknown): Valid<string | null> {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return { ok: true, value: null }
  const voice = typeof value === 'string' ? value.trim() : ''
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${VOICE_MAX - 1}}$`).test(voice)) {
    return { ok: false, message: 'La voz no es válida. Usa un nombre como Polly.Mia-Neural.' }
  }
  return { ok: true, value: voice }
}

/**
 * Valida el cuerpo del PATCH de la configuración de llamadas. Las claves llegan
 * como las columnas (`outbound_enabled`, `window_start`…). Una clave que no
 * existe es un error (una errata no debe aparentar que se guardó); `updated_at`
 * y `account_id` se ignoran.
 *
 * `provider`, `monthly_limit`, `inbound_number` y `caller_id` los controla Shift:
 * si llegan se rechaza el parche entero con un mensaje claro (aunque traigan el
 * mismo valor), porque la base rechazaría el cambio con un 42501 sin explicación
 * y un "se guardó" mentiroso sería peor.
 *
 * Si llegan `window_start` y `window_end`, deben ir en orden; con una sola, quien
 * guarda debe revisar la mezcla con lo ya guardado: `mergeAndValidateWindow`.
 */
export function validateCallSettingsPatch(body: unknown): Valid<CallSettingsPatch> {
  const record = asRecord(body)
  if (!record) return { ok: false, message: 'Los ajustes de llamadas no son válidos.' }

  for (const key of Object.keys(record)) {
    if (has(SHIFT_CONTROLLED, key)) {
      return {
        ok: false,
        message: `${SHIFT_CONTROLLED[key]} lo configura Shift y no se puede cambiar desde el panel. Si necesitas cambiarlo, pídeselo a Shift.`,
      }
    }
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, message: `"${key}" no es un ajuste de llamadas válido.` }
    }
  }

  const out: CallSettingsPatch = {}

  const booleans = [
    ['outbound_enabled', 'outboundEnabled', 'La opción de llamadas salientes'],
    ['inbound_enabled', 'inboundEnabled', 'La opción de llamadas entrantes'],
    ['call_saturday', 'callSaturday', 'La opción de llamar los sábados'],
  ] as const
  for (const [column, key, label] of booleans) {
    if (!has(record, column)) continue
    const result = validateBoolean(record[column], label)
    if (!result.ok) return result
    out[key] = result.value
  }

  if (has(record, 'advisor_phones')) {
    const result = validateAdvisorPhones(record.advisor_phones)
    if (!result.ok) return result
    out.advisorPhones = result.value
  }

  if (has(record, 'office_hours')) {
    const result = validateOfficeHours(record.office_hours)
    if (!result.ok) return result
    out.officeHours = result.value
  }

  if (has(record, 'info_text')) {
    const result = validateInfoText(record.info_text)
    if (!result.ok) return result
    out.infoText = result.value
  }

  for (const [column, field] of Object.entries(INTEGER_FIELDS)) {
    if (!has(record, column)) continue
    const value = record[column]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < field.min || value > field.max) {
      return {
        ok: false,
        message: `${field.label} debe ser un número entero entre ${field.min} y ${field.max}.`,
      }
    }
    out[field.key] = value
  }

  for (const [column, key] of [
    ['window_start', 'windowStart'],
    ['window_end', 'windowEnd'],
  ] as const) {
    if (!has(record, column)) continue
    const clock = normalizeClock(record[column])
    if (!clock) {
      return { ok: false, message: 'La hora de las llamadas debe tener el formato HH:MM, por ejemplo 08:00.' }
    }
    out[key] = clock
  }
  if (out.windowStart !== undefined && out.windowEnd !== undefined) {
    const merged = mergeAndValidateWindow(DEFAULT_CALL_SETTINGS, out)
    if (!merged.ok) return merged
  }

  if (has(record, 'voice')) {
    const result = validateVoice(record.voice)
    if (!result.ok) return result
    out.voice = result.value
  }

  if (Object.keys(out).length === 0) return { ok: false, message: 'No hay cambios que guardar.' }
  return { ok: true, value: out }
}

/**
 * La ventana de llamadas que quedaría al guardar un parche: lo que trae el
 * parche y, de lo que no trae, lo ya guardado (`stored`, de `loadCallSettings`).
 * Hace falta cuando llega solo `window_start` o solo `window_end`: cada hora es
 * válida sola, pero la mezcla con la otra guardada puede quedar al revés y la
 * base la rechazaría (CHECK `window_end > window_start`). Sin ninguna de las dos
 * en el parche no revisa nada y devuelve lo guardado.
 */
export function mergeAndValidateWindow(
  stored: Pick<CallSettings, 'windowStart' | 'windowEnd'>,
  patch: Pick<CallSettingsPatch, 'windowStart' | 'windowEnd'>,
): Valid<{ windowStart: string; windowEnd: string }> {
  const windowStart = patch.windowStart ?? stored.windowStart
  const windowEnd = patch.windowEnd ?? stored.windowEnd

  const startChanged = patch.windowStart !== undefined
  const endChanged = patch.windowEnd !== undefined
  if (!startChanged && !endChanged) return { ok: true, value: { windowStart, windowEnd } }

  if (!isValidCallWindow(windowStart, windowEnd)) {
    if (startChanged && endChanged) {
      return { ok: false, message: 'La hora de inicio de las llamadas debe ser antes que la de fin.' }
    }
    return {
      ok: false,
      message: startChanged
        ? `La hora de inicio de las llamadas debe ser antes que la de fin (la guardada es ${windowEnd}).`
        : `La hora de fin de las llamadas debe ser después de la de inicio (la guardada es ${windowStart}).`,
    }
  }
  return { ok: true, value: { windowStart, windowEnd } }
}

/** Parche (camelCase) → columnas de `booking_call_settings`. El texto vacío se guarda como null. */
export function callSettingsToRow(patch: CallSettingsPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const key of Object.keys(COLUMN_OF) as (keyof CallSettingsPatch)[]) {
    const value = patch[key]
    if (value === undefined) continue
    row[COLUMN_OF[key]] = key === 'infoText' && value === '' ? null : value
  }
  return row
}
