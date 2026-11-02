// ============================================================
// ¿Se puede mandar este chat a la IA?
//
// En una clínica la conversación puede traer datos de salud. Hasta que la
// persona los autoriza, ningún texto suyo sale hacia el proveedor de IA:
// ni la respuesta automática ni "Sugerir con IA".
//
// Falla cerrado: si no se puede leer la cuenta o la autorización, la
// respuesta es no. Se mira aquí, en el punto donde la IA lee el chat, y no
// solo en el despachador de verticales: el despachador deja pasar el
// mensaje cuando no logra leer los módulos, y entonces el bot ni se entera.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAiConfig } from '@/lib/ai/config'
import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'

import { latestConsent } from './consent'

export async function canUseAi(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<boolean> {
  const { account, error } = await readAccountModules(db, args.accountId)
  if (error) {
    console.error('[clinica] no se pudo leer la cuenta para decidir si usa la IA:', error.message)
    return false
  }
  // Una conversación siempre tiene cuenta: sin fila no hay a quién preguntarle.
  if (!account) return false
  if (!hasModule(account, 'clinica')) return true

  const consent = await latestConsent(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    kind: 'datos_sensibles',
  })
  return consent?.granted === true
}

/**
 * ¿La cuenta tiene la respuesta automática con IA prendida? Es la misma
 * condición con la que `auto-reply.ts` decide si contesta. El bot la mira antes
 * de decirle a un paciente que escriba su duda: si nadie la va a contestar,
 * mejor que lo atienda una persona. Una configuración que no se puede leer
 * (llave que no descifra, base caída) cuenta como apagada.
 */
export async function autoReplyEnabled(db: SupabaseClient, accountId: string): Promise<boolean> {
  try {
    const config = await loadAiConfig(db, accountId)
    return config?.autoReplyEnabled === true
  } catch (err) {
    console.error('[clinica] no se pudo leer la configuración de la IA:', err)
    return false
  }
}
