import { NextResponse } from 'next/server'

import { toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { hasModule } from '@/lib/verticals/registry'
import type { ModuleKey } from '@/lib/verticals/types'

import { ModuleNotActiveError, moduleNotActiveMessage } from './errors'
import { readAccountModules } from './read-account-modules'

// El error y el mensaje viven en ./errors (para que toErrorResponse los
// reconozca sin ciclo); se reexportan aquí porque es lo que importan las rutas.
export { ModuleNotActiveError, moduleNotActiveMessage }

// ============================================================
// Guarda server-side: la cuenta del que llama tiene un módulo activo.
//
// Uso en una ruta:
//
//   try {
//     const ctx = await requireRole('agent')
//     await requireModule(ctx, 'ventas')
//     ...
//   } catch (err) {
//     return toModuleErrorResponse(err)   // 409 si el módulo no está
//   }
//
// Lee con el cliente del usuario (RLS), así que solo ve su cuenta.
// Falla cerrado: si la cuenta no se puede leer, el módulo cuenta como
// no activo (nunca se actúa a ciegas).
// ============================================================

export async function requireModule(
  ctx: Pick<AccountContext, 'supabase' | 'accountId'>,
  key: ModuleKey,
): Promise<void> {
  const { account, error } = await readAccountModules(
    ctx.supabase,
    ctx.accountId,
  )
  if (error) {
    console.error('[requireModule] no se pudieron leer los módulos:', error)
    throw new ModuleNotActiveError(key)
  }
  if (!hasModule(account, key)) throw new ModuleNotActiveError(key)
}

/**
 * Como `toErrorResponse`, pero un módulo inactivo responde 409 con su
 * mensaje en español. Todo lo demás se delega. (`toErrorResponse` ya
 * reconoce este error; esta función lo deja explícito en la ruta.)
 */
export function toModuleErrorResponse(err: unknown): NextResponse {
  if (err instanceof ModuleNotActiveError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  return toErrorResponse(err)
}
