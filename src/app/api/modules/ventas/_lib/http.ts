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
//   - deliverNotice: aviso al cliente según los ajustes; nunca lanza.
// ============================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { ModuleNotActiveError } from '@/lib/modules/errors'
import { sendOrderNotice, type NoticeOutcome } from '@/modules/ventas/notify'
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

/**
 * Manda el aviso de `kind` si el interruptor de la cuenta está prendido.
 * Resultado (ver notify.ts): 'sent' = salió; 'skipped' = el interruptor
 * de ese aviso está apagado; 'failed' = no salió (falló el envío, no se
 * pudieron leer los ajustes, o el envío aún no está disponible).
 * Jamás lanza: el cambio de estado ya se guardó y no se deshace.
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
