// ============================================================
// Utilidades HTTP de las rutas de Ventas (/api/modules/ventas/*).
//
// Carpeta privada `_lib`: las tres rutas comparten el mismo contrato
// de errores y la misma política de avisos.
//   - badRequest: 400 con mensaje en español.
//   - readJsonBody: cuerpo JSON o null (llamadas rotas).
//   - salesErrorResponse: SalesError → su status (403/404/409/400).
//   - deliverNotice: aviso al cliente según los ajustes; nunca lanza.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { sendOrderNotice, type NoticeOutcome } from '@/modules/ventas/notify'
import type { NoticeKind } from '@/modules/ventas/orders'
import { SalesError, getSalesSettings, type OrderRow } from '@/modules/ventas/repo'

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 })
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
 * Convierte un error de dominio de Ventas en respuesta. Devuelve null si
 * no lo es: la ruta sigue con `toModuleErrorResponse` (auth → 401/403,
 * módulo apagado → 409, resto → 500 genérico).
 */
export function salesErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SalesError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  return null
}

const SETTING_FOR_NOTICE = {
  paid: 'notify_paid',
  shipped: 'notify_shipped',
  delivered: 'notify_delivered',
} as const satisfies Record<NoticeKind, string>

/**
 * Manda el aviso de `kind` si el interruptor de la cuenta está prendido.
 * 'skipped' = apagado (o sin envío disponible); 'failed' = se intentó y
 * falló. Jamás lanza: el cambio de estado ya se guardó y no se deshace.
 */
export async function deliverNotice(
  db: SupabaseClient,
  order: OrderRow,
  kind: NoticeKind,
): Promise<NoticeOutcome> {
  try {
    const settings = await getSalesSettings(db, order.account_id)
    if (!settings[SETTING_FOR_NOTICE[kind]]) return 'skipped'
    return await sendOrderNotice(db, order, kind)
  } catch (err) {
    console.error(`[ventas] pedido ${order.number}: falló el aviso "${kind}"`, err)
    return 'failed'
  }
}
