import type { SupabaseClient } from '@supabase/supabase-js'

import type { AccountModulesSource } from '@/lib/verticals/registry'

/** Postgres `undefined_column`: la migración de esa columna aún no corre. */
const UNDEFINED_COLUMN = '42703'

export interface AccountModulesRead {
  account: AccountModulesSource | null
  /** Error de lectura (distinto de "columna ausente", que se absorbe). */
  error: { code?: string; message?: string } | null
}

/**
 * Lee de `accounts` lo que `getAccountModules` necesita (`modules` y
 * `vertical_key`) con el cliente recibido.
 *
 * Tolera una base sin la migración 053: si `modules` no existe todavía
 * (42703), repite la lectura solo con `vertical_key` — el código nuevo
 * puede desplegarse antes que la migración sin romper la agenda.
 */
export async function readAccountModules(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountModulesRead> {
  const first = await db
    .from('accounts')
    .select('modules, vertical_key')
    .eq('id', accountId)
    .maybeSingle()
  if (first.error?.code !== UNDEFINED_COLUMN) {
    return {
      account: (first.data as AccountModulesSource | null) ?? null,
      error: first.error ?? null,
    }
  }

  const fallback = await db
    .from('accounts')
    .select('vertical_key')
    .eq('id', accountId)
    .maybeSingle()
  return {
    account: (fallback.data as AccountModulesSource | null) ?? null,
    error: fallback.error ?? null,
  }
}
