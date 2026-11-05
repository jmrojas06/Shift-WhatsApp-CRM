// ============================================================
// Base falsa para las pruebas de las llamadas de voz (T13 y T14).
//
// Es el fake de PostgREST que ya usa la agenda (`makeFakeDb`) más lo que las
// llamadas necesitan y el fake no tiene:
//   - el índice único de `booking_calls` (cita + intento, solo del robot): un
//     segundo insert igual devuelve 23505, como la base;
//   - el índice único parcial de `provider_call_sid` (solo donde no es null, en
//     toda la tabla): un insert o un update que deje dos filas con el mismo
//     `CallSid` devuelve 23505. Un update condicional que no toca ninguna fila
//     (`.is('provider_call_sid', null)` sobre una fila ya atada) no choca, como en
//     Postgres;
//   - `select(col, { count: 'exact', head: true })`, que devuelve `count`;
//   - las columnas de `booking_calls` que no se mandan quedan en null, como en
//     Postgres (así `.is('outcome', null)` funciona con filas recién creadas).
//
// No importa `vitest`: se carga desde cualquier test.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { makeFakeDb, type FakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

interface Result {
  data: unknown
  error: unknown
  count?: number
}

interface Chain {
  select: (columns?: string, options?: { count?: string; head?: boolean }) => Chain
  insert: (payload: Row | Row[]) => Chain
  update: (payload: Row) => Chain
  eq: (column: string, value: unknown) => Chain
  is: (column: string, value: unknown) => Chain
  single: () => Promise<Result>
  maybeSingle: () => Promise<Result>
  then: (resolve: (value: Result) => unknown) => unknown
}

const CALL_DEFAULTS: Row = {
  appointment_id: null,
  contact_id: null,
  attempt: null,
  from_number: null,
  to_number: null,
  outcome: null,
  menu_path: null,
  digits: null,
  provider_call_sid: null,
  error: null,
  duration_seconds: null,
  created_by: null,
  finished_at: null,
}

/** ¿Choca con el índice único `idx_booking_calls_robot_attempt`? */
function clashesWithRobotAttempt(existing: Row[], row: Row): boolean {
  if (row.direction !== 'outbound' || row.channel !== 'robot') return false
  if (row.appointment_id == null || row.attempt == null) return false
  return existing.some(
    (other) =>
      other.direction === 'outbound' &&
      other.channel === 'robot' &&
      other.appointment_id === row.appointment_id &&
      other.attempt === row.attempt,
  )
}

const uniqueViolation = (index: string) => ({
  code: '23505',
  message: `duplicate key value violates unique constraint "${index}"`,
})

export function makeCallDb(seed: Record<string, Row[]> = {}): FakeDb {
  const db = makeFakeDb({ booking_calls: [], ...seed })
  const original = db.from.bind(db)

  db.from = (table: string) => {
    const chain = original(table) as Chain
    let countMode = false

    const select = chain.select
    chain.select = (columns, options) => {
      if (options?.count) countMode = true
      return select(columns)
    }

    const then = chain.then
    chain.then = (resolve) =>
      then((result) =>
        resolve(
          countMode
            ? { data: null, error: result.error, count: Array.isArray(result.data) ? result.data.length : 0 }
            : result,
        ),
      )

    if (table === 'booking_calls') {
      let pending: Row[] | null = null
      const insert = chain.insert
      chain.insert = (payload) => {
        pending = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ ...CALL_DEFAULTS, ...row }))
        return insert(pending.length === 1 ? pending[0] : pending)
      }

      // Un update que pone `provider_call_sid`: a qué fila apunta y si exige que esté vacío.
      let sidUpdate: { sid: string; nullOnly: boolean } | null = null
      let targetId: unknown = undefined
      const update = chain.update
      chain.update = (payload) => {
        if (typeof payload.provider_call_sid === 'string') sidUpdate = { sid: payload.provider_call_sid, nullOnly: false }
        return update(payload)
      }
      const eq = chain.eq
      chain.eq = (column, value) => {
        if (column === 'id') targetId = value
        return eq(column, value)
      }
      const is = chain.is
      chain.is = (column, value) => {
        if (column === 'provider_call_sid' && value === null && sidUpdate) sidUpdate.nullOnly = true
        return is(column, value)
      }

      // Los choques con los índices únicos se miran al EJECUTAR (al hacer await), no al armar
      // la consulta: dos corridas a la vez arman la suya antes de que cualquiera escriba.
      const violation = (): { code: string; message: string } | null => {
        const existing = db._tables.booking_calls ?? []
        if (pending?.some((row) => clashesWithRobotAttempt(existing, row))) {
          return uniqueViolation('idx_booking_calls_robot_attempt')
        }
        if (pending?.some((row) => row.provider_call_sid != null && existing.some((other) => other.provider_call_sid === row.provider_call_sid))) {
          return uniqueViolation('idx_booking_calls_provider_call_sid')
        }
        if (sidUpdate) {
          const target = existing.find((row) => row.id === targetId)
          const applies = target !== undefined && (!sidUpdate.nullOnly || target.provider_call_sid == null)
          if (applies && existing.some((other) => other.id !== targetId && other.provider_call_sid === sidUpdate!.sid)) {
            return uniqueViolation('idx_booking_calls_provider_call_sid')
          }
        }
        return null
      }

      const run = chain.then
      chain.then = (resolve) => {
        const error = violation()
        return error ? Promise.resolve(resolve({ data: null, error })) : run(resolve)
      }
      for (const method of ['single', 'maybeSingle'] as const) {
        const terminal = chain[method]
        chain[method] = async () => {
          const error = violation()
          return error ? { data: null, error } : terminal()
        }
      }
    }
    return chain as unknown as ReturnType<FakeDb['from']>
  }
  return db
}

export function asDb(db: FakeDb): SupabaseClient {
  return db as unknown as SupabaseClient
}

/** Una fila de `booking_calls` completa; lo que se pase pisa los valores base. */
export function callRowSeed(overrides: Row = {}): Row {
  return {
    id: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    account_id: 'acc-1',
    direction: 'outbound',
    channel: 'robot',
    status: 'calling',
    created_at: '2026-11-05T15:00:00.000Z',
    ...CALL_DEFAULTS,
    ...overrides,
  }
}
