import { NextResponse } from 'next/server'

import { toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { getVerticalManifest, hasModule } from '@/lib/verticals/registry'
import type { ModuleKey } from '@/lib/verticals/types'

import { readAccountModules } from './read-account-modules'

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

/** "El módulo Ventas no está activo para esta cuenta." */
export function moduleNotActiveMessage(key: ModuleKey): string {
  const name = getVerticalManifest(key)?.name ?? key
  return `El módulo ${name} no está activo para esta cuenta.`
}

export class ModuleNotActiveError extends Error {
  readonly status = 409 as const
  readonly moduleKey: ModuleKey
  constructor(moduleKey: ModuleKey) {
    super(moduleNotActiveMessage(moduleKey))
    this.name = 'ModuleNotActiveError'
    this.moduleKey = moduleKey
  }
}

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
 * mensaje en español. Todo lo demás se delega.
 */
export function toModuleErrorResponse(err: unknown): NextResponse {
  if (err instanceof ModuleNotActiveError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  return toErrorResponse(err)
}
