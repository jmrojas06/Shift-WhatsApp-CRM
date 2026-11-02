// ============================================================
// Configuración de la clínica (clinic_settings + clinic_locations).
//
// Los llamadores le pasan el cliente: el bot usa el service role y el
// instalador también.
//
// `loadClinicContext` distingue "falta la configuración" de "no se pudo
// leer": quien la llama decide qué hace en cada caso, y ante un error NO
// puede tratar la conversación como una agenda normal (se saltaría la
// autorización de datos y la IA vería el chat de un paciente).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  DEFAULT_CONSENT_TEXT,
  DEFAULT_LOCATION_NAME,
  DEFAULT_URGENCY_ALARM_TEXT,
  DEFAULT_URGENCY_WORDS,
} from './texts'

export interface ClinicLocation {
  id: string
  name: string
  address: string | null
  latitude: number | null
  longitude: number | null
  onCallPhone: string | null
}

export interface ClinicContext {
  consentText: string
  consentVersion: number
  urgencyWords: string[]
  urgencyAlarmText: string
  urgencyServiceId: string | null
  offerDays: number
  /** La sede de la clínica. Con la Agenda de Shift hay una sola. */
  location: ClinicLocation | null
}

/**
 * Resultado de leer la configuración de la clínica.
 *   - ok: lista para usar.
 *   - missing: la cuenta tiene el módulo pero nadie la configuró.
 *   - error: la lectura falló o la fila no es usable. NO equivale a "no hay
 *     clínica": hay que fallar cerrado.
 */
export type ClinicContextResult =
  | { status: 'ok'; clinic: ClinicContext }
  | { status: 'missing' }
  | { status: 'error' }

function mapLocation(row: Record<string, unknown>): ClinicLocation {
  return {
    id: row.id as string,
    name: row.name as string,
    address: (row.address as string | null) ?? null,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    onCallPhone: (row.on_call_phone as string | null) ?? null,
  }
}

export async function loadClinicContext(
  db: SupabaseClient,
  accountId: string,
): Promise<ClinicContextResult> {
  const { data, error } = await db
    .from('clinic_settings')
    .select(
      'consent_text, consent_version, urgency_words, urgency_alarm_text, urgency_service_id, offer_days',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[clinica] no se pudo leer la configuración:', error.message)
    return { status: 'error' }
  }
  if (!data) {
    console.error(`[clinica] la cuenta ${accountId} tiene el módulo sin configurar`)
    return { status: 'missing' }
  }

  // La base lo exige, pero una autorización o unos signos de alarma vacíos
  // nunca se le muestran a un paciente.
  const row = data as Record<string, unknown>
  if (!isFilled(row.consent_text) || !isFilled(row.urgency_alarm_text)) {
    console.error(`[clinica] la configuración de la cuenta ${accountId} no tiene los textos`)
    return { status: 'error' }
  }

  const { data: locations, error: locationError } = await db
    .from('clinic_locations')
    .select('id, name, address, latitude, longitude, on_call_phone')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
  if (locationError) console.error('[clinica] no se pudo leer la sede:', locationError.message)
  const location = ((locations ?? []) as Record<string, unknown>[])[0]

  return {
    status: 'ok',
    clinic: {
      consentText: row.consent_text as string,
      consentVersion: Number(row.consent_version),
      urgencyWords: Array.isArray(row.urgency_words) ? (row.urgency_words as string[]) : [],
      urgencyAlarmText: row.urgency_alarm_text as string,
      urgencyServiceId: (row.urgency_service_id as string | null) ?? null,
      offerDays: Number(row.offer_days) || 30,
      location: location ? mapLocation(location) : null,
    },
  }
}

const isFilled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

/** Instrucciones previas de un servicio; null si no tiene o el catálogo cambió. */
export async function loadServicePrep(
  db: SupabaseClient,
  accountId: string,
  serviceId: string,
): Promise<string | null> {
  const { data } = await db
    .from('booking_services')
    .select('prep_instructions')
    .eq('id', serviceId)
    .eq('account_id', accountId)
    .maybeSingle()
  return ((data as Record<string, unknown> | null)?.prep_instructions as string | null) ?? null
}

/**
 * Deja la configuración mínima de una clínica. Idempotente: crea lo que
 * falta y nunca pisa lo que Shift ya ajustó.
 */
export async function ensureClinicSetup(db: SupabaseClient, accountId: string): Promise<void> {
  const { data: settings, error: settingsError } = await db
    .from('clinic_settings')
    .select('account_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (settingsError) throw settingsError

  if (!settings) {
    const { data: services, error: servicesError } = await db
      .from('booking_services')
      .select('id, name')
      .eq('account_id', accountId)
    if (servicesError) throw servicesError
    const urgency = ((services ?? []) as { id: string; name: string }[]).find(
      (s) => s.name.trim().toLowerCase() === 'urgencia',
    )
    // upsert + ignoreDuplicates (ON CONFLICT DO NOTHING): si otro montaje
    // creó la fila entre la lectura y la escritura, esa gana y no se pisa.
    const { error } = await db.from('clinic_settings').upsert(
      {
        account_id: accountId,
        consent_text: DEFAULT_CONSENT_TEXT,
        consent_version: 1,
        urgency_words: [...DEFAULT_URGENCY_WORDS],
        urgency_alarm_text: DEFAULT_URGENCY_ALARM_TEXT,
        urgency_service_id: urgency?.id ?? null,
        offer_days: 30,
      },
      { onConflict: 'account_id', ignoreDuplicates: true },
    )
    if (error) throw error
  }

  const { data: locations, error: locationsError } = await db
    .from('clinic_locations')
    .select('id')
    .eq('account_id', accountId)
  if (locationsError) throw locationsError
  if (((locations ?? []) as unknown[]).length === 0) {
    const { error } = await db.from('clinic_locations').insert({
      id: crypto.randomUUID(),
      account_id: accountId,
      name: DEFAULT_LOCATION_NAME,
      is_active: true,
    })
    if (error) throw error
  }
}
