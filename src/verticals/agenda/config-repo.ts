// ============================================================
// Repositorio de configuración del vertical (Fase 4) — datos.
//
// Única puerta de escritura de la configuración: las rutas validan
// con config.ts y luego llaman aquí. Reglas:
//
//   - Toda consulta/escritura va filtrada por `account_id`. Un id de
//     otra cuenta se comporta como inexistente (ConfigError
//     'not_found'), nunca como dato ajeno editable.
//   - Nombres únicos por cuenta (case-insensitive): crear o renombrar
//     a un nombre ya usado (activo o inactivo) es ConfigError
//     'duplicate_name' — evita el doble clic y los catálogos con
//     "Corte" repetido.
//   - Nada se borra salvo bloqueos: desactivar escribe `is_active`
//     y el historial de citas queda intacto (service_id/staff_id
//     nullables en booking_appointments).
//   - Relación barbero-servicios y horarios se actualizan por DIFF
//     (insertar lo nuevo, borrar lo que sobra): repetir la misma
//     llamada dos veces no cambia nada y no se pierde nada si falla
//     a mitad.
//   - Ids nuevos con randomUUID (mismo mimo que el instalador): no se
//     depende del default de Postgres para devolver la fila.
// ============================================================

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { sanitizeBotTexts, type BotTextOverrides } from './bot-texts'
import {
  ConfigError,
  type ServiceCreateInput,
  type ServiceUpdateInput,
  type StaffCreateInput,
  type StaffUpdateInput,
  type TimeOffCreateInput,
  type WorkBlockInput,
} from './config'
import {
  LABEL_KEYS,
  readLabels,
  sanitizeLabels,
  type AgendaLabelKey,
  type AgendaLabels,
} from './labels'
import { MAX_QUESTIONS, readQuestion, type AgendaQuestion, type QuestionInput } from './questions'
import { togglesFromRow, togglesToRow, type AgendaToggles } from './toggles'

// ------------------------------------------------------------
// Filas y registros
// ------------------------------------------------------------

interface ServiceRow {
  id: string
  name: string
  description: string | null
  duration_minutes: number
  price: number
  is_active: boolean
  position: number
}

interface StaffRow {
  id: string
  name: string
  bio: string | null
  is_active: boolean
  position: number
}

interface MappingRow {
  service_id: string
}

interface HoursRow {
  id: string
  weekday: number
  start_time: string
  end_time: string
}

interface TimeOffRow {
  id: string
  staff_id: string
  starts_at: string
  ends_at: string
  reason: string | null
}

interface SettingsRow {
  account_id: string
  address: string | null
  reminders_2h_enabled: boolean
  bot_texts: unknown
  labels: unknown
  preset_key: string | null
  // Más las columnas de las piezas (TOGGLE_COLUMNS), que se leen con togglesFromRow.
  [column: string]: unknown
}

export interface ServiceRecord {
  id: string
  name: string
  description: string | null
  durationMinutes: number
  price: number
  isActive: boolean
  position: number
}

export interface StaffRecord {
  id: string
  name: string
  bio: string | null
  isActive: boolean
  position: number
}

export interface TimeOffRecord {
  id: string
  staffId: string
  startsAt: string
  endsAt: string
  reason: string | null
}

export interface SettingsRecord {
  address: string | null
  reminders2hEnabled: boolean
  botTexts: BotTextOverrides
  /** Las seis palabras, ya mezcladas con los defaults. */
  labels: AgendaLabels
  toggles: AgendaToggles
  presetKey: string | null
}

const SETTINGS_COLS =
  'account_id, address, reminders_2h_enabled, bot_texts, labels, preset_key, choose_staff, show_price, show_duration, reminders_enabled, allow_reschedule'

const SERVICE_COLS =
  'id, name, description, duration_minutes, price, is_active, position'
const STAFF_COLS = 'id, name, bio, is_active, position'

function mapService(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: Number(row.duration_minutes),
    // numeric(12,2) viaja como número por PostgREST; Number() protege
    // por si alguna configuración lo serializa como texto.
    price: Number(row.price),
    isActive: Boolean(row.is_active),
    position: Number(row.position),
  }
}

function mapStaff(row: StaffRow): StaffRecord {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    isActive: Boolean(row.is_active),
    position: Number(row.position),
  }
}

function mapTimeOff(row: TimeOffRow): TimeOffRecord {
  return {
    id: row.id,
    staffId: row.staff_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
  }
}

/** 'HH:MM:SS' (como lo devuelve Postgres) → 'HH:MM' para comparar. */
function toHHMM(value: string): string {
  return value.slice(0, 5)
}

function assertNameFree(
  rows: { id: string; name: string }[],
  name: string,
  conflictMessage: string,
  exceptId?: string,
): void {
  const wanted = name.trim().toLowerCase()
  const clash = rows.find(
    (row) => row.id !== exceptId && row.name.trim().toLowerCase() === wanted,
  )
  if (clash) {
    throw new ConfigError('duplicate_name', conflictMessage)
  }
}

const SERVICE_NAME_TAKEN = 'Ya existe un servicio con ese nombre.'
const STAFF_NAME_TAKEN = 'Ya existe alguien del equipo con ese nombre.'

// ------------------------------------------------------------
// Servicios
// ------------------------------------------------------------

/** Ids de los servicios de la cuenta, en orden de presentación. */
export async function listServiceIds(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const { data } = await db
    .from('booking_services')
    .select('id')
    .eq('account_id', accountId)
    .order('position', { ascending: true })
  return ((data ?? []) as { id: string }[]).map((row) => row.id)
}

export async function createService(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  input: ServiceCreateInput,
): Promise<ServiceRecord> {
  const { data: existing } = await db
    .from('booking_services')
    .select('id, name, position')
    .eq('account_id', accountId)
  const rows = (existing ?? []) as { id: string; name: string; position: number }[]
  assertNameFree(rows, input.name, SERVICE_NAME_TAKEN)

  const position =
    rows.reduce((max, row) => Math.max(max, Number(row.position) || 0), -1) + 1

  const { data } = await db
    .from('booking_services')
    .insert({
      id: randomUUID(),
      account_id: accountId,
      created_by: userId,
      name: input.name,
      description: input.description,
      duration_minutes: input.durationMinutes,
      price: input.price,
      is_active: input.isActive,
      position,
    })
    .select(SERVICE_COLS)
    .maybeSingle()
  if (!data) throw new Error('No se pudo crear el servicio.')
  return mapService(data as ServiceRow)
}

export async function updateService(
  db: SupabaseClient,
  accountId: string,
  id: string,
  patch: ServiceUpdateInput,
): Promise<ServiceRecord> {
  const { data: current } = await db
    .from('booking_services')
    .select('id, name')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!current) {
    throw new ConfigError('not_found', 'El servicio no existe.')
  }

  if (patch.name !== undefined) {
    const { data: existing } = await db
      .from('booking_services')
      .select('id, name')
      .eq('account_id', accountId)
    assertNameFree(
      (existing ?? []) as { id: string; name: string }[],
      patch.name,
      SERVICE_NAME_TAKEN,
      id,
    )
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.description !== undefined) update.description = patch.description
  if (patch.durationMinutes !== undefined) {
    update.duration_minutes = patch.durationMinutes
  }
  if (patch.price !== undefined) update.price = patch.price
  if (patch.isActive !== undefined) update.is_active = patch.isActive

  const { data } = await db
    .from('booking_services')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
    .select(SERVICE_COLS)
    .maybeSingle()
  if (!data) {
    throw new ConfigError('not_found', 'El servicio no existe.')
  }
  return mapService(data as ServiceRow)
}

/**
 * Reescribe las posiciones según la lista dada (permutación validada
 * por la ruta). El update va filtrado por cuenta: un id ajeno no toca
 * nada.
 */
export async function reorderServices(
  db: SupabaseClient,
  accountId: string,
  ids: string[],
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    const { error } = await db
      .from('booking_services')
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
    assertWrite(error, 'reordenar los servicios')
  }
}

/**
 * Una escritura de configuración que falla debe llegar a la UI como
 * error (500 vía toErrorResponse), nunca como "Guardado".
 */
function assertWrite(
  error: { message?: string } | null,
  label: string,
): void {
  if (error) throw new Error(`No se pudo ${label}: ${error.message ?? 'error'}`)
}

// ------------------------------------------------------------
// Barberos
// ------------------------------------------------------------

export async function listStaffIds(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const { data } = await db
    .from('booking_staff')
    .select('id')
    .eq('account_id', accountId)
    .order('position', { ascending: true })
  return ((data ?? []) as { id: string }[]).map((row) => row.id)
}

export async function createStaff(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  input: StaffCreateInput,
): Promise<StaffRecord> {
  const { data: existing } = await db
    .from('booking_staff')
    .select('id, name, position')
    .eq('account_id', accountId)
  const rows = (existing ?? []) as { id: string; name: string; position: number }[]
  assertNameFree(rows, input.name, STAFF_NAME_TAKEN)

  const position =
    rows.reduce((max, row) => Math.max(max, Number(row.position) || 0), -1) + 1

  const { data } = await db
    .from('booking_staff')
    .insert({
      id: randomUUID(),
      account_id: accountId,
      created_by: userId,
      name: input.name,
      bio: input.bio,
      is_active: true,
      position,
    })
    .select(STAFF_COLS)
    .maybeSingle()
  if (!data) throw new Error('No se pudo crear a la persona del equipo.')
  return mapStaff(data as StaffRow)
}

export async function updateStaff(
  db: SupabaseClient,
  accountId: string,
  id: string,
  patch: StaffUpdateInput,
): Promise<StaffRecord> {
  const { data: current } = await db
    .from('booking_staff')
    .select('id, name')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!current) {
    throw new ConfigError('not_found', 'Esa persona del equipo no existe.')
  }

  if (patch.name !== undefined) {
    const { data: existing } = await db
      .from('booking_staff')
      .select('id, name')
      .eq('account_id', accountId)
    assertNameFree(
      (existing ?? []) as { id: string; name: string }[],
      patch.name,
      STAFF_NAME_TAKEN,
      id,
    )
  }

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.bio !== undefined) update.bio = patch.bio
  if (patch.isActive !== undefined) update.is_active = patch.isActive

  const { data } = await db
    .from('booking_staff')
    .update(update)
    .eq('id', id)
    .eq('account_id', accountId)
    .select(STAFF_COLS)
    .maybeSingle()
  if (!data) {
    throw new ConfigError('not_found', 'Esa persona del equipo no existe.')
  }
  return mapStaff(data as StaffRow)
}

export async function reorderStaff(
  db: SupabaseClient,
  accountId: string,
  ids: string[],
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    const { error } = await db
      .from('booking_staff')
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
    assertWrite(error, 'reordenar al equipo')
  }
}

// ------------------------------------------------------------
// Relación barbero ↔ servicios
// ------------------------------------------------------------

async function assertStaffExists(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
): Promise<void> {
  const { data } = await db
    .from('booking_staff')
    .select('id')
    .eq('id', staffId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data) {
    throw new ConfigError('not_found', 'Esa persona del equipo no existe.')
  }
}

/**
 * Reemplaza el set de servicios del barbero con DIFF: la intersección
 * queda intacta, se agregan los nuevos y se borran los que salieron.
 */
export async function setStaffServices(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
  serviceIds: string[],
): Promise<number> {
  await assertStaffExists(db, accountId, staffId)

  if (serviceIds.length) {
    const { data: found } = await db
      .from('booking_services')
      .select('id')
      .eq('account_id', accountId)
      .in('id', serviceIds)
    if (((found ?? []) as { id: string }[]).length !== serviceIds.length) {
      throw new ConfigError('not_found', 'Algún servicio seleccionado no existe.')
    }
  }

  const { data: existing } = await db
    .from('booking_staff_services')
    .select('service_id')
    .eq('account_id', accountId)
    .eq('staff_id', staffId)
  const current = new Set(
    ((existing ?? []) as MappingRow[]).map((row) => row.service_id),
  )

  const wanted = new Set(serviceIds)
  const toAdd = serviceIds.filter((id) => !current.has(id))
  const toRemove = [...current].filter((id) => !wanted.has(id))

  if (toAdd.length) {
    const { error } = await db.from('booking_staff_services').insert(
      toAdd.map((serviceId) => ({
        account_id: accountId,
        staff_id: staffId,
        service_id: serviceId,
      })),
    )
    assertWrite(error, 'asignar los servicios de la persona')
  }
  if (toRemove.length) {
    const { error } = await db
      .from('booking_staff_services')
      .delete()
      .eq('account_id', accountId)
      .eq('staff_id', staffId)
      .in('service_id', toRemove)
    assertWrite(error, 'quitar servicios de la persona')
  }

  return serviceIds.length
}

// ------------------------------------------------------------
// Horario semanal
// ------------------------------------------------------------

/**
 * Reemplaza el horario del barbero con DIFF por bloque
 * (weekday + HH:MM inicio + HH:MM fin). Los bloques idénticos no se
 * tocan: guardar dos veces el mismo horario no reescribe filas.
 */
export async function replaceWorkingHours(
  db: SupabaseClient,
  accountId: string,
  staffId: string,
  blocks: WorkBlockInput[],
): Promise<number> {
  await assertStaffExists(db, accountId, staffId)

  const { data: existing } = await db
    .from('booking_working_hours')
    .select('id, weekday, start_time, end_time')
    .eq('account_id', accountId)
    .eq('staff_id', staffId)
  const rows = (existing ?? []) as HoursRow[]

  const keyOf = (weekday: number, start: string, end: string) =>
    `${weekday}|${toHHMM(start)}|${toHHMM(end)}`

  const current = new Map(
    rows.map((row) => [keyOf(row.weekday, row.start_time, row.end_time), row.id]),
  )
  const wanted = new Map(
    blocks.map((block) => [
      keyOf(block.weekday, block.startTime, block.endTime),
      block,
    ]),
  )

  const toRemoveIds = [...current.entries()]
    .filter(([key]) => !wanted.has(key))
    .map(([, id]) => id)
  const toAdd = [...wanted.entries()]
    .filter(([key]) => !current.has(key))
    .map(([, block]) => block)

  // Primero se insertan los bloques nuevos y DESPUÉS se borran los
  // viejos: si el insert falla, el barbero conserva su horario anterior
  // en vez de quedar sin horario. Cualquier fallo sube como error.
  if (toAdd.length) {
    const { error } = await db.from('booking_working_hours').insert(
      toAdd.map((block) => ({
        id: randomUUID(),
        account_id: accountId,
        staff_id: staffId,
        weekday: block.weekday,
        start_time: block.startTime,
        end_time: block.endTime,
      })),
    )
    assertWrite(error, 'guardar el horario')
  }
  if (toRemoveIds.length) {
    const { error } = await db
      .from('booking_working_hours')
      .delete()
      .eq('account_id', accountId)
      .in('id', toRemoveIds)
    assertWrite(error, 'quitar los bloques viejos del horario')
  }

  return blocks.length
}

// ------------------------------------------------------------
// Bloqueos puntuales (time off)
// ------------------------------------------------------------

export async function createTimeOff(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  input: TimeOffCreateInput,
): Promise<TimeOffRecord> {
  await assertStaffExists(db, accountId, input.staffId)

  const { data } = await db
    .from('booking_time_off')
    .insert({
      id: randomUUID(),
      account_id: accountId,
      staff_id: input.staffId,
      starts_at: input.startsAtIso,
      ends_at: input.endsAtIso,
      reason: input.reason,
      created_by: userId,
    })
    .select('id, staff_id, starts_at, ends_at, reason')
    .maybeSingle()
  if (!data) throw new Error('No se pudo crear el bloqueo.')
  return mapTimeOff(data as TimeOffRow)
}

export async function deleteTimeOff(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<void> {
  const { data } = await db
    .from('booking_time_off')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id')
  if (!((data ?? []) as { id: string }[]).length) {
    throw new ConfigError('not_found', 'El bloqueo no existe.')
  }
}

// ------------------------------------------------------------
// Ajustes (booking_settings + moneda de la cuenta)
// ------------------------------------------------------------

/**
 * Upsert de `booking_settings` con SOLO los campos presentes: guardar
 * la dirección no pisa los textos del bot ni la señal de 2 h, y las
 * claves ausentes toman el default de la tabla cuando la fila es nueva.
 */
export async function saveSettings(
  db: SupabaseClient,
  accountId: string,
  patch: {
    address?: string | null
    reminders2hEnabled?: boolean
    botTexts?: BotTextOverrides
    /** Se MEZCLA con las palabras ya guardadas (una palabra suelta no borra las demás). */
    labels?: Partial<AgendaLabels>
    /** Palabras a quitar de lo guardado: vuelven a su valor por defecto. */
    labelsReset?: readonly AgendaLabelKey[]
    toggles?: Partial<AgendaToggles>
  },
): Promise<SettingsRecord> {
  const row: Record<string, unknown> = { account_id: accountId }
  if (patch.address !== undefined) row.address = patch.address
  if (patch.reminders2hEnabled !== undefined) {
    row.reminders_2h_enabled = patch.reminders2hEnabled
  }
  if (patch.botTexts !== undefined) row.bot_texts = patch.botTexts
  if (patch.labels !== undefined || patch.labelsReset?.length) {
    const reset = patch.labelsReset ?? []
    const covered = new Set<string>([...Object.keys(patch.labels ?? {}), ...reset])
    // Si el parche ya decide las seis palabras (el camino de la UI) no hay nada
    // que mezclar: no se lee, y lo reiniciado simplemente no se escribe.
    const stored: Partial<AgendaLabels> = LABEL_KEYS.every((key) => covered.has(key))
      ? {}
      : await storedLabels(db, accountId)
    for (const key of reset) delete stored[key]
    row.labels = { ...stored, ...patch.labels }
  }
  if (patch.toggles !== undefined) Object.assign(row, togglesToRow(patch.toggles))

  const { data } = await db
    .from('booking_settings')
    .upsert(row, { onConflict: 'account_id' })
    .select(SETTINGS_COLS)
    .maybeSingle()
  if (!data) throw new Error('No se pudo guardar la configuración.')

  const settings = data as SettingsRow
  const clean = sanitizeBotTexts(settings.bot_texts)
  return {
    address: settings.address,
    reminders2hEnabled: Boolean(settings.reminders_2h_enabled),
    botTexts: clean.ok ? clean.value : {},
    // Lectura tolerante: una fila vieja o dañada nunca debe tumbar un guardado ya hecho.
    labels: readLabels(settings.labels),
    toggles: togglesFromRow(settings),
    presetKey: settings.preset_key ?? null,
  }
}

/**
 * Palabras personalizadas hoy guardadas (solo las que el dueño cambió, sin
 * defaults), para mezclar con un cambio parcial. Se queda solo con lo que
 * pasa `sanitizeLabels` palabra por palabra (como `readLabels`), así que lo
 * viejo o dañado se limpia en el siguiente guardado de palabras.
 *
 * Si la lectura FALLA lanza: seguir con `{}` y escribir pisaría en silencio
 * las palabras del dueño. Una fila que no existe (sin error) sí es `{}`.
 *
 * Leer y escribir no es atómico: dos admins guardando a la vez la misma
 * palabra gana el último, que es lo esperado en una pantalla de ajustes.
 */
async function storedLabels(
  db: SupabaseClient,
  accountId: string,
): Promise<Partial<AgendaLabels>> {
  const { data, error } = await db
    .from('booking_settings')
    .select('labels')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error('No se pudieron leer las palabras guardadas.')
  const raw = (data as { labels?: unknown } | null)?.labels
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const kept: Partial<AgendaLabels> = {}
  for (const key of LABEL_KEYS) {
    const res = sanitizeLabels({ [key]: (raw as Record<string, unknown>)[key] })
    if (res.ok && res.value[key] !== undefined) kept[key] = res.value[key]
  }
  return kept
}

/** Cambia la moneda por defecto de la cuenta (accounts.default_currency). */
export async function updateAccountCurrency(
  db: SupabaseClient,
  accountId: string,
  currency: string,
): Promise<string> {
  const { data } = await db
    .from('accounts')
    .update({ default_currency: currency })
    .eq('id', accountId)
    .select('id, default_currency')
    .maybeSingle()
  if (!data) throw new Error('No se pudo guardar la moneda.')
  return (data as { default_currency: string }).default_currency
}

// ------------------------------------------------------------
// Preguntas extra (booking_questions, 051)
// ------------------------------------------------------------

const QUESTION_COLS = 'id, label, kind, required, options, position'

const QUESTION_GONE = 'Esa pregunta ya no existe.'

/** 22P02: Postgres rechazó el id por no ser un uuid. Para el cliente es una pregunta que no existe. */
const isInvalidUuid = (error: { code?: string } | null): boolean => error?.code === '22P02'

async function fetchActiveQuestionRows(
  db: SupabaseClient,
  accountId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from('booking_questions')
    .select(QUESTION_COLS)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return (data ?? []) as Record<string, unknown>[]
}

/**
 * Preguntas activas, en orden. Salta las filas que no son válidas (las lee
 * `readQuestion`, que nunca lanza) y nunca devuelve más de MAX_QUESTIONS aunque
 * un admin haya insertado más directo por PostgREST.
 */
export async function listQuestions(
  db: SupabaseClient,
  accountId: string,
): Promise<AgendaQuestion[]> {
  return questionsFromRows(await fetchActiveQuestionRows(db, accountId))
}

function questionsFromRows(rows: Record<string, unknown>[]): AgendaQuestion[] {
  const out: AgendaQuestion[] = []
  for (const row of rows) {
    const question = readQuestion(row)
    if (question) out.push(question)
    if (out.length >= MAX_QUESTIONS) break
  }
  return out
}

export async function createQuestion(
  db: SupabaseClient,
  accountId: string,
  input: QuestionInput,
): Promise<AgendaQuestion> {
  const rows = await fetchActiveQuestionRows(db, accountId)
  if (questionsFromRows(rows).length >= MAX_QUESTIONS) {
    throw new ConfigError('limit_reached', `Máximo ${MAX_QUESTIONS} preguntas extra.`)
  }
  // Al final del orden, aunque se hayan desactivado preguntas del medio.
  const position = rows.reduce((max, row) => Math.max(max, Number(row.position) || 0), -1) + 1

  const { data, error } = await db
    .from('booking_questions')
    .insert({
      id: randomUUID(),
      account_id: accountId,
      label: input.label,
      kind: input.kind,
      required: input.required,
      options: input.options,
      position,
    })
    .select(QUESTION_COLS)
    .maybeSingle()
  if (error) throw error
  const created = readQuestion(data)
  if (!created) throw new Error('No se pudo crear la pregunta.')
  return created
}

/** Reemplaza la definición (etiqueta, tipo, obligatoria, opciones). Solo preguntas activas de la cuenta. */
export async function updateQuestion(
  db: SupabaseClient,
  accountId: string,
  id: string,
  input: QuestionInput,
): Promise<AgendaQuestion> {
  const { data, error } = await db
    .from('booking_questions')
    .update({
      label: input.label,
      kind: input.kind,
      required: input.required,
      options: input.options,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .select(QUESTION_COLS)
    .maybeSingle()
  if (isInvalidUuid(error)) throw new ConfigError('not_found', QUESTION_GONE)
  if (error) throw error
  if (!data) throw new ConfigError('not_found', QUESTION_GONE)
  const updated = readQuestion(data)
  if (!updated) throw new Error('No se pudo actualizar la pregunta.')
  return updated
}

/** Se desactiva (no se borra): las citas guardan sus respuestas por id de pregunta. */
export async function deleteQuestion(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<void> {
  const { data, error } = await db
    .from('booking_questions')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .eq('is_active', true)
    .select('id')
    .maybeSingle()
  if (isInvalidUuid(error)) throw new ConfigError('not_found', QUESTION_GONE)
  if (error) throw error
  if (!data) throw new ConfigError('not_found', QUESTION_GONE)
}
