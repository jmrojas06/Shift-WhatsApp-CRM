import { supabaseAdmin } from './admin-client'
import { getVerticalManifest } from './registry'
import type {
  VerticalDispatchResult,
  VerticalInboundHandler,
  VerticalKey,
  VerticalSession,
} from './types'

/**
 * Server-side inbound handlers, one per installed vertical.
 *
 * Deliberately separate from the manifest registry (`./registry.ts`):
 * manifests are imported by client components, handlers pull in
 * service-role helpers and DB writers that must never reach the client
 * bundle. Phase 2 plugs the barbería booking controller in here.
 */
const VERTICAL_HANDLERS: Partial<Record<VerticalKey, VerticalInboundHandler>> =
  {}

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
 * Stands down, exactly like the AI auto-reply core, when a human owns
 * the conversation (`assigned_agent_id`) or auto-replies were disabled
 * for it (`ai_autoreply_disabled`, set on handoff). An active booking
 * session claims the message even before its handler lands — sessions
 * are only created by the Phase 2 controller, so that branch is inert
 * until then.
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

    // Accounts without a vertical early-exit on this single lookup.
    const { data: account } = await db
      .from('accounts')
      .select('vertical_key')
      .eq('id', args.accountId)
      .maybeSingle()
    const manifest = getVerticalManifest(
      (account as { vertical_key?: string | null } | null)?.vertical_key,
    )
    if (!manifest) return notConsumed

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
    if (conv.assigned_agent_id) return notConsumed
    if (conv.ai_autoreply_disabled) return notConsumed

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

    const handler = VERTICAL_HANDLERS[manifest.key]
    if (handler) {
      const result = await handler({
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        configOwnerUserId: args.configOwnerUserId,
        inboundMessageId: args.inboundMessageId,
        db,
        session,
      })
      if (result.consumed) return { consumed: true }
    }

    // An active booking session means the vertical owns the thread even
    // between handler invocations — content automations stand down
    // until the session ends, cancels, or expires.
    return { consumed: session !== null }
  } catch (err) {
    console.error('[verticals] dispatchInboundToVertical failed:', err)
    return notConsumed
  }
}
