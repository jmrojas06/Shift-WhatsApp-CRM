import type { SupabaseClient } from '@supabase/supabase-js'

import { encrypt } from '@/lib/whatsapp/encryption'

// ============================================================
// Lectura y escritura de la conexión con Google de una cuenta.
//
// La tabla `agenda_calendar_connections` tiene la RLS prendida sin
// políticas: solo el servidor (service role) la toca. Todo se acota
// con `account_id` de la sesión.
//
// El permiso permanente (`refresh_token_encrypted`) NUNCA sale de aquí
// hacia el navegador: lo que se manda a la pantalla pasa por
// `toSafeSettings`, que arma el objeto campo por campo.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000
/** Citas que se copian: desde hace 1 día hasta 180 días adelante (diseño §5). */
const WINDOW_PAST_MS = DAY_MS
const WINDOW_FUTURE_MS = 180 * DAY_MS
/** Estados de cita que se reflejan en Google (las canceladas no tienen evento nuevo). */
const SYNCED_STATUSES = ['pending', 'confirmed', 'completed', 'no_show']

export const DEFAULT_CALENDAR_ID = 'primary'
export const MAX_CALENDAR_ID_LENGTH = 300

export type ConnectionStatus = 'active' | 'error' | 'revoked'

export interface ConnectionRow {
  account_id: string
  google_email: string | null
  refresh_token_encrypted: string
  default_calendar_id: string
  status: ConnectionStatus
  last_error: string | null
  last_sync_at: string | null
}

const COLUMNS =
  'account_id, google_email, refresh_token_encrypted, default_calendar_id, status, last_error, last_sync_at'

export async function readConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<ConnectionRow | null> {
  const { data, error } = await db
    .from('agenda_calendar_connections')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer la conexión de Google: ${error.message}`)
  return (data as ConnectionRow | null) ?? null
}

/** Lo único de la conexión que el navegador puede ver. */
export interface SafeSettings {
  /** El servidor tiene las variables de Google (si no, el botón no sirve). */
  configured: boolean
  /** Hay una conexión que no fue revocada. */
  connected: boolean
  google_email: string | null
  status: ConnectionStatus | null
  last_error: string | null
  last_sync_at: string | null
  default_calendar_id: string | null
}

export function toSafeSettings(row: ConnectionRow | null, configured: boolean): SafeSettings {
  if (!row) {
    return {
      configured,
      connected: false,
      google_email: null,
      status: null,
      last_error: null,
      last_sync_at: null,
      default_calendar_id: null,
    }
  }
  return {
    configured,
    connected: row.status !== 'revoked',
    google_email: row.google_email ?? null,
    status: row.status,
    last_error: row.last_error ?? null,
    last_sync_at: row.last_sync_at ?? null,
    default_calendar_id: row.default_calendar_id ?? null,
  }
}

/**
 * Guarda (o reemplaza) la conexión de la cuenta, activa y sin errores.
 *
 * Con la misma cuenta de Google se conserva el calendario general elegido.
 * Con otra, vuelve a `primary` y se sueltan los calendarios por profesional
 * (eran de la cuenta anterior y ya no existen).
 */
export async function saveConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string; email: string | null; refreshToken: string },
): Promise<void> {
  const existing = await readConnection(db, args.accountId)
  const sameGoogleAccount =
    existing !== null &&
    existing.google_email !== null &&
    args.email !== null &&
    existing.google_email.toLowerCase() === args.email.toLowerCase()

  const { error } = await db.from('agenda_calendar_connections').upsert(
    {
      account_id: args.accountId,
      provider: 'google',
      google_email: args.email,
      refresh_token_encrypted: encrypt(args.refreshToken),
      default_calendar_id: sameGoogleAccount ? existing.default_calendar_id : DEFAULT_CALENDAR_ID,
      status: 'active',
      last_error: null,
      connected_by: args.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id' },
  )
  if (error) throw new Error(`No se pudo guardar la conexión de Google: ${error.message}`)

  if (existing && !sameGoogleAccount) await clearStaffCalendars(db, args.accountId)
}

/** Los calendarios por profesional dejan de valer al cambiar o quitar la cuenta de Google. */
export async function clearStaffCalendars(db: SupabaseClient, accountId: string): Promise<void> {
  const { error } = await db
    .from('booking_staff')
    .update({ google_calendar_id: null })
    .eq('account_id', accountId)
  if (error) throw new Error(`No se pudieron soltar los calendarios del equipo: ${error.message}`)
}

/**
 * Marca para copiar las citas de la ventana (hace 1 día a 180 días adelante),
 * menos las canceladas. Solo toca `google_dirty`: el trigger de la 056 no
 * mueve `updated_at` en ese caso, así que nadie pierde su edición.
 */
export async function markAppointmentsDirty(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from('booking_appointments')
    .update({ google_dirty: true })
    .eq('account_id', accountId)
    .in('status', SYNCED_STATUSES)
    .gte('starts_at', new Date(now.getTime() - WINDOW_PAST_MS).toISOString())
    .lte('starts_at', new Date(now.getTime() + WINDOW_FUTURE_MS).toISOString())
  if (error) throw new Error(`No se pudieron marcar las citas para Google: ${error.message}`)
}
