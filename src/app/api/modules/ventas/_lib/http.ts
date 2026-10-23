// ============================================================
// Utilidades HTTP de las rutas de Ventas (/api/modules/ventas/*).
//
// Carpeta privada `_lib`: las tres rutas comparten el mismo contrato
// de errores y la misma política de avisos.
//
// Contrato de errores: toda respuesta de error trae
// `{ error: <mensaje en español>, code: <código> }`.
//   400 invalid · 401 unauthorized · 403 forbidden · 404 not_found ·
//   409 stale | invalid_transition | module_inactive.
// Los fallos inesperados siguen siendo un 500 genérico sin `code` ni
// detalles (lo decide toErrorResponse).
//
//   - badRequest: 400 `invalid` con mensaje en es-CO.
//   - readJsonBody: cuerpo JSON o null (llamadas rotas).
//   - salesErrorResponse: SalesError, módulo apagado y errores de
//     sesión/rol → su respuesta con `code`. Null si no es ninguno.
//   - deliverNotice: aviso al cliente según los ajustes; devuelve el
//     resultado y el pedido con el aviso ya reflejado; nunca lanza.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { ModuleNotActiveError } from '@/lib/modules/errors'
import {
  NOTICE_ERRORS,
  recordNotice,
  sendOrderNotice,
  type NoticeOutcome,
} from '@/modules/ventas/notify'
import type { NoticeKind } from '@/modules/ventas/orders'
import { SalesError, getSalesSettings, type OrderRow } from '@/modules/ventas/repo'

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message, code: 'invalid' }, { status: 400 })
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Convierte un error conocido en respuesta con `code`. Devuelve null si
 * no lo es: la ruta sigue con `toModuleErrorResponse` (resto → 500
 * genérico). Reconoce por forma, no por clase, el 401/403 de
 * `requireRole` (UnauthorizedError / ForbiddenError traen `status`).
 */
export function salesErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SalesError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  if (err instanceof ModuleNotActiveError) {
    return NextResponse.json({ error: err.message, code: 'module_inactive' }, { status: 409 })
  }
  const status = (err as { status?: unknown } | null)?.status
  if ((status === 401 || status === 403) && err instanceof Error) {
    return NextResponse.json(
      { error: err.message, code: status === 401 ? 'unauthorized' : 'forbidden' },
      { status },
    )
  }
  return null
}

const SETTING_FOR_NOTICE = {
  paid: 'notify_paid',
  shipped: 'notify_shipped',
  delivered: 'notify_delivered',
} as const satisfies Record<NoticeKind, string>

/** Pedido con el resultado del aviso ya reflejado (ver `deliverNotice`). */
export interface DeliveredNotice<T extends OrderRow> {
  notice: NoticeOutcome
  order: T
}

/** Relee `last_notice` / `last_notice_error` y los mezcla en el pedido a devolver. */
async function withStoredNotice<T extends OrderRow>(db: SupabaseClient, order: T): Promise<T> {
  try {
    const { data } = await db
      .from('orders')
      .select('last_notice, last_notice_error')
      .eq('id', order.id)
      .eq('account_id', order.account_id)
      .maybeSingle()
    const stored = data as Pick<OrderRow, 'last_notice' | 'last_notice_error'> | null
    if (!stored) return order
    return { ...order, last_notice: stored.last_notice, last_notice_error: stored.last_notice_error }
  } catch {
    return order
  }
}

/**
 * Manda el aviso de `kind` si el interruptor de la cuenta está prendido y
 * devuelve el resultado junto con el pedido actualizado (con el
 * `last_notice` / `last_notice_error` que quedaron guardados, para que la
 * pantalla no muestre el estado viejo del aviso).
 * Resultado (ver notify.ts): 'sent' = salió; 'skipped' = el interruptor
 * de ese aviso está apagado (el pedido no cambia); 'failed' = no salió
 * (falló el envío o no se pudieron leer los ajustes). En todo 'failed' el
 * motivo queda en el pedido: sendOrderNotice lo guarda, y si ni siquiera
 * se llegó a intentar (ajustes ilegibles, error inesperado) se guarda aquí
 * con el motivo genérico.
 * Jamás lanza: el cambio de estado ya se guardó y no se deshace.
 */
export async function deliverNotice<T extends OrderRow>(
  db: SupabaseClient,
  order: T,
  kind: NoticeKind,
): Promise<DeliveredNotice<T>> {
  let notice: NoticeOutcome
  try {
    const settings = await getSalesSettings(db, order.account_id)
    if (!settings[SETTING_FOR_NOTICE[kind]]) return { notice: 'skipped', order }
    notice = await sendOrderNotice(db, order, kind)
  } catch (err) {
    console.error(`[ventas notice] pedido ${order.number}: falló el aviso "${kind}"`, err)
    await recordNotice(db, order, kind, NOTICE_ERRORS.generic)
    notice = 'failed'
  }
  return { notice, order: await withStoredNotice(db, order) }
}
