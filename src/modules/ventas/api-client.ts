// ============================================================
// Cliente del navegador para /api/modules/ventas/* (inbox y /ventas).
//
// Nunca lanza: devuelve `{ ok: true, data }` o `{ ok: false, ... }` con
// el mensaje ya listo para la pantalla (`salesErrorMessage`) y el
// `code` del servidor para decidir qué hacer (por ejemplo, `stale` →
// recargar). Las lecturas NO pasan por aquí: van con el cliente de
// Supabase del usuario (la RLS deja leer a los miembros).
// ============================================================

import type { OrderAction, ValidOrderCreate } from './orders'
import { salesErrorMessage, type NoticeOutcome } from './panel'
import type { OrderRow, OrderWithItems, SalesSettings } from './repo'

export type SalesApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; message: string }

export interface OrderMutationResponse {
  order: OrderWithItems
  notice: NoticeOutcome | null
}

async function call<T>(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<SalesApiResult<T>> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, status: 0, code: null, message: salesErrorMessage({ status: 0 }) }
  }
  const payload = (await res.json().catch(() => null)) as
    | (T & { error?: string; code?: string })
    | null
  if (!res.ok || !payload) {
    const code = typeof payload?.code === 'string' ? payload.code : null
    return {
      ok: false,
      status: res.status,
      code,
      message: salesErrorMessage({ status: res.status, code, error: payload?.error ?? null }),
    }
  }
  return { ok: true, data: payload }
}

export const ventasApi = {
  createOrder: (body: ValidOrderCreate) =>
    call<OrderMutationResponse>('/api/modules/ventas/orders', 'POST', body),

  updateOrder: (
    id: string,
    action: OrderAction,
    extra: Partial<Pick<OrderRow, 'carrier' | 'tracking_number' | 'city' | 'address'>> = {},
  ) =>
    call<OrderMutationResponse>(`/api/modules/ventas/orders/${encodeURIComponent(id)}`, 'PATCH', {
      action,
      ...extra,
    }),

  saveSettings: (patch: Partial<SalesSettings>) =>
    call<{ settings: SalesSettings }>('/api/modules/ventas/settings', 'PATCH', patch),
}
