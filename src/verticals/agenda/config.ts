// ============================================================
// Validaciones de la configuración del vertical (Fase 4) — puras.
//
// Toda escritura de la API pasa por aquí antes de tocar la base:
// mensajes en es-CO listos para la UI, límites alineados con los
// CHECK de la migración 047 y con el formato de la interfaz.
//
// Regla de oro de este módulo: jamás lanza. Devuelve `{ ok: false,
// message }` para errores de validación; el repositorio (config-repo)
// es el único que lanza `ConfigError` para conflictos con la base
// (no encontrado, nombre duplicado, orden inconsistente).
// ============================================================

import { sanitizeBotTexts, type BotTextOverrides } from './bot-texts'
import { LABEL_KEYS, sanitizeLabels, type AgendaLabelKey, type AgendaLabels } from './labels'
import { isPresetKey, type PresetKey } from './presets'
import { TOGGLE_COLUMNS, TOGGLE_KEYS, type AgendaToggles } from './toggles'

// ------------------------------------------------------------
// Contrato
// ------------------------------------------------------------

export type Valid<T> = { ok: true; value: T } | { ok: false; message: string }

export type ConfigErrorCode = 'not_found' | 'duplicate_name' | 'invalid_order'

/**
 * Conflicto detectado al hablar con la base. Las rutas lo traducen a
 * 404 / 409 con el mensaje ya en es-CO.
 */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode

  constructor(code: ConfigErrorCode, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

export const CONFIG_ERROR_STATUS: Record<ConfigErrorCode, number> = {
  not_found: 404,
  duplicate_name: 409,
  invalid_order: 409,
}

// ------------------------------------------------------------
// Límites (fuente única para API y UI)
// ------------------------------------------------------------

export const SERVICE_NAME_MAX = 80
export const STAFF_NAME_MAX = 80
export const DESCRIPTION_MAX = 300
export const BIO_MAX = 300
export const ADDRESS_MAX = 200
export const DURATION_MIN_MINUTES = 1
export const DURATION_MAX_MINUTES = 480
export const PRICE_MAX = 99_999_999.99
export const TIME_OFF_REASON_MAX = 120
export const TIME_OFF_MAX_DAYS = 366
export const MAX_WORK_BLOCKS = 21

const WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  return input as Record<string, unknown>
}

const has = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key)

/** Número JSON finito. Los strings no se aceptan: la UI envía números. */
function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function priceHasTwoDecimals(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
}

/** 'HH:MM' normalizado (acepta 'H:MM'); null si no es una hora válida. */
function normalizeHHMM(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${match[2]}`
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// ------------------------------------------------------------
// Servicios
// ------------------------------------------------------------

export interface ServiceCreateInput {
  name: string
  description: string | null
  durationMinutes: number
  price: number
  isActive: boolean
}

export interface ServiceUpdateInput {
  name?: string
  description?: string | null
  durationMinutes?: number
  price?: number
  isActive?: boolean
}

function validateName(
  raw: unknown,
  label: string,
): Valid<string> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: `El ${label} es obligatorio.` }
  }
  const name = raw.trim()
  if (name.length > SERVICE_NAME_MAX) {
    return {
      ok: false,
      message: `El ${label} no puede pasar de ${SERVICE_NAME_MAX} caracteres.`,
    }
  }
  return { ok: true, value: name }
}

function validateDescription(raw: unknown): Valid<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') {
    return { ok: false, message: 'La descripción debe ser texto.' }
  }
  const text = raw.trim()
  if (!text) return { ok: true, value: null }
  if (text.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      message: `La descripción no puede pasar de ${DESCRIPTION_MAX} caracteres.`,
    }
  }
  return { ok: true, value: text }
}

function validateDuration(raw: unknown): Valid<number> {
  const value = finiteNumber(raw)
  if (
    value === null ||
    !Number.isInteger(value) ||
    value < DURATION_MIN_MINUTES ||
    value > DURATION_MAX_MINUTES
  ) {
    return {
      ok: false,
      message: `La duración debe ser un número entero entre ${DURATION_MIN_MINUTES} y ${DURATION_MAX_MINUTES} minutos.`,
    }
  }
  return { ok: true, value }
}

function validatePrice(raw: unknown): Valid<number> {
  const value = finiteNumber(raw)
  if (value === null || value < 0 || value > PRICE_MAX || !priceHasTwoDecimals(value)) {
    return {
      ok: false,
      message:
        'El precio debe estar entre 0 y 99.999.999,99 con máximo 2 decimales.',
    }
  }
  return { ok: true, value }
}

export function validateServiceCreate(input: unknown): Valid<ServiceCreateInput> {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, message: 'Los datos del servicio no son válidos.' }
  }

  const name = validateName(record.name, 'nombre del servicio')
  if (!name.ok) return name
  const description = validateDescription(record.description)
  if (!description.ok) return description
  const duration = validateDuration(record.duration_minutes)
  if (!duration.ok) return duration
  const price = validatePrice(record.price)
  if (!price.ok) return price

  let isActive = true
  if (has(record, 'is_active')) {
    if (typeof record.is_active !== 'boolean') {
      return { ok: false, message: 'El estado del servicio debe ser sí o no.' }
    }
    isActive = record.is_active
  }

  return {
    ok: true,
    value: {
      name: name.value,
      description: description.value,
      durationMinutes: duration.value,
      price: price.value,
      isActive,
    },
  }
}

export function validateServiceUpdate(input: unknown): Valid<ServiceUpdateInput> {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, message: 'Los datos del servicio no son válidos.' }
  }

  const out: ServiceUpdateInput = {}
  let any = false

  if (has(record, 'name')) {
    const name = validateName(record.name, 'nombre del servicio')
    if (!name.ok) return name
    out.name = name.value
    any = true
  }
  if (has(record, 'description')) {
    const description = validateDescription(record.description)
    if (!description.ok) return description
    out.description = description.value
    any = true
  }
  if (has(record, 'duration_minutes')) {
    const duration = validateDuration(record.duration_minutes)
    if (!duration.ok) return duration
    out.durationMinutes = duration.value
    any = true
  }
  if (has(record, 'price')) {
    const price = validatePrice(record.price)
    if (!price.ok) return price
    out.price = price.value
    any = true
  }
  if (has(record, 'is_active')) {
    if (typeof record.is_active !== 'boolean') {
      return { ok: false, message: 'El estado del servicio debe ser sí o no.' }
    }
    out.isActive = record.is_active
    any = true
  }

  if (!any) {
    return { ok: false, message: 'No hay cambios que guardar en el servicio.' }
  }
  return { ok: true, value: out }
}

// ------------------------------------------------------------
// Barberos
// ------------------------------------------------------------

export interface StaffCreateInput {
  name: string
  bio: string | null
}

export interface StaffUpdateInput {
  name?: string
  bio?: string | null
  isActive?: boolean
}

function validateBio(raw: unknown): Valid<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') {
    return { ok: false, message: 'La descripción del barbero debe ser texto.' }
  }
  const text = raw.trim()
  if (!text) return { ok: true, value: null }
  if (text.length > BIO_MAX) {
    return {
      ok: false,
      message: `La descripción del barbero no puede pasar de ${BIO_MAX} caracteres.`,
    }
  }
  return { ok: true, value: text }
}

export function validateStaffCreate(input: unknown): Valid<StaffCreateInput> {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, message: 'Los datos del barbero no son válidos.' }
  }

  if (typeof record.name !== 'string' || !record.name.trim()) {
    return { ok: false, message: 'El nombre del barbero es obligatorio.' }
  }
  const name = record.name.trim()
  if (name.length > STAFF_NAME_MAX) {
    return {
      ok: false,
      message: `El nombre del barbero no puede pasar de ${STAFF_NAME_MAX} caracteres.`,
    }
  }

  const bio = validateBio(record.bio)
  if (!bio.ok) return bio

  return { ok: true, value: { name, bio: bio.value } }
}

export function validateStaffUpdate(input: unknown): Valid<StaffUpdateInput> {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, message: 'Los datos del barbero no son válidos.' }
  }

  const out: StaffUpdateInput = {}
  let any = false

  if (has(record, 'name')) {
    if (typeof record.name !== 'string' || !record.name.trim()) {
      return { ok: false, message: 'El nombre del barbero es obligatorio.' }
    }
    const name = record.name.trim()
    if (name.length > STAFF_NAME_MAX) {
      return {
        ok: false,
        message: `El nombre del barbero no puede pasar de ${STAFF_NAME_MAX} caracteres.`,
      }
    }
    out.name = name
    any = true
  }
  if (has(record, 'bio')) {
    const bio = validateBio(record.bio)
    if (!bio.ok) return bio
    out.bio = bio.value
    any = true
  }
  if (has(record, 'is_active')) {
    if (typeof record.is_active !== 'boolean') {
      return { ok: false, message: 'El estado del barbero debe ser sí o no.' }
    }
    out.isActive = record.is_active
    any = true
  }

  if (!any) {
    return { ok: false, message: 'No hay cambios que guardar en el barbero.' }
  }
  return { ok: true, value: out }
}

export function validateStaffServices(input: unknown): Valid<string[]> {
  const record = asRecord(input)
  if (!record || !Array.isArray(record.service_ids)) {
    return { ok: false, message: 'La lista de servicios no es válida.' }
  }
  const ids: string[] = []
  for (const raw of record.service_ids) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, message: 'La lista de servicios no es válida.' }
    }
    ids.push(raw.trim())
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, message: 'La lista de servicios tiene repetidos.' }
  }
  return { ok: true, value: ids }
}

// ------------------------------------------------------------
// Horario semanal
// ------------------------------------------------------------

export interface WorkBlockInput {
  weekday: number
  /** 'HH:MM' ya normalizado. */
  startTime: string
  /** 'HH:MM'; siempre mayor que startTime. */
  endTime: string
}

export function validateWorkingHours(input: unknown): Valid<WorkBlockInput[]> {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'El horario no es válido.' }
  }
  if (input.length > MAX_WORK_BLOCKS) {
    return {
      ok: false,
      message: `El horario no puede tener más de ${MAX_WORK_BLOCKS} bloques.`,
    }
  }

  const blocks: WorkBlockInput[] = []
  for (const raw of input) {
    const record = asRecord(raw)
    if (!record) return { ok: false, message: 'El horario no es válido.' }

    const weekday = finiteNumber(record.weekday)
    if (weekday === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, message: 'El horario tiene un día inválido.' }
    }

    const start = normalizeHHMM(record.start_time ?? record.startTime)
    const end = normalizeHHMM(record.end_time ?? record.endTime)
    if (!start || !end) {
      return {
        ok: false,
        message: 'Las horas del horario deben tener formato HH:MM.',
      }
    }
    if (minutesOf(end) <= minutesOf(start)) {
      return {
        ok: false,
        message: `La hora final debe ser mayor que la inicial (${WEEKDAY_NAMES[weekday]}).`,
      }
    }
    blocks.push({ weekday, startTime: start, endTime: end })
  }

  // Sin traslapes dentro del mismo día. Intervalos semiabiertos:
  // un bloque que termina a las 12:00 y otro que arranca a las 12:00
  // conviven (turnos partidos, almuerzo en el hueco).
  const byDay = new Map<number, WorkBlockInput[]>()
  for (const block of blocks) {
    const list = byDay.get(block.weekday) ?? []
    list.push(block)
    byDay.set(block.weekday, list)
  }
  for (const [weekday, list] of byDay) {
    list.sort((a, b) => minutesOf(a.startTime) - minutesOf(b.startTime))
    for (let i = 1; i < list.length; i++) {
      if (minutesOf(list[i].startTime) < minutesOf(list[i - 1].endTime)) {
        return {
          ok: false,
          message: `Los bloques del ${WEEKDAY_NAMES[weekday]} se traslapan. Ajusta las horas para que no se crucen.`,
        }
      }
    }
  }

  return { ok: true, value: blocks }
}

// ------------------------------------------------------------
// Bloqueos puntuales (time off)
// ------------------------------------------------------------

export interface TimeOffCreateInput {
  staffId: string
  startsAtIso: string
  endsAtIso: string
  reason: string | null
}

export function validateTimeOffCreate(input: unknown): Valid<TimeOffCreateInput> {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, message: 'Los datos del bloqueo no son válidos.' }
  }

  if (typeof record.staff_id !== 'string' || !record.staff_id.trim()) {
    return { ok: false, message: 'Elige el barbero del bloqueo.' }
  }

  if (typeof record.starts_at !== 'string' || typeof record.ends_at !== 'string') {
    return { ok: false, message: 'El bloqueo necesita fecha de inicio y de fin.' }
  }
  const startsMs = Date.parse(record.starts_at)
  const endsMs = Date.parse(record.ends_at)
  if (!Number.isFinite(startsMs) || !Number.isFinite(endsMs)) {
    return { ok: false, message: 'Las fechas del bloqueo no son válidas.' }
  }
  if (endsMs <= startsMs) {
    return {
      ok: false,
      message: 'La fecha final debe ser posterior a la inicial.',
    }
  }
  if (endsMs - startsMs > TIME_OFF_MAX_DAYS * 86_400_000) {
    return {
      ok: false,
      message: `Un bloqueo no puede durar más de ${TIME_OFF_MAX_DAYS} días.`,
    }
  }

  let reason: string | null = null
  if (record.reason !== null && record.reason !== undefined) {
    if (typeof record.reason !== 'string') {
      return { ok: false, message: 'El motivo debe ser texto.' }
    }
    const text = record.reason.trim()
    if (text.length > TIME_OFF_REASON_MAX) {
      return {
        ok: false,
        message: `El motivo no puede pasar de ${TIME_OFF_REASON_MAX} caracteres.`,
      }
    }
    reason = text || null
  }

  return {
    ok: true,
    value: {
      staffId: record.staff_id.trim(),
      startsAtIso: new Date(startsMs).toISOString(),
      endsAtIso: new Date(endsMs).toISOString(),
      reason,
    },
  }
}

// ------------------------------------------------------------
// Orden (servicios y barberos)
// ------------------------------------------------------------

/**
 * La lista debe ser una PERMUTACIÓN exacta de los ids actuales de la
 * cuenta: mismo tamaño, sin repetidos y mismos elementos. Así el
 * reordenamiento es idempotente y no pierde ni inventa filas.
 */
export function validateOrder(input: unknown, expectedIds: string[]): Valid<string[]> {
  const record = asRecord(input)
  if (!record || !Array.isArray(record.ids)) {
    return { ok: false, message: 'La lista de orden no es válida.' }
  }
  const ids: string[] = []
  for (const raw of record.ids) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, message: 'La lista de orden no es válida.' }
    }
    ids.push(raw.trim())
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, message: 'La lista de orden tiene elementos repetidos.' }
  }
  if (ids.length !== expectedIds.length) {
    return {
      ok: false,
      message: 'La lista de orden debe incluir todos los elementos actuales.',
    }
  }
  const expected = new Set(expectedIds)
  if (!ids.every((id) => expected.has(id))) {
    return {
      ok: false,
      message: 'La lista de orden no coincide con los elementos actuales.',
    }
  }
  return { ok: true, value: ids }
}

// ------------------------------------------------------------
// Ajustes de configuración (negocio + bot)
// ------------------------------------------------------------

export interface ConfigPatch {
  address?: string | null
  currency?: string
  reminders2hEnabled?: boolean
  botTexts?: BotTextOverrides
  labels?: Partial<AgendaLabels>
  /** Palabras que el dueño vació (null o en blanco): vuelven a su valor por defecto. */
  labelsReset?: AgendaLabelKey[]
  toggles?: Partial<AgendaToggles>
  presetKey?: PresetKey
}

export function validateConfigPatch(input: unknown): Valid<ConfigPatch> {
  const record = asRecord(input)
  if (!record) {
    return { ok: false, message: 'Los ajustes no son válidos.' }
  }

  const out: ConfigPatch = {}
  let any = false

  if (has(record, 'address')) {
    if (record.address === null) {
      out.address = null
      any = true
    } else if (typeof record.address !== 'string') {
      return { ok: false, message: 'La dirección debe ser texto.' }
    } else {
      const address = record.address.trim()
      if (address.length > ADDRESS_MAX) {
        return {
          ok: false,
          message: `La dirección no puede pasar de ${ADDRESS_MAX} caracteres.`,
        }
      }
      out.address = address || null
      any = true
    }
  }

  if (has(record, 'currency')) {
    if (typeof record.currency !== 'string') {
      return {
        ok: false,
        message: 'La moneda debe ser un código ISO de 3 letras.',
      }
    }
    // Forma ISO-4217, igual que el CHECK de accounts.default_currency
    // (migración 021). A propósito NO se importa lib/currency: arrastra
    // el runtime de i18n y este módulo debe ser puro y testeable en
    // cualquier entorno. La UI solo ofrece códigos de CURRENCIES.
    const code = record.currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) {
      return {
        ok: false,
        message: 'La moneda debe ser un código ISO de 3 letras.',
      }
    }
    out.currency = code
    any = true
  }

  if (has(record, 'reminders_2h_enabled')) {
    if (typeof record.reminders_2h_enabled !== 'boolean') {
      return {
        ok: false,
        message: 'La segunda señal debe ser sí o no.',
      }
    }
    out.reminders2hEnabled = record.reminders_2h_enabled
    any = true
  }

  if (has(record, 'bot_texts')) {
    const sanitized = sanitizeBotTexts(record.bot_texts)
    if (!sanitized.ok) return sanitized
    out.botTexts = sanitized.value
    any = true
  }

  if (has(record, 'labels')) {
    // Igual que las piezas: `null`, una lista o un texto no son un objeto de palabras.
    const rawLabels = asRecord(record.labels)
    if (!rawLabels) {
      return { ok: false, message: 'Las palabras deben ser un objeto de clave a texto.' }
    }
    // sanitizeLabels ignora en silencio las claves que no conoce; aquí una errata
    // ("turno" por "cita") debe avisar, no aparentar que se guardó.
    for (const key of Object.keys(rawLabels)) {
      if (!(LABEL_KEYS as readonly string[]).includes(key)) {
        return { ok: false, message: `"${key}" no es una palabra válida.` }
      }
    }
    const labels = sanitizeLabels(rawLabels)
    if (!labels.ok) return labels
    // sanitizeLabels descarta lo vacío; aquí un null o un texto en blanco
    // sobre una palabra conocida es un "volver al valor por defecto" explícito.
    const reset = LABEL_KEYS.filter((key) => {
      if (!has(rawLabels, key)) return false
      const value = rawLabels[key]
      return value === null || (typeof value === 'string' && value.trim() === '')
    })
    // Un objeto sin palabras que guardar ni reiniciar no es un cambio.
    if (Object.keys(labels.value).length > 0) out.labels = labels.value
    if (reset.length > 0) out.labelsReset = reset
    if (out.labels || out.labelsReset) any = true
  }

  if (has(record, 'toggles')) {
    const raw = asRecord(record.toggles)
    if (!raw) return { ok: false, message: 'Las piezas no son válidas.' }
    const toggles: Partial<AgendaToggles> = {}
    let anyToggle = false
    for (const key of TOGGLE_KEYS) {
      const column = TOGGLE_COLUMNS[key]
      if (!has(raw, column)) continue
      const value = raw[column]
      // Nada de coerción: "no" o 0 no son un apagado, son un error del cliente.
      if (typeof value !== 'boolean') {
        return { ok: false, message: 'Cada pieza debe ser sí o no.' }
      }
      toggles[key] = value
      anyToggle = true
    }
    // Un objeto sin ninguna pieza conocida no es un cambio.
    if (anyToggle) {
      out.toggles = toggles
      any = true
    }
  }

  if (has(record, 'preset_key')) {
    // El tipo de negocio se cambia, no se quita: no hay "sin tipo" al que volver.
    if (record.preset_key === null) {
      return { ok: false, message: 'Elige un tipo de negocio.' }
    }
    if (!isPresetKey(record.preset_key)) {
      return { ok: false, message: 'Ese tipo de negocio no existe.' }
    }
    out.presetKey = record.preset_key
    any = true
  }

  if (!any) {
    return { ok: false, message: 'No hay cambios que guardar.' }
  }
  return { ok: true, value: out }
}
