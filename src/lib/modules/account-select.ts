import type { SupabaseClient } from '@supabase/supabase-js'

import { isUndefinedColumnError } from './undefined-column'

/**
 * Listas de columnas de `accounts` de la más nueva a la más vieja. Un
 * despliegue que va por delante de su migración (053 agrega `modules`,
 * 047 `vertical_key`) repite con la siguiente lista más corta, así que
 * la franja de cuenta sigue funcionando hasta aplicar la migración.
 */
export const ACCOUNT_SELECTS = [
  'id, name, default_currency, vertical_key, modules',
  'id, name, default_currency, vertical_key',
  'id, name, default_currency',
] as const

export interface AccountSelectResult {
  /** Fila tal cual la devolvió la base; el que llama la tipa. */
  data: unknown
  error: {
    code?: string
    message: string
    details?: string
    hint?: string
  } | null
}

/**
 * Lee la cuenta con un punto de lectura por id (sin joins incrustados:
 * ver el comentario de `use-auth`), bajando de lista de columnas solo
 * cuando la base responde "columna ausente".
 */
export async function selectAccountWithFallback(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountSelectResult> {
  let result: AccountSelectResult = { data: null, error: null }
  for (const columns of ACCOUNT_SELECTS) {
    result = (await db
      .from('accounts')
      .select(columns)
      .eq('id', accountId)
      .maybeSingle()) as unknown as AccountSelectResult
    if (!isUndefinedColumnError(result.error)) return result
  }
  return result
}
