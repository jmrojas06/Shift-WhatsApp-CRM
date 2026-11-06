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

import { readAccountModules } from '@/lib/modules/read-account-modules'
import { hasModule } from '@/lib/verticals/registry'

import { latestConsent } from './consent'

export interface ClinicAiGate {
  /** ¿Se puede mandar este chat a la IA? */
  allowed: boolean
  /** ¿La cuenta es una clínica? Entonces la IA lleva el bloque fijo de seguridad. */
  clinic: boolean
}

/**
 * ¿Se puede mandar este chat a la IA, y es una clínica? Quien manda un chat a la
 * IA necesita las dos cosas (la autorización de datos y el bloque fijo de
 * seguridad del prompt) y las dos salen de la misma lectura. Una cuenta sin el
 * módulo clínica puede, sin mirar autorizaciones. Si la cuenta o la autorización
 * no se pueden leer, no se manda y se trata como clínica.
 */
export async function clinicAiGate(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<ClinicAiGate> {
  const { account, error } = await readAccountModules(db, args.accountId)
  if (error) {
    console.error('[clinica] no se pudo leer la cuenta para decidir si usa la IA:', error.message)
    return { allowed: false, clinic: true }
  }
  // Una conversación siempre tiene cuenta: sin fila no hay a quién preguntarle.
  if (!account) return { allowed: false, clinic: true }
  if (!hasModule(account, 'clinica')) return { allowed: true, clinic: false }

  const consent = await latestConsent(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    kind: 'datos_sensibles',
  })
  return { allowed: consent?.granted === true, clinic: true }
}
