import { agendaInboundHandler } from '@/verticals/agenda/agent'

import { readAccountModules } from '@/lib/modules/read-account-modules'

import { supabaseAdmin } from './admin-client'
import { getAccountModules } from './registry'
import type {
  ModuleKey,
  VerticalDispatchResult,
  VerticalInboundHandler,
  VerticalSession,
} from './types'

/**
 * Server-side inbound handlers, one per installed vertical.
 *
 * Deliberately separate from the manifest registry (`./registry.ts`):
 * manifests are imported by client components, handlers pull in
 * service-role helpers and DB writers that must never reach the client
 * bundle. Phase 2 plugs the agenda booking controller in here.
 */
const VERTICAL_HANDLERS: Partial<Record<ModuleKey, VerticalInboundHandler>> =
  { agenda: agendaInboundHandler }

interface DispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  inboundMessageId?: string
}

/**
 * Vertical seam called from the WhatsApp webhook between the flow
 * runner and the automation pipeline: flows → vertical → automations →
 * AI. When this consumes an inbound message, the content-level
 * automation triggers are suppressed and the AI auto-reply never sees
 * it.
 *
 * When a human owns the conversation (`assigned_agent_id`) or
 * auto-replies were disabled for it (`ai_autoreply_disabled`, set on
 * handoff), the handler still runs with `humanOwned: true` — only so it
 * can answer taps on system messages (reminder buttons) — and nothing is
 * consumed unless the handler says so. Otherwise an active booking
 * session claims the message even between handler invocations.
 *
 * Owns its try/catch and never throws: the webhook must keep its 200
 * to Meta even when this lookup fails.
 */
export async function dispatchInboundToVertical(
  args: DispatchArgs,
): Promise<VerticalDispatchResult> {
  const notConsumed: VerticalDispatchResult = { consumed: false }
  try {
    const db = supabaseAdmin()

    // Accounts without a module that has a bot (none, or only Ventas)
    // early-exit on this single lookup.
    const { account } = await readAccountModules(db, args.accountId)
    const botModules = getAccountModules(account).filter(
      (key) => VERTICAL_HANDLERS[key],
    )
    if (botModules.length === 0) return notConsumed

    // Same stand-down gates as the AI auto-reply: a human owns this
    // thread, or auto-replies were turned off for it (handoff ran).
    const { data: conversation } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', args.conversationId)
      .maybeSingle()
    if (!conversation) return notConsumed
    const conv = conversation as {
      assigned_agent_id: string | null
      ai_autoreply_disabled: boolean | null
    }
    const humanOwned = Boolean(
      conv.assigned_agent_id || conv.ai_autoreply_disabled,
    )

    const { data: sessionRow } = await db
      .from('booking_sessions')
      .select('id, state, expires_at')
      .eq('account_id', args.accountId)
      .eq('contact_id', args.contactId)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    const session: VerticalSession | null = sessionRow
      ? {
          id: sessionRow.id as string,
          state: (sessionRow.state ?? {}) as Record<string, unknown>,
          expiresAt: sessionRow.expires_at as string,
        }
      : null

    // In Ventas A only the agenda has a bot, so this loop runs at most
    // once. How to split one message between two bots is decided later.
    for (const key of botModules) {
      const handler = VERTICAL_HANDLERS[key]
      if (!handler) continue
      const result = await handler({
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        configOwnerUserId: args.configOwnerUserId,
        inboundMessageId: args.inboundMessageId,
        db,
        session,
        humanOwned,
      })
      if (result.consumed) return { consumed: true }
    }

    // A human owns the thread: only what the handler explicitly took
    // is consumed; an open session does not claim the rest.
    if (humanOwned) return notConsumed

    // An active booking session means the vertical owns the thread even
    // between handler invocations — content automations stand down
    // until the session ends, cancels, or expires.
    return { consumed: session !== null }
  } catch (err) {
    console.error('[verticals] dispatchInboundToVertical failed:', err)
    return notConsumed
  }
}
