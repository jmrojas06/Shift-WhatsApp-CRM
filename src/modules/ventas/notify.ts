// ============================================================
// Avisos de estado al cliente (diseño §3.5).
//
// `sendOrderNotice` es la costura que usan las rutas de /api/modules/ventas
// para avisar por WhatsApp cuando un pedido se paga, se envía o se
// entrega. Contrato (el que las rutas ya respetan):
//
//   - Nunca lanza: devuelve el resultado del intento.
//       'sent'    el mensaje salió (texto libre o plantilla).
//       'skipped' no se intentó (todavía no hay envío implementado).
//       'failed'  se intentó y falló (queda para mostrarse en el pedido).
//   - Un fallo de envío jamás deshace el cambio de estado del pedido.
//   - Si el aviso está prendido o apagado en los ajustes lo decide la
//     ruta antes de llamar aquí.
//
// Esta versión todavía no envía nada: la implementación real (texto
// libre dentro de la ventana de 24 h, plantilla de Meta fuera de ella y
// registro de last_notice / last_notice_error) llega con la tarea de
// avisos y reemplaza el cuerpo sin cambiar esta firma.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { NoticeKind } from './orders'
import type { OrderRow } from './repo'

export type NoticeOutcome = 'sent' | 'skipped' | 'failed'

export async function sendOrderNotice(
  db: SupabaseClient,
  order: OrderRow,
  kind: NoticeKind,
): Promise<NoticeOutcome> {
  void db
  void order
  void kind
  return 'skipped'
}
