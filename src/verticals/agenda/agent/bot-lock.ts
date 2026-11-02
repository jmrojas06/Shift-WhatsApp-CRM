// ============================================================
// Candado por conversación (docs/agenda-notas.md §3).
//
// Si un cliente manda dos mensajes seguidos, el webhook los procesa en
// paralelo y el segundo puede leer el paso antes de que el primero lo
// guarde. El candado es un UPDATE condicional sobre `conversations`
// (`bot_lock_until`, migración 055): la fila siempre existe, también en el
// primer mensaje. Vence solo, por si un proceso muere con el candado puesto.
//
// Solo lo usan las cuentas con el módulo clínica.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { VerticalDispatchResult } from '@/lib/verticals/types'

const LOCK_TTL_MS = 30_000
const DEFAULT_WAIT_MS = 5_000
const POLL_MS = 250

interface LockArgs {
  accountId: string
  conversationId: string
}

/**
 * Toma el candado. Devuelve con qué valor quedó (la hora en que vence), que es
 * lo que identifica a su dueño al soltarlo, o `null` si lo tiene otro. Lanza si
 * la base falla: un error no es "candado ocupado" (esperar y descartar el
 * mensaje lo escondería).
 */
export async function acquireBotLock(
  db: SupabaseClient,
  args: LockArgs & { now: Date },
): Promise<string | null> {
  const nowIso = args.now.toISOString()
  const untilIso = new Date(args.now.getTime() + LOCK_TTL_MS).toISOString()
  const claim = () =>
    db
      .from('conversations')
      .update({ bot_lock_until: untilIso })
      .eq('id', args.conversationId)
      .eq('account_id', args.accountId)

  const free = await claim().is('bot_lock_until', null).select('id')
  if (free.error) throw new Error(`No se pudo tomar el candado: ${free.error.message}`)
  if (((free.data ?? []) as unknown[]).length > 0) return untilIso

  const expired = await claim().lt('bot_lock_until', nowIso).select('id')
  if (expired.error) throw new Error(`No se pudo tomar el candado: ${expired.error.message}`)
  return ((expired.data ?? []) as unknown[]).length > 0 ? untilIso : null
}

/**
 * Suelta el candado solo si sigue siendo el de este proceso: si el trabajo
 * tardó más que el candado, otro mensaje pudo tomarlo y no se le quita.
 */
async function releaseBotLock(db: SupabaseClient, args: LockArgs, held: string): Promise<void> {
  const { error } = await db
    .from('conversations')
    .update({ bot_lock_until: null })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .eq('bot_lock_until', held)
  if (error) console.error('[agenda] no se pudo soltar el candado:', error.message)
}

/**
 * Corre `work` con el candado. Espera hasta `waitMs` a que se libere. Si sigue
 * ocupado, el mensaje se consume sin responder (se registra), salvo que
 * `runWithoutLockWhen` diga que no puede perderse (una urgencia): entonces el
 * trabajo corre igual, sin candado y sin soltar el de otro. Si esa pregunta
 * lanza, el error sube.
 */
export async function withBotLock(
  db: SupabaseClient,
  args: LockArgs,
  work: () => Promise<VerticalDispatchResult>,
  opts: { waitMs?: number; runWithoutLockWhen?: () => Promise<boolean> } = {},
): Promise<VerticalDispatchResult> {
  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS)
  let held = await acquireBotLock(db, { ...args, now: new Date() })
  while (!held && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    held = await acquireBotLock(db, { ...args, now: new Date() })
  }
  if (!held) {
    if (opts.runWithoutLockWhen && (await opts.runWithoutLockWhen())) {
      console.warn(
        `[agenda] mensaje urgente sin candado en la conversación ${args.conversationId}: se procesa igual`,
      )
      return work()
    }
    console.warn(`[agenda] mensaje sin candado en la conversación ${args.conversationId}`)
    return { consumed: true }
  }
  try {
    return await work()
  } finally {
    await releaseBotLock(db, args, held)
  }
}
