// ============================================================
// Fake de Supabase para los tests de configuración (Fase 4).
//
// Un mini-PostgREST en memoria: aplica filtros como lo haría el
// servidor y soporta lo que el repositorio necesita de verdad —
// insert (fila o lote), update/delete con `.select()` devolviendo
// las filas afectadas, y upsert por clave de conflicto (con los
// defaults de `booking_settings` de la migración 048/049).
//
// NO es un fake genérico: si un test necesita una operación nueva,
// se agrega aquí a propósito (los tests que lo usan cubren el
// comportamiento, no la librería).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, unknown>

export type WriteOp = 'insert' | 'update' | 'delete' | 'upsert'

/**
 * Operaciones que `_failNext` puede hacer fallar: las escrituras, la
 * lectura (`select`) y la llamada a una función (`rpc`, donde "table" es
 * el nombre de la función).
 */
export type FailableOp = WriteOp | 'select' | 'rpc'

/** Resultado de una función RPC simulada (como PostgREST). */
export interface RpcResult {
  data: unknown
  error: { message: string; code?: string } | null
}

export type RpcHandler = (args: Record<string, unknown>) => RpcResult | Promise<RpcResult>

export interface FakeDb {
  _tables: Record<string, Row[]>
  /**
   * La próxima operación `op` sobre `table` devuelve este error (como
   * PostgREST) y no toca nada. Sirve para probar que una escritura
   * fallida nunca se reporta como guardada y que una lectura fallida
   * no se confunde con "no hay fila". `select` aplica solo a lecturas
   * (`from().select()` sin escribir): el `.select()` encadenado a un
   * insert/upsert cuenta como esa escritura. Si el fallo no se consume,
   * esa operación no ocurrió.
   *
   * `op = 'rpc'` hace fallar la próxima llamada a la función `table`
   * (su nombre), sin ejecutar el manejador.
   */
  _failNext(op: FailableOp, table: string, error: { message: string; code?: string }): void
  /**
   * Registra cómo responde `db.rpc(name, args)`. El fake no ejecuta SQL:
   * cada test que llama una función (p. ej. `create_order`) escribe aquí
   * el comportamiento mínimo que necesita (insertar en `_tables`,
   * devolver una fila o un error con código de Postgres). Sin manejador,
   * la llamada responde PGRST202 ("función no encontrada").
   */
  _onRpc(name: string, handler: RpcHandler): void
  /** Cada llamada a `rpc`, en orden (nombre y argumentos tal cual). */
  _rpcCalls: { name: string; args: Record<string, unknown> }[]
  rpc(name: string, args?: Record<string, unknown>): Promise<RpcResult>
  from(table: string): unknown
}

type FilterKind = 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'is'

/**
 * Defaults de columna que Postgres aplicaría al insertar. Se replican
 * solo para las tablas donde los tests los pueden observar.
 */
const TABLE_DEFAULTS: Record<string, Row> = {
  booking_settings: {
    address: null,
    bot_texts: {},
    reminders_2h_enabled: false,
    labels: {},
    preset_key: null,
    choose_staff: true,
    show_price: true,
    show_duration: true,
    reminders_enabled: true,
    allow_reschedule: true,
  },
  booking_questions: {
    required: true,
    options: [],
    position: 0,
    is_active: true,
  },
  booking_services: {
    description: null,
    is_active: true,
    position: 0,
  },
  booking_staff: {
    bio: null,
    is_active: true,
    position: 0,
  },
  // Migración 054: los avisos nacen prendidos.
  sales_settings: {
    notify_paid: true,
    notify_shipped: true,
    notify_delivered: true,
  },
}

export function makeFakeDb(seed: Record<string, Row[]>): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }
  const ensure = (name: string): Row[] => (tables[name] ??= [])
  const failures: {
    op: FailableOp
    table: string
    error: { message: string; code?: string }
  }[] = []

  function from(table: string) {
    const filters: { col: string; kind: FilterKind; value: unknown }[] = []
    const orders: { col: string; ascending: boolean }[] = []
    type Op = 'select' | 'insert' | 'update' | 'delete' | 'upsert'
    let op: Op = 'select'
    let payload: Row | Row[] | null = null
    let conflictKey: string | null = null
    let limitN: number | null = null
    let wantRows = false

    const matches = (row: Row): boolean =>
      filters.every(({ col, kind, value }) => {
        const v = row[col]
        switch (kind) {
          case 'eq':
            return v === value
          case 'in':
            return (value as unknown[]).includes(v)
          case 'lt':
            return String(v) < String(value)
          case 'lte':
            return String(v) <= String(value)
          case 'gt':
            return String(v) > String(value)
          case 'gte':
            return String(v) >= String(value)
          case 'is':
            return v === value
        }
      })

    const candidateRows = (): Row[] => {
      const out = ensure(table).filter(matches)
      if (orders.length) {
        // Como PostgREST: el primer `.order()` manda y los siguientes desempatan.
        out.sort((a, b) => {
          for (const { col, ascending } of orders) {
            const av = a[col] as never
            const bv = b[col] as never
            if (av === bv) continue
            return (av < bv ? -1 : 1) * (ascending ? 1 : -1)
          }
          return 0
        })
      }
      return limitN === null ? out : out.slice(0, limitN)
    }

    const insertRow = (row: Row): Row => {
      const defaults = TABLE_DEFAULTS[table] ?? {}
      const merged: Row = { ...defaults, ...row }
      ensure(table).push(merged)
      return { ...merged }
    }

    const run = (): { data: unknown; error: unknown } => {
      const failIdx = failures.findIndex((f) => f.op === op && f.table === table)
      if (failIdx >= 0) {
        return { data: null, error: failures.splice(failIdx, 1)[0].error }
      }
      if (op === 'select') {
        return { data: candidateRows().map((r) => ({ ...r })), error: null }
      }
      if (op === 'insert') {
        const rows = (Array.isArray(payload) ? payload : [payload ?? {}]).map(
          (row) => insertRow(row as Row),
        )
        return { data: wantRows ? rows : null, error: null }
      }
      if (op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload ?? {}]
        const out = rows.map((row) => {
          const incoming = row as Row
          const key = conflictKey
          const existing = key
            ? ensure(table).find((r) => r[key] === incoming[key])
            : undefined
          if (existing) {
            Object.assign(existing, incoming)
            return { ...existing }
          }
          return insertRow(incoming)
        })
        return { data: wantRows ? out : null, error: null }
      }
      if (op === 'delete') {
        const doomed = candidateRows()
        for (const row of doomed) {
          const index = ensure(table).indexOf(row)
          if (index >= 0) ensure(table).splice(index, 1)
        }
        return { data: wantRows ? doomed.map((r) => ({ ...r })) : null, error: null }
      }
      // update
      const updated = candidateRows()
      for (const row of updated) Object.assign(row, payload as Row)
      return {
        data: wantRows ? updated.map((r) => ({ ...r })) : null,
        error: null,
      }
    }

    const api = {
      select: () => {
        wantRows = true
        return api
      },
      insert: (p: Row | Row[]) => {
        op = 'insert'
        payload = p
        return api
      },
      upsert: (p: Row | Row[], options?: { onConflict?: string }) => {
        op = 'upsert'
        payload = p
        conflictKey = options?.onConflict ?? null
        return api
      },
      update: (p: Row) => {
        op = 'update'
        payload = p
        return api
      },
      delete: () => {
        op = 'delete'
        return api
      },
      eq: (col: string, value: unknown) => {
        filters.push({ col, kind: 'eq', value })
        return api
      },
      in: (col: string, value: unknown[]) => {
        filters.push({ col, kind: 'in', value })
        return api
      },
      gt: (col: string, value: unknown) => {
        filters.push({ col, kind: 'gt', value })
        return api
      },
      gte: (col: string, value: unknown) => {
        filters.push({ col, kind: 'gte', value })
        return api
      },
      lt: (col: string, value: unknown) => {
        filters.push({ col, kind: 'lt', value })
        return api
      },
      lte: (col: string, value: unknown) => {
        filters.push({ col, kind: 'lte', value })
        return api
      },
      is: (col: string, value: unknown) => {
        filters.push({ col, kind: 'is', value })
        return api
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        orders.push({ col, ascending: o?.ascending ?? true })
        return api
      },
      limit: (n: number) => {
        limitN = n
        return api
      },
      maybeSingle: async () => {
        const result = run()
        if (result.error) return { data: null, error: result.error }
        const rows = (result.data ?? []) as Row[]
        return { data: rows[0] ?? null, error: null }
      },
      single: async () => {
        const result = run()
        if (result.error) return { data: null, error: result.error }
        const rows = (result.data ?? []) as Row[]
        return { data: rows[0] ?? null, error: null }
      },
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(resolve(run())),
    }
    return api
  }

  const rpcHandlers = new Map<string, RpcHandler>()
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []

  return {
    _tables: tables,
    _failNext(op, table, error) {
      failures.push({ op, table, error })
    },
    _onRpc(name, handler) {
      rpcHandlers.set(name, handler)
    },
    _rpcCalls: rpcCalls,
    async rpc(name, args = {}) {
      rpcCalls.push({ name, args })
      const failIdx = failures.findIndex((f) => f.op === 'rpc' && f.table === name)
      if (failIdx >= 0) {
        return { data: null, error: failures.splice(failIdx, 1)[0].error }
      }
      const handler = rpcHandlers.get(name)
      if (!handler) {
        return {
          data: null,
          error: { code: 'PGRST202', message: `function ${name} not found` },
        }
      }
      return handler(args)
    },
    from,
  }
}

/** El fake habla el subconjunto de PostgREST que usa el repo. */
export function asClient(db: FakeDb): SupabaseClient {
  return db as unknown as SupabaseClient
}
