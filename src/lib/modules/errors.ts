import { getVerticalManifest } from '@/lib/verticals/registry'
import type { ModuleKey } from '@/lib/verticals/types'

/** "El módulo Ventas no está activo para esta cuenta." */
export function moduleNotActiveMessage(key: ModuleKey): string {
  const name = getVerticalManifest(key)?.name ?? key
  return `El módulo ${name} no está activo para esta cuenta.`
}

/**
 * La cuenta no tiene el módulo que la ruta exige. Vive aparte de
 * `require-module.ts` para que `toErrorResponse` (src/lib/auth/account)
 * lo reconozca sin dependencia circular: una ruta que olvide
 * `toModuleErrorResponse` igual responde 409.
 */
export class ModuleNotActiveError extends Error {
  readonly status = 409 as const
  readonly moduleKey: ModuleKey
  constructor(moduleKey: ModuleKey) {
    super(moduleNotActiveMessage(moduleKey))
    this.name = 'ModuleNotActiveError'
    this.moduleKey = moduleKey
  }
}
