// ============================================================
// Borrador de la tarjeta "Llamadas" (puro, sin React).
//
//   - `draftFromSettings` pasa lo que devuelve el servidor al formulario.
//     Los números van como texto (así se puede borrar el campo mientras se
//     escribe) y todos los días de la semana existen, cerrados si no tienen
//     tramos.
//   - `buildPatch` devuelve SOLO lo que cambió, con las claves del PATCH. El
//     servidor rechaza los campos que fija Shift (`provider`, `monthly_limit`,
//     `inbound_number`, `caller_id`), así que ni siquiera existen aquí.
//   - `checkPatch` corre el mismo validador del servidor, para avisar antes
//     de guardar y con los mismos mensajes. `findPatchProblem` además dice
//     cuál campo del formulario falló, para marcarlo (aria-invalid).
//   - Las funciones de horario no mutan: devuelven un horario nuevo.
// ============================================================

import { formatOfficeHours, parseOfficeHours, type OfficeHours } from '@/lib/voice/hours'
import type { CallSettingsPayload } from '@/verticals/agenda/voice/call-settings-payload'
import {
  MAX_OFFICE_BLOCKS_PER_DAY,
  toE164,
  validateCallSettingsPatch,
} from '@/verticals/agenda/voice/settings'

/** De lunes a domingo, como se lee en el horario (0 = domingo). */
export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0] as const

export const DAY_NAMES: Record<number, string> = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  0: 'Domingo',
}

export interface HoursBlock {
  /** 'HH:MM'; puede estar vacío mientras se escribe. */
  start: string
  end: string
}

/** Tramos por día de la semana (0 = domingo). Un día sin tramos está cerrado. */
export type HoursDraft = Record<number, HoursBlock[]>

export interface CallsDraft {
  outboundEnabled: boolean
  inboundEnabled: boolean
  /** Una fila por teléfono; las vacías se ignoran. */
  advisorPhones: string[]
  hours: HoursDraft
  infoText: string
  windowStart: string
  windowEnd: string
  callSaturday: boolean
  maxAttempts: string
  retryMinutes: string
  callAfterMinutes: string
  minLeadMinutes: string
}

/** Tramo con el que se abre un día cerrado. */
const OPENING_BLOCK: HoursBlock = { start: '08:00', end: '18:00' }
/** Tramo que se agrega a un día ya abierto (el de la tarde, tras el almuerzo). */
const EXTRA_BLOCK: HoursBlock = { start: '14:00', end: '18:00' }

// ------------------------------------------------------------
// Del servidor al formulario
// ------------------------------------------------------------

function hoursFromOfficeHours(officeHours: OfficeHours): HoursDraft {
  const hours: HoursDraft = {}
  for (const day of WEEK_DAYS) {
    hours[day] = (officeHours[String(day)] ?? []).map(([start, end]) => ({ start, end }))
  }
  return hours
}

export function draftFromSettings(settings: CallSettingsPayload): CallsDraft {
  return {
    outboundEnabled: settings.outbound_enabled,
    inboundEnabled: settings.inbound_enabled,
    advisorPhones: [...settings.advisor_phones],
    hours: hoursFromOfficeHours(settings.office_hours),
    infoText: settings.info_text,
    windowStart: settings.window_start,
    windowEnd: settings.window_end,
    callSaturday: settings.call_saturday,
    maxAttempts: String(settings.max_attempts),
    retryMinutes: String(settings.retry_minutes),
    callAfterMinutes: String(settings.call_after_minutes),
    minLeadMinutes: String(settings.min_lead_minutes),
  }
}

// ------------------------------------------------------------
// Edición del horario
// ------------------------------------------------------------

const cloneBlocks = (blocks: HoursBlock[] | undefined): HoursBlock[] =>
  (blocks ?? []).map((block) => ({ ...block }))

/** Abre (con un tramo de oficina, si estaba cerrado) o cierra un día. */
export function setDayOpen(hours: HoursDraft, day: number, open: boolean): HoursDraft {
  const current = hours[day] ?? []
  if (!open) return { ...hours, [day]: [] }
  if (current.length > 0) return { ...hours }
  return { ...hours, [day]: [{ ...OPENING_BLOCK }] }
}

/** Agrega un tramo a un día abierto (hasta el máximo que admite la base). */
export function addHoursBlock(hours: HoursDraft, day: number): HoursDraft {
  const current = hours[day] ?? []
  if (current.length === 0 || current.length >= MAX_OFFICE_BLOCKS_PER_DAY) return { ...hours }
  return { ...hours, [day]: [...cloneBlocks(current), { ...EXTRA_BLOCK }] }
}

/** Quita un tramo; si era el último, el día queda cerrado. */
export function removeHoursBlock(hours: HoursDraft, day: number, index: number): HoursDraft {
  return { ...hours, [day]: cloneBlocks(hours[day]).filter((_, i) => i !== index) }
}

export function updateHoursBlock(
  hours: HoursDraft,
  day: number,
  index: number,
  change: Partial<HoursBlock>,
): HoursDraft {
  return {
    ...hours,
    [day]: cloneBlocks(hours[day]).map((block, i) => (i === index ? { ...block, ...change } : block)),
  }
}

/** Copia el horario de un día (por defecto el lunes) a martes, miércoles, jueves y viernes. */
export function copyDayToWeekdays(hours: HoursDraft, from = 1): HoursDraft {
  const next: HoursDraft = { ...hours }
  for (const day of [1, 2, 3, 4, 5]) {
    if (day !== from) next[day] = cloneBlocks(hours[from])
  }
  return next
}

/** El horario tal cual está escrito (sin validar), con la forma de `office_hours`. */
function officeHoursFromDraft(hours: HoursDraft): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {}
  for (const day of WEEK_DAYS) {
    const blocks = hours[day] ?? []
    if (blocks.length > 0) out[String(day)] = blocks.map((block) => [block.start, block.end])
  }
  return out
}

/** Para comparar: tramos ordenados por día, sin mezclar los que se tocan. */
function canonicalHours(hours: HoursDraft): string {
  return JSON.stringify(
    WEEK_DAYS.map((day) =>
      [...(hours[day] ?? [])]
        .map((block) => [block.start, block.end])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)),
    ),
  )
}

/**
 * "de lunes a viernes de 8 a. m. a 6 p. m. y los sábados de 8 a. m. a 1 p. m."
 * Los tramos a medio escribir o al revés no cuentan (la vista previa no se rompe).
 */
export function previewOfficeHours(hours: HoursDraft): string {
  return formatOfficeHours(parseOfficeHours(officeHoursFromDraft(hours)))
}

// ------------------------------------------------------------
// Del formulario al parche
// ------------------------------------------------------------

/** '90' → 90; vacío, con letras, con decimales o negativo → NaN (el validador lo rechaza). */
function wholeNumber(text: string): number {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}

const NUMBER_FIELDS = [
  ['maxAttempts', 'max_attempts'],
  ['retryMinutes', 'retry_minutes'],
  ['callAfterMinutes', 'call_after_minutes'],
  ['minLeadMinutes', 'min_lead_minutes'],
] as const

const BOOLEAN_FIELDS = [
  ['outboundEnabled', 'outbound_enabled'],
  ['inboundEnabled', 'inbound_enabled'],
  ['callSaturday', 'call_saturday'],
] as const

/** Solo lo que cambió respecto a lo guardado, con las claves del PATCH. */
export function buildPatch(original: CallSettingsPayload, draft: CallsDraft): Record<string, unknown> {
  const saved = draftFromSettings(original)
  const patch: Record<string, unknown> = {}

  for (const [field, key] of BOOLEAN_FIELDS) {
    if (draft[field] !== saved[field]) patch[key] = draft[field]
  }

  const phones = draft.advisorPhones.map((phone) => phone.trim()).filter((phone) => phone !== '')
  const normalized = [...new Set(phones.map((phone) => toE164(phone) ?? phone))]
  if (JSON.stringify(normalized) !== JSON.stringify(saved.advisorPhones)) patch.advisor_phones = phones

  if (canonicalHours(draft.hours) !== canonicalHours(saved.hours)) {
    patch.office_hours = officeHoursFromDraft(draft.hours)
  }

  if (draft.infoText.trim() !== saved.infoText.trim()) patch.info_text = draft.infoText

  // Las dos horas viajan juntas: cada una sola puede quedar al revés de la otra.
  if (draft.windowStart !== saved.windowStart || draft.windowEnd !== saved.windowEnd) {
    patch.window_start = draft.windowStart
    patch.window_end = draft.windowEnd
  }

  for (const [field, key] of NUMBER_FIELDS) {
    if (draft[field].trim() !== saved[field]) patch[key] = wholeNumber(draft[field])
  }

  return patch
}

/**
 * Ids de los campos del formulario que corresponden a cada clave del parche. Las
 * claves que no están (el horario y los asesores son varias casillas) solo
 * muestran el mensaje.
 */
const PATCH_FIELD_IDS: Record<string, string[]> = {
  call_after_minutes: ['calls-after'],
  min_lead_minutes: ['calls-lead'],
  max_attempts: ['calls-attempts'],
  retry_minutes: ['calls-retry'],
  window_start: ['calls-window-start'],
  window_end: ['calls-window-end'],
  info_text: ['calls-info'],
}

/** Las dos horas de la ventana se validan en pareja: una puede quedar al revés de la otra. */
const WINDOW_KEYS = ['window_start', 'window_end']

export interface PatchProblem {
  /** El mensaje del validador del servidor. */
  message: string
  /** Ids de los campos que fallaron; vacío si el error no es de una casilla en particular. */
  fieldIds: string[]
}

/**
 * El problema del parche (mensaje y campos), o null si está bien. Busca la clave
 * que falla probando cada una sola; la ventana de llamadas se prueba entera.
 */
export function findPatchProblem(patch: Record<string, unknown>): PatchProblem | null {
  const whole = validateCallSettingsPatch(patch)
  if (whole.ok) return null

  const keys = Object.keys(patch)
  const windowKeys = keys.filter((key) => WINDOW_KEYS.includes(key))
  const groups: string[][] = [
    ...keys.filter((key) => !windowKeys.includes(key)).map((key) => [key]),
    ...(windowKeys.length > 0 ? [windowKeys] : []),
  ]
  for (const group of groups) {
    const subset = Object.fromEntries(group.map((key) => [key, patch[key]]))
    if (!validateCallSettingsPatch(subset).ok) {
      return { message: whole.message, fieldIds: group.flatMap((key) => PATCH_FIELD_IDS[key] ?? []) }
    }
  }
  return { message: whole.message, fieldIds: [] }
}

/** El mensaje del validador del servidor para este parche, o null si está bien. */
export function checkPatch(patch: Record<string, unknown>): string | null {
  return findPatchProblem(patch)?.message ?? null
}
