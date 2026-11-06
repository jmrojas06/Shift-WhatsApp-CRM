// ============================================================
// Autorizaciones de datos. Registro de solo agregar: la decisión vigente
// es la más reciente de cada tipo, y nada se edita ni se borra (la base lo
// hace cumplir con un trigger). Cada fila guarda quién autorizó (contact_ref)
// y el texto exacto que vio (text_snapshot), porque el contacto puede
// borrarse y el texto de la clínica puede cambiar.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type ConsentKind = 'datos_sensibles' | 'mercadeo'

/** Decisión vigente; null si nunca respondió o no se pudo leer. */
export async function latestConsent(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; kind: ConsentKind },
): Promise<{ granted: boolean } | null> {
  const { data, error } = await db
    .from('clinic_consents')
    .select('granted, created_at')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('kind', args.kind)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) {
    console.error('[clinica] no se pudo leer la autorización:', error.message)
    return null
  }
  const row = ((data ?? []) as { granted: boolean }[])[0]
  return row ? { granted: row.granted } : null
}

/**
 * Teléfono del contacto, o su identificador de WhatsApp si no tiene teléfono
 * (un contacto que solo escribe con nombre de usuario guarda `phone` vacío).
 * Es lo que queda en la autorización si el contacto se borra después, y la
 * base no admite una vacía: sin a nombre de quién guardar, no hay registro.
 */
async function contactRef(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string> {
  const { data, error } = await db
    .from('contacts')
    .select('phone, wa_user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(`No se pudo leer el contacto: ${error.message}`)
  const row = data as { phone: string | null; wa_user_id: string | null } | null
  const ref = row?.phone?.trim() || row?.wa_user_id?.trim() || ''
  if (!ref) throw new Error('El contacto no tiene teléfono ni identificador de WhatsApp')
  return ref
}

/** Lanza si no se pudo guardar: sin registro no hay autorización. */
export async function recordConsent(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    kind: ConsentKind
    granted: boolean
    textVersion: number
    /** El texto exacto que vio la persona al responder. */
    textSnapshot: string
    source: 'whatsapp' | 'recepcion'
    messageId?: string | null
    createdAtIso: string
  },
): Promise<void> {
  const { error } = await db.from('clinic_consents').insert({
    id: crypto.randomUUID(),
    account_id: args.accountId,
    contact_id: args.contactId,
    contact_ref: await contactRef(db, args.accountId, args.contactId),
    kind: args.kind,
    granted: args.granted,
    text_version: args.textVersion,
    text_snapshot: args.textSnapshot,
    source: args.source,
    message_id: args.messageId ?? null,
    created_at: args.createdAtIso,
  })
  if (error) throw new Error(`No se pudo guardar la autorización: ${error.message}`)
}
