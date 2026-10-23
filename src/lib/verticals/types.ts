import type { SupabaseClient } from '@supabase/supabase-js'
import type { LucideIcon } from 'lucide-react'

/**
 * Claves de los módulos que una cuenta puede tener activos a la vez.
 *
 * Viven en `accounts.modules text[]` (migración 053). La cuenta puede
 * combinar varios (agenda + ventas…); `getAccountModules` en
 * `registry.ts` es el único lugar que decide cuáles tiene una cuenta.
 * Esta unión crece una entrada por módulo publicado.
 */
export type ModuleKey = 'agenda' | 'ventas'

/**
 * Alias de `ModuleKey` para el código anterior a los módulos
 * combinables (migración 047: `accounts.vertical_key`, un solo valor).
 */
export type VerticalKey = ModuleKey

/**
 * Valores de `accounts.vertical_key` que cuentan como la agenda. 'barberia'
 * es la clave anterior a la migración 051: se acepta mientras el código
 * nuevo convive con cuentas aún sin migrar.
 */
export const AGENDA_VERTICAL_KEYS = ['agenda', 'barberia'] as const

/**
 * Sidebar entry contributed by a vertical. `labelKey` resolves against
 * the `Sidebar` namespace of the i18n catalogues (messages/*.json).
 */
export interface VerticalNavItem {
  /** Dashboard route that renders the vertical UI. */
  href: string
  labelKey: string
  icon: LucideIcon
}

/**
 * Static, client-safe description of a vertical: identity + nav.
 * Runtime behaviour (inbound handling, installers) lives server-side —
 * see `dispatch.ts` — so this can be imported by client components.
 */
export interface VerticalManifest {
  key: ModuleKey
  /** Display name. Spanish is the product language for SHIFT deployments. */
  name: string
  /** One-liner shown on setup / settings surfaces. */
  description: string
  /**
   * Sidebar section. Optional: a vertical can be backend-only (an
   * automation pack, for example) and ship without its own nav entry.
   */
  nav?: VerticalNavItem
}

/** Row of `booking_sessions` as seen by the dispatcher. */
export interface VerticalSession {
  id: string
  /** Dialog state so far — free-form; the vertical controller owns it. */
  state: Record<string, unknown>
  /** ISO timestamp; the session is only active while this is in the future. */
  expiresAt: string
}

/**
 * Everything a vertical handler gets to process one inbound message.
 * Mirrors what the core pipelines (flows / AI auto-reply) receive.
 */
export interface VerticalInboundContext {
  accountId: string
  conversationId: string
  contactId: string
  /** Owner of the account's WhatsApp config (same convention as flows/AI). */
  configOwnerUserId: string
  /** Meta message id, when the transport provided one. */
  inboundMessageId?: string
  /** Service-role client. Handlers run server-side only. */
  db: SupabaseClient
  /** Active booking session, when one exists. */
  session: VerticalSession | null
  /**
   * A human owns the thread (`assigned_agent_id`) or the bot was paused
   * on it (`ai_autoreply_disabled`). The handler is still called so it
   * can answer taps on messages the SYSTEM sent (e.g. reminder buttons),
   * but it must decline everything else — and the dispatcher never
   * claims the message on its behalf.
   */
  humanOwned?: boolean
}

export interface VerticalDispatchResult {
  /** True when the vertical took ownership of this inbound message. */
  consumed: boolean
}

export type VerticalInboundHandler = (
  ctx: VerticalInboundContext,
) => Promise<VerticalDispatchResult>
