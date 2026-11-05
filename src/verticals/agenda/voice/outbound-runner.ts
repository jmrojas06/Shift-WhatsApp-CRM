// ============================================================
// Llamadas salientes de confirmación (diseño §6.2): el runner del cron.
//
// Cada pasada (cada 10 minutos) llama SOLO si se cumple todo esto:
//   - las salientes están prendidas en la cuenta, la cuenta tiene el módulo
//     agenda y las credenciales de voz están puestas;
//   - ahora es de lunes a sábado (sábado solo si `call_saturday`), nunca
//     domingo ni festivo de Colombia, y dentro de `window_start`–`window_end`
//     (hora de Bogotá);
//   - la cita está activa, es futura y sin `attendance_confirmed_at`;
//   - el recordatorio de 24 h salió hace al menos `call_after_minutes` y
//     faltan más de `min_lead_minutes` para la cita;
//   - la cita tiene menos de `max_attempts` intentos del robot y pasaron
//     `retry_minutes` desde la última llamada (del robot o a mano);
//   - ninguna llamada anterior quedó en manos de una persona (pidió hablar con
//     alguien, hubo asesor, número equivocado…);
//   - la cuenta está por debajo de `monthly_limit` llamadas salientes del mes;
//   - el contacto tiene teléfono, no tiene la etiqueta de baja ni `no-llamar` y,
//     en una clínica, no revocó la autorización.
//
// Dos corridas no llaman dos veces: el intento se RECLAMA insertando la fila
// `queued` (índice único cita + intento, 23505 = otra corrida ganó) ANTES de
// pedirle la llamada a Telnyx. Si Telnyx la rechaza, la fila queda `failed` y la
// cita sigue en "Para llamar".
//
// El runner recibe el proveedor inyectado: las pruebas nunca tocan la red. Ni el
// teléfono ni el nombre del paciente van al resumen ni a los logs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { OPT_OUT_TAG } from '@/lib/contacts/opt-out'
import { isColombianHoliday } from '@/lib/voice/co-holidays'
import { isWithinCallWindow } from '@/lib/voice/hours'
import type { VoiceProvider } from '@/lib/voice/telnyx'
import { voiceUrl } from '@/lib/voice/tokens'
import { hasModule, type AccountModulesSource } from '@/lib/verticals/registry'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { clinicReminderBlock } from '@/modules/clinica/reminder-skip'

import { startOfZonedDay, zonedParts } from '../agent/time'
import {
  ACTIVE_APPOINTMENT_STATUSES,
  IN_FLIGHT_STATUSES,
  truncateError,
  type CallOutcome,
  type CallStatus,
} from './calls-repo'
import { OUTBOUND_WEBHOOK_PATH, STATUS_WEBHOOK_PATH } from './paths'
import { CALL_SETTINGS_COLUMNS, callSettingsFromRow, type CallSettings } from './settings'

/** Etiqueta de contacto: no se le llama (aunque sí se le escribe). */
export const NO_CALL_TAG = 'no-llamar'

/** Tope de intentos por cita que impone la base (CHECK de `attempt`). */
export const HARD_MAX_ATTEMPTS = 3

/** Llamadas que pide una pasada. El cron corre cada 10 minutos. */
const DEFAULT_LIMIT = 20
/** Citas que se leen por página (las más cercanas primero). */
export const CANDIDATE_PAGE_SIZE = 100
/**
 * Páginas que se recorren como mucho por cuenta en cada pasada (1.000 citas). Las
 * citas que se saltan (ya atendidas, sin teléfono, de baja, esperando el reintento…)
 * no deben tapar a las que sí toca llamar, así que se pasa de página hasta llegar al
 * límite de llamadas o hasta que no queden; este tope solo evita que una cuenta
 * enorme alargue la pasada sin fin.
 */
export const MAX_CANDIDATE_PAGES = 10
/** Un intento "en curso" más viejo que esto se da por terminado (se perdió la señal final). */
const STALE_IN_FLIGHT_MS = 15 * 60_000

/** Resultados que dejan la cita en manos de una persona: el robot no vuelve a llamar. */
const HANDLED_OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>([
  'human',
  'advisor_connected',
  'advisor_missed',
  'wrong_number',
  'confirmed',
  'cancelled',
])

// ------------------------------------------------------------
// Regla pura: ¿toca otro intento?
// ------------------------------------------------------------

export interface CallHistoryItem {
  direction: 'outbound' | 'inbound'
  channel: 'robot' | 'manual'
  attempt: number | null
  status: CallStatus
  outcome: CallOutcome | null
  createdAt: string
}

export type AttemptSkip = 'handled' | 'attempts' | 'retry_wait' | 'in_flight'

const isRobotCall = (item: CallHistoryItem): boolean => item.direction === 'outbound' && item.channel === 'robot'

/** El número del próximo intento del robot: el mayor que hay +1. */
export function nextRobotAttempt(history: readonly CallHistoryItem[]): number {
  return history.filter(isRobotCall).reduce((max, item) => Math.max(max, item.attempt ?? 0), 0) + 1
}

/** ¿Hay una llamada del robot que todavía puede estar sonando o en curso? */
export function hasInFlightRobotCall(history: readonly CallHistoryItem[], now: Date): boolean {
  return history.some(
    (item) =>
      isRobotCall(item) &&
      IN_FLIGHT_STATUSES.includes(item.status) &&
      now.getTime() - new Date(item.createdAt).getTime() < STALE_IN_FLIGHT_MS,
  )
}

/**
 * ¿Toca otro intento del robot a esta cita? Una llamada anterior que quedó en
 * manos de una persona, o el tope de intentos, lo impide; también una llamada
 * en curso o una más reciente que `retry_minutes` (del robot o a mano).
 */
export function decideAttempt(
  history: readonly CallHistoryItem[],
  settings: Pick<CallSettings, 'maxAttempts' | 'retryMinutes'>,
  now: Date,
): { ok: true; attempt: number } | { ok: false; reason: AttemptSkip } {
  if (history.some((item) => item.outcome !== null && HANDLED_OUTCOMES.has(item.outcome))) {
    return { ok: false, reason: 'handled' }
  }
  const attempt = nextRobotAttempt(history)
  if (attempt > settings.maxAttempts) return { ok: false, reason: 'attempts' }
  if (hasInFlightRobotCall(history, now)) return { ok: false, reason: 'in_flight' }

  const outbound = history.filter((item) => item.direction === 'outbound')
  const lastMs = outbound.reduce((latest, item) => Math.max(latest, new Date(item.createdAt).getTime()), 0)
  if (lastMs > 0 && now.getTime() - lastMs < settings.retryMinutes * 60_000) {
    return { ok: false, reason: 'retry_wait' }
  }
  return { ok: true, attempt }
}

// ------------------------------------------------------------
// Contacto: ¿se le puede llamar?
// ------------------------------------------------------------

export type CallBlock = 'opt_out' | 'no_call' | 'consent_revoked'

/**
 * ¿Algo impide llamarle a este contacto? La baja de envíos y `no-llamar` valen
 * para todas las cuentas; en una clínica además cuenta la autorización
 * revocada. Cualquier lectura que falle LANZA: no saber no es "puede".
 */
export async function contactCallBlock(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; clinic: boolean },
): Promise<CallBlock | null> {
  // Una clínica ya revisa la baja de envíos junto con la autorización.
  const names = args.clinic ? [NO_CALL_TAG] : [OPT_OUT_TAG, NO_CALL_TAG]
  const { data: tags, error: tagError } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', args.accountId)
    .in('name', names)
  if (tagError) throw new Error(`No se pudieron leer las etiquetas: ${tagError.message}`)

  const byId = new Map(((tags ?? []) as { id: string; name: string }[]).map((tag) => [tag.id, tag.name]))
  if (byId.size > 0) {
    const { data, error } = await db
      .from('contact_tags')
      .select('tag_id')
      .eq('contact_id', args.contactId)
      .in('tag_id', [...byId.keys()])
    if (error) throw new Error(`No se pudieron leer las etiquetas del contacto: ${error.message}`)
    const applied = new Set(((data ?? []) as { tag_id: string }[]).map((row) => byId.get(row.tag_id)))
    if (applied.has(NO_CALL_TAG)) return 'no_call'
    if (applied.has(OPT_OUT_TAG)) return 'opt_out'
  }

  if (args.clinic) return clinicReminderBlock(db, { accountId: args.accountId, contactId: args.contactId })
  return null
}

/** El teléfono del contacto en E.164 ("+573001112233"), o null si no sirve para llamar. */
export async function loadCallablePhone(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<string | null> {
  const { data, error } = await db
    .from('contacts')
    .select('phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer el contacto: ${error.message}`)
  const digits = sanitizePhoneForMeta(String((data as { phone?: string | null } | null)?.phone ?? ''))
  return isValidE164(digits) ? `+${digits}` : null
}

// ------------------------------------------------------------
// Reclamar el intento y pedir la llamada
// ------------------------------------------------------------

export interface StartOutboundCallArgs {
  /** Service role. */
  db: SupabaseClient
  provider: VoiceProvider
  accountId: string
  /** E.164. */
  from: string
  /** E.164. */
  to: string
  /** null en la llamada de prueba. */
  appointmentId: string | null
  contactId: string | null
  /** null en la llamada de prueba; de 1 a 3 en las demás. */
  attempt: number | null
  /** El usuario que la pidió; null en el cron. */
  createdBy: string | null
  now: Date
}

export type StartOutboundCallResult =
  | { kind: 'started'; callId: string }
  /** Otra corrida reclamó el mismo intento (23505): no se llama. */
  | { kind: 'claimed_by_other' }
  | { kind: 'rejected'; callId: string; error: string }

/**
 * Inserta la fila `queued` (esa es la reclamación) y pide la llamada. El id de
 * la fila viaja en las URL: Telnyx no devuelve el de su llamada. Lanza si la
 * base rechaza el insert por otra razón o si faltan variables para firmar URL.
 */
export async function startOutboundCall(args: StartOutboundCallArgs): Promise<StartOutboundCallResult> {
  const { db, provider } = args
  const callId = crypto.randomUUID()
  const url = voiceUrl(OUTBOUND_WEBHOOK_PATH, { call: callId, step: 'menu', loop: 1 })
  const statusCallback = voiceUrl(STATUS_WEBHOOK_PATH, { call: callId })

  const { error } = await db.from('booking_calls').insert({
    id: callId,
    account_id: args.accountId,
    direction: 'outbound',
    channel: 'robot',
    appointment_id: args.appointmentId,
    contact_id: args.contactId,
    attempt: args.attempt,
    from_number: args.from,
    to_number: args.to,
    status: 'queued',
    created_by: args.createdBy,
    // La hora de la pasada y no la de la base: las esperas entre intentos se miden con la misma.
    created_at: args.now.toISOString(),
  })
  if (error) {
    if ((error as { code?: string }).code === '23505') return { kind: 'claimed_by_other' }
    throw new Error(`No se pudo reservar la llamada: ${error.message}`)
  }

  let result: Awaited<ReturnType<VoiceProvider['startCall']>>
  try {
    result = await provider.startCall({ to: args.to, from: args.from, url, statusCallback })
  } catch {
    result = { ok: false, error: 'No se pudo contactar al proveedor de llamadas' }
  }

  if (result.ok) {
    // Solo sube la fila si el webhook no la movió ya a "en curso".
    const { error: updateError } = await db
      .from('booking_calls')
      .update({ status: 'calling' })
      .eq('id', callId)
      .eq('status', 'queued')
    if (updateError) console.error('[voice outbound] no se pudo marcar la llamada como en curso')
    return { kind: 'started', callId }
  }

  const message = truncateError(result.error)
  const { error: failError } = await db
    .from('booking_calls')
    .update({ status: 'failed', error: message, finished_at: args.now.toISOString() })
    .eq('id', callId)
  if (failError) console.error('[voice outbound] no se pudo marcar la llamada como fallida')
  return { kind: 'rejected', callId, error: message }
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

export type SkipReason =
  | AttemptSkip
  | 'no_phone'
  | 'opted_out'
  | 'no_call'
  | 'consent_revoked'
  | 'monthly_limit'
  | 'no_caller_id'

export interface OutboundRunSummary {
  /** Cuentas con las salientes prendidas y el módulo agenda. */
  accounts: number
  /** De esas, las que están dentro de su ventana de llamadas ahora. */
  inWindow: number
  /** Citas revisadas. */
  considered: number
  /** Llamadas que Telnyx aceptó. */
  called: number
  /** Llamadas que Telnyx rechazó, y lecturas que fallaron. */
  failed: number
  /** Intentos que ganó otra corrida a la vez. */
  claimedByOther: number
  skipped: Record<SkipReason, number>
  /** Hoy no se llama a nadie: domingo o festivo. */
  closedDay?: 'sunday' | 'holiday'
  /** Variables de entorno que faltan; con alguna, el runner no hace nada. */
  credentialsMissing: string[]
  errors: string[]
}

export interface RunOutboundCallsArgs {
  /** Service role. */
  db: SupabaseClient
  /** null = faltan credenciales: no se hace nada y se dice en el resumen. */
  provider: VoiceProvider | null
  /** Qué variables faltan (de `readTelnyxConfig`), para el resumen. */
  missingCredentials?: string[]
  now?: Date
  /** Llamadas por pasada. */
  limit?: number
}

const SKIP_REASONS: SkipReason[] = [
  'handled',
  'attempts',
  'retry_wait',
  'in_flight',
  'no_phone',
  'opted_out',
  'no_call',
  'consent_revoked',
  'monthly_limit',
  'no_caller_id',
]

function emptySummary(): OutboundRunSummary {
  return {
    accounts: 0,
    inWindow: 0,
    considered: 0,
    called: 0,
    failed: 0,
    claimedByOther: 0,
    skipped: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>,
    credentialsMissing: [],
    errors: [],
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : 'error desconocido')

interface AccountRow extends AccountModulesSource {
  id: string
}

interface CandidateRow {
  id: string
  contact_id: string
  starts_at: string
}

/** Dónde quedó la página anterior: la última cita leída (hora y id, para desempatar). */
interface CandidateCursor {
  startsAt: string
  id: string
}

/** Llamadas salientes del robot de este mes (hora de Bogotá), sin las que Telnyx rechazó. */
export async function countMonthlyCalls(db: SupabaseClient, accountId: string, now: Date): Promise<number> {
  const monthStart = startOfZonedDay(`${zonedParts(now).dateKey.slice(0, 8)}01`)
  const { count, error } = await db
    .from('booking_calls')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('direction', 'outbound')
    .eq('channel', 'robot')
    .neq('status', 'failed')
    .gte('created_at', monthStart.toISOString())
  if (error) throw new Error(`No se pudieron contar las llamadas del mes: ${error.message}`)
  return count ?? 0
}

/**
 * Una página de citas candidatas, de la más cercana a la más lejana. El recorrido es
 * por llaves `(starts_at, id)`, no por posición: la página siguiente empieza justo
 * después de la última cita leída, aunque varias citas empiecen a la misma hora.
 */
async function loadCandidates(
  db: SupabaseClient,
  accountId: string,
  settings: CallSettings,
  now: Date,
  after: CandidateCursor | null,
): Promise<CandidateRow[]> {
  const reminderCutoff = new Date(now.getTime() - settings.callAfterMinutes * 60_000).toISOString()
  const leadCutoff = new Date(now.getTime() + settings.minLeadMinutes * 60_000).toISOString()
  let query = db
    .from('booking_appointments')
    .select('id, contact_id, starts_at, reminder_sent_at')
    .eq('account_id', accountId)
    .in('status', [...ACTIVE_APPOINTMENT_STATUSES])
    .is('attendance_confirmed_at', null)
    // Un recordatorio sin salir (null) no cumple esta condición: no se llama.
    .lte('reminder_sent_at', reminderCutoff)
    .gt('starts_at', leadCutoff)
  // Los valores salen de las filas que acabamos de leer (hora y uuid de la base), no de quien llama.
  if (after) {
    query = query.or(`starts_at.gt.${after.startsAt},and(starts_at.eq.${after.startsAt},id.gt.${after.id})`)
  }
  const { data, error } = await query
    .order('starts_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(CANDIDATE_PAGE_SIZE)
  if (error) throw new Error(`No se pudieron leer las citas: ${error.message}`)
  return (data ?? []) as CandidateRow[]
}

export async function loadHistory(
  db: SupabaseClient,
  accountId: string,
  appointmentIds: string[],
): Promise<Map<string, CallHistoryItem[]>> {
  const { data, error } = await db
    .from('booking_calls')
    .select('appointment_id, direction, channel, attempt, status, outcome, created_at')
    .eq('account_id', accountId)
    .in('appointment_id', appointmentIds)
  if (error) throw new Error(`No se pudieron leer las llamadas anteriores: ${error.message}`)
  const byAppointment = new Map<string, CallHistoryItem[]>()
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = String(row.appointment_id)
    const item: CallHistoryItem = {
      direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
      channel: row.channel === 'manual' ? 'manual' : 'robot',
      attempt: typeof row.attempt === 'number' ? row.attempt : null,
      status: row.status as CallStatus,
      outcome: (row.outcome as CallOutcome | null) ?? null,
      createdAt: String(row.created_at),
    }
    byAppointment.set(id, [...(byAppointment.get(id) ?? []), item])
  }
  return byAppointment
}

const BLOCK_TO_SKIP: Record<CallBlock, SkipReason> = {
  opt_out: 'opted_out',
  no_call: 'no_call',
  consent_revoked: 'consent_revoked',
}

/**
 * Una pasada del runner. Un fallo de lectura que impide saber a quién llamar
 * LANZA (la ruta responde 500 y avisa); lo que falla en una cita o una cuenta
 * se anota en el resumen y se sigue con las demás.
 */
export async function runOutboundCalls(args: RunOutboundCallsArgs): Promise<OutboundRunSummary> {
  const { db, provider } = args
  const now = args.now ?? new Date()
  const limit = args.limit ?? DEFAULT_LIMIT
  const summary = emptySummary()

  if (!provider) {
    summary.credentialsMissing = args.missingCredentials?.length ? args.missingCredentials : ['TELNYX_*']
    return summary
  }

  // Domingo y festivo cierran a todas las cuentas: ni se lee la base.
  const today = zonedParts(now)
  if (today.weekday === 0) return { ...summary, closedDay: 'sunday' }
  if (isColombianHoliday(today.dateKey)) return { ...summary, closedDay: 'holiday' }

  // Tipado como `string` para que el cliente no intente leer las columnas como tipos.
  const settingsColumns: string = `account_id, ${CALL_SETTINGS_COLUMNS}`
  const { data: settingsRows, error: settingsError } = await db
    .from('booking_call_settings')
    .select(settingsColumns)
    .eq('outbound_enabled', true)
  if (settingsError) {
    throw new Error(`No se pudo leer la configuración de llamadas: ${settingsError.message}`)
  }
  const settingsByAccount = new Map<string, CallSettings>()
  for (const row of (settingsRows ?? []) as unknown as Record<string, unknown>[]) {
    settingsByAccount.set(String(row.account_id), callSettingsFromRow(row))
  }
  if (settingsByAccount.size === 0) return summary

  const { data: accountRows, error: accountsError } = await db
    .from('accounts')
    .select('id, modules, vertical_key')
    .in('id', [...settingsByAccount.keys()])
  if (accountsError) throw new Error(`No se pudieron leer las cuentas: ${accountsError.message}`)
  const accounts = ((accountRows ?? []) as AccountRow[]).filter((row) => hasModule(row, 'agenda'))
  summary.accounts = accounts.length

  let started = 0
  for (const account of accounts) {
    if (started >= limit) break
    const settings = settingsByAccount.get(account.id)
    if (!settings || !isWithinCallWindow(settings, now)) continue
    summary.inWindow++

    try {
      started = await runAccount({
        db,
        provider,
        account,
        settings,
        now,
        summary,
        started,
        limit,
        clinic: hasModule(account, 'clinica'),
      })
    } catch (err) {
      summary.failed++
      summary.errors.push(`cuenta ${account.id}: ${errorText(err)}`)
    }
  }
  return summary
}

interface RunAccountArgs {
  db: SupabaseClient
  provider: VoiceProvider
  account: AccountRow
  settings: CallSettings
  now: Date
  summary: OutboundRunSummary
  /** Llamadas pedidas hasta ahora en la pasada. */
  started: number
  limit: number
  clinic: boolean
}

/** Devuelve cuántas llamadas se han pedido en total en la pasada. */
async function runAccount(args: RunAccountArgs): Promise<number> {
  const { db, provider, account, settings, now, summary, limit, clinic } = args
  let started = args.started

  const from = settings.callerId ?? settings.inboundNumber
  if (!from) {
    summary.skipped.no_caller_id++
    return started
  }

  // El tope del mes se lee UNA vez por pasada y se va sumando aquí. No es atómico: otra pasada o
  // un "llamar ahora" de la recepción a la vez pueden dejar pasar unas pocas llamadas de más. Se
  // acepta ese pequeño exceso (el tope protege el gasto, no es un límite legal) en vez de bloquear
  // la tabla de llamadas en cada intento.
  let used = await countMonthlyCalls(db, account.id, now)
  if (used >= settings.monthlyLimit) {
    summary.skipped.monthly_limit++
    return started
  }

  // Se pasa de página hasta llegar al límite de llamadas o hasta que no queden candidatas, con un
  // tope de páginas: lo que se salta (atendidas, sin teléfono, de baja…) no tapa a las siguientes.
  let cursor: CandidateCursor | null = null
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
    if (started >= limit) return started

    const candidates = await loadCandidates(db, account.id, settings, now, cursor)
    summary.considered += candidates.length
    if (candidates.length === 0) return started
    const history = await loadHistory(db, account.id, candidates.map((candidate) => candidate.id))

    for (const candidate of candidates) {
      if (started >= limit) return started
      if (used >= settings.monthlyLimit) {
        // Una sola vez por cuenta: se sale de la cuenta, no solo de esta cita.
        summary.skipped.monthly_limit++
        return started
      }

      const decision = decideAttempt(history.get(candidate.id) ?? [], settings, now)
      if (!decision.ok) {
        summary.skipped[decision.reason]++
        continue
      }

      let to: string | null
      try {
        to = await loadCallablePhone(db, { accountId: account.id, contactId: candidate.contact_id })
        if (!to) {
          summary.skipped.no_phone++
          continue
        }
        const block = await contactCallBlock(db, { accountId: account.id, contactId: candidate.contact_id, clinic })
        if (block) {
          summary.skipped[BLOCK_TO_SKIP[block]]++
          continue
        }

        const result = await startOutboundCall({
          db,
          provider,
          accountId: account.id,
          from,
          to,
          appointmentId: candidate.id,
          contactId: candidate.contact_id,
          attempt: decision.attempt,
          createdBy: null,
          now,
        })
        if (result.kind === 'claimed_by_other') {
          summary.claimedByOther++
          continue
        }
        started++
        if (result.kind === 'started') {
          summary.called++
          used++
        } else {
          summary.failed++
          summary.errors.push(`cita ${candidate.id}: ${result.error}`)
        }
      } catch (err) {
        summary.failed++
        summary.errors.push(`cita ${candidate.id}: ${errorText(err)}`)
      }
    }

    // Una página corta es la última.
    if (candidates.length < CANDIDATE_PAGE_SIZE) return started
    const last = candidates[candidates.length - 1]
    cursor = { startsAt: last.starts_at, id: last.id }
  }
  return started
}
