// ============================================================
// ¿La IA va a contestar este chat? Los filtros de la respuesta automática,
// en un solo lugar.
//
// `auto-reply.ts` los aplica uno por uno, en su orden, para decidir si contesta.
// El bot de la clínica los mira antes de soltarle un mensaje a la IA: si la IA no
// va a contestar (apagada, una automatización que contesta ya, o el tope de
// respuestas de la conversación), soltarlo es dejar al paciente sin respuesta, y
// el hilo tiene que pasar a una persona. Con una sola definición, los dos no se
// separan.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAiConfig } from './config'
import type { AiConfig } from './types'

/**
 * Las automatizaciones por mensaje (`new_message_received` / `keyword_match`) se
 * disparan solas con este mismo mensaje y pueden responder por su cuenta: con una
 * activa, la IA se aparta para no escribirle dos veces al cliente. (Los
 * disparadores de relación, como `first_inbound_message`, no cuentan.)
 */
export async function hasActiveAutoResponder(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('automations')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .in('trigger_type', ['new_message_received', 'keyword_match'])
    .limit(1)
  return ((data ?? []) as unknown[]).length > 0
}

/** ¿La conversación ya llegó al tope de respuestas automáticas? */
export function replyCapReached(
  conversation: { ai_reply_count?: number | null },
  config: Pick<AiConfig, 'autoReplyMaxPerConversation'>,
): boolean {
  return (conversation.ai_reply_count ?? 0) >= config.autoReplyMaxPerConversation
}

/**
 * ¿La respuesta automática va a contestar en esta conversación? La IA prendida, sin
 * una automatización que conteste primero y sin el tope de respuestas alcanzado.
 * Cualquier cosa que no se pueda leer (una llave que no descifra, la base caída) es
 * un no: ante la duda, que lo atienda una persona.
 */
export async function aiWillAnswer(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string },
): Promise<boolean> {
  try {
    const config = await loadAiConfig(db, args.accountId)
    if (!config?.autoReplyEnabled) return false
    if (await hasActiveAutoResponder(db, args.accountId)) return false
    const { data: conversation, error } = await db
      .from('conversations')
      .select('ai_reply_count')
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (error || !conversation) return false
    return !replyCapReached(conversation as { ai_reply_count?: number | null }, config)
  } catch (err) {
    console.error('[ai] no se pudo saber si la respuesta automática contesta:', err)
    return false
  }
}
