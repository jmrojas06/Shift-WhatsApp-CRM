// ============================================================
// Base falsa para las pruebas de las llamadas de voz (T13 y T14).
//
// Es el fake de PostgREST que ya usa la agenda (`makeFakeDb`) más lo que las
// llamadas necesitan y el fake no tiene:
//   - el índice único de `booking_calls` (cita + intento, solo del robot): un
//     segundo insert igual devuelve 23505, como la base;
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
      const insert = chain.insert
      let pending: Row[] | null = null
      chain.insert = (payload) => {
        pending = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ ...CALL_DEFAULTS, ...row }))
        return insert(pending.length === 1 ? pending[0] : pending)
      }

      // El choque con el índice único se mira al EJECUTAR el insert (al hacer await),
      // no al armarlo: dos corridas a la vez arman el suyo antes de que cualquiera escriba.
      const run = chain.then
      chain.then = (resolve) => {
        if (pending?.some((row) => clashesWithRobotAttempt(db._tables.booking_calls ?? [], row))) {
          return Promise.resolve(
            resolve({
              data: null,
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "idx_booking_calls_robot_attempt"',
              },
            }),
          )
        }
        return run(resolve)
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
