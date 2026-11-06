// ============================================================
// ¿A este contacto se le debe recordar la cita?
//
// En una clínica, un recordatorio sale a nombre de un paciente, y no puede salir
// a quien pidió que no le escriban:
//   - la baja de envíos (la etiqueta `OPT_OUT_TAG`: quien escribe "baja" o "stop"), o
//   - su última autorización de datos es un no (la rechazó o la revocó).
// Sin ninguna fila de autorización sí se envía: las citas de antes del módulo no
// la tienen. En las demás cuentas no se usa: la baja solo cubría las difusiones.
//
// Cualquier lectura que falle LANZA: no saber no es "puede recibirlo", y quien
// llama deja la señal sin reclamar para reintentarla en la próxima corrida.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { OPT_OUT_TAG } from '@/lib/contacts/opt-out'

export type ReminderBlock = 'opt_out' | 'consent_revoked'

export async function clinicReminderBlock(
  db: SupabaseClient,
  args: { accountId: string; contactId: string },
): Promise<ReminderBlock | null> {
  const { data: tag, error: tagError } = await db
    .from('tags')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('name', OPT_OUT_TAG)
    .maybeSingle()
  if (tagError) throw new Error(`No se pudo leer la etiqueta de baja: ${tagError.message}`)
  const tagId = (tag as { id?: string } | null)?.id
  if (tagId) {
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('contact_id', args.contactId)
      .eq('tag_id', tagId)
      .limit(1)
    if (error) throw new Error(`No se pudo leer la baja del contacto: ${error.message}`)
    if (((data ?? []) as unknown[]).length > 0) return 'opt_out'
  }

  const { data: consents, error: consentError } = await db
    .from('clinic_consents')
    .select('granted')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('kind', 'datos_sensibles')
    .order('created_at', { ascending: false })
    .limit(1)
  if (consentError) throw new Error(`No se pudo leer la autorización: ${consentError.message}`)
  const latest = ((consents ?? []) as { granted: boolean }[])[0]
  return latest && latest.granted === false ? 'consent_revoked' : null
}
