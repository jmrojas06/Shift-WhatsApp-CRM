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
}

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
const STAFF_NAME_TAKEN = 'Ya existe un barbero con ese nombre.'

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
    await db
      .from('booking_services')
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
  }
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
  if (!data) throw new Error('No se pudo crear el barbero.')
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
    throw new ConfigError('not_found', 'El barbero no existe.')
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
    throw new ConfigError('not_found', 'El barbero no existe.')
  }
  return mapStaff(data as StaffRow)
}

export async function reorderStaff(
  db: SupabaseClient,
  accountId: string,
  ids: string[],
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await db
      .from('booking_staff')
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
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
    throw new ConfigError('not_found', 'El barbero no existe.')
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
    await db.from('booking_staff_services').insert(
      toAdd.map((serviceId) => ({
        account_id: accountId,
        staff_id: staffId,
        service_id: serviceId,
      })),
    )
  }
  if (toRemove.length) {
    await db
      .from('booking_staff_services')
      .delete()
      .eq('account_id', accountId)
      .eq('staff_id', staffId)
      .in('service_id', toRemove)
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

  if (toRemoveIds.length) {
    await db
      .from('booking_working_hours')
      .delete()
      .eq('account_id', accountId)
      .in('id', toRemoveIds)
  }
  if (toAdd.length) {
    await db.from('booking_working_hours').insert(
      toAdd.map((block) => ({
        id: randomUUID(),
        account_id: accountId,
        staff_id: staffId,
        weekday: block.weekday,
        start_time: block.startTime,
        end_time: block.endTime,
      })),
    )
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
  },
): Promise<SettingsRecord> {
  const row: Record<string, unknown> = { account_id: accountId }
  if (patch.address !== undefined) row.address = patch.address
  if (patch.reminders2hEnabled !== undefined) {
    row.reminders_2h_enabled = patch.reminders2hEnabled
  }
  if (patch.botTexts !== undefined) row.bot_texts = patch.botTexts

  const { data } = await db
    .from('booking_settings')
    .upsert(row, { onConflict: 'account_id' })
    .select('account_id, address, reminders_2h_enabled, bot_texts')
    .maybeSingle()
  if (!data) throw new Error('No se pudo guardar la configuración.')

  const settings = data as SettingsRow
  const clean = sanitizeBotTexts(settings.bot_texts)
  return {
    address: settings.address,
    reminders2hEnabled: Boolean(settings.reminders_2h_enabled),
    botTexts: clean.ok ? clean.value : {},
  }
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
