// ============================================================
// Avisos de estado al cliente (diseño §3.5).
//
// `sendOrderNotice` es la costura que usan las rutas de /api/modules/ventas
// para avisar por WhatsApp cuando un pedido se paga, se envía o se
// entrega. Contrato (el que las rutas y la pantalla ya respetan):
//
//   - Nunca lanza: devuelve el resultado del intento.
//       'sent'    el mensaje salió (texto libre o plantilla).
//       'failed'  no salió (falló el envío, falta la plantilla, o el
//                 envío todavía no está disponible).
//   - 'skipped' NO lo devuelve esta función: lo produce la ruta cuando
//     el interruptor de ese aviso está apagado en los ajustes (el
//     cliente no pidió aviso). La pantalla debe leer:
//         'sent'    → "Aviso enviado"
//         'skipped' → "Avisos de este tipo desactivados"
//         'failed'  → "No se pudo avisar al cliente"
//   - Un fallo de envío jamás deshace el cambio de estado del pedido.
//
// Esta versión todavía no envía nada: devuelve 'failed' para que nada
// afirme que el cliente fue avisado ni que se decidió no avisar. La
// implementación real (texto libre dentro de la ventana de 24 h,
// plantilla de Meta fuera de ella y registro de last_notice /
// last_notice_error) llega con la tarea de avisos y reemplaza el cuerpo
// sin cambiar esta firma.
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
  return 'failed'
}
