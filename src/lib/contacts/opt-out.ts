import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchContactsByIds, fetchTaggedContactIds } from '@/lib/broadcast-audience'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

/**
 * Baja de mensajes masivos. Meta exige respetar a quien pide no recibir
 * promociones; si no, el número pierde calidad y puede quedar limitado.
 *
 * Quien escribe una palabra de baja queda con la etiqueta `OPT_OUT_TAG`
 * y los envíos masivos lo saltan. Solo aplica a difusiones: la bandeja,
 * los recordatorios de citas y los avisos de pedidos siguen funcionando.
 * Para volver a incluirlo, se le quita la etiqueta desde Contactos.
 */
export const OPT_OUT_TAG = 'baja-envios'

const OPT_OUT_PHRASES = new Set([
  'baja',
  'darme de baja',
  'dar de baja',
  'stop',
  'parar',
  'detener',
  'no mas mensajes',
  'no quiero mas mensajes',
  'unsubscribe',
  'sair',
])

/** ¿El mensaje completo es un pedido de baja? (no basta con que lo contenga). */
export function isOptOutMessage(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return OPT_OUT_PHRASES.has(normalized)
}

/** Etiqueta al contacto como dado de baja (idempotente). */
export async function markContactOptedOut(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; userId: string },
): Promise<void> {
  const { data: tag, error: findErr } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', OPT_OUT_TAG)
    .maybeSingle()
  if (findErr) throw new Error(findErr.message)
  let tagId = (tag as { id?: string } | null)?.id
  if (!tagId) {
    tagId = crypto.randomUUID()
    const { error } = await db.from('tags').insert({
      id: tagId,
      account_id: args.accountId,
      user_id: args.userId,
      name: OPT_OUT_TAG,
    })
    if (error) throw new Error(error.message)
  }
  const { error } = await db
    .from('contact_tags')
    .upsert(
      { contact_id: args.contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )
  if (error) throw new Error(error.message)
}

/** Teléfonos (solo dígitos) de los contactos dados de baja en la cuenta. */
export async function fetchOptedOutPhones(
  db: SupabaseClient,
  accountId: string,
): Promise<Set<string>> {
  const { data: tag, error } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', OPT_OUT_TAG)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const tagId = (tag as { id?: string } | null)?.id
  if (!tagId) return new Set()

  const ids = await fetchTaggedContactIds(db, [tagId])
  const contacts = await fetchContactsByIds(db, [...ids])
  return new Set(contacts.map((c) => normalizePhone(c.phone ?? '')).filter(Boolean))
}

/** ¿Este teléfono está dado de baja? Compara solo dígitos. */
export function isOptedOutPhone(optedOut: ReadonlySet<string>, phone: string): boolean {
  return optedOut.has(normalizePhone(phone))
}
