import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { INBOUND_SUBJECT } from '@/lib/voice/tokens'
import { readVoiceWebhook, texmlResponse } from '@/lib/voice/webhook'
import { handleStatusCallback } from '@/verticals/agenda/voice/call-events'
import { handleInboundStatus } from '@/verticals/agenda/voice/inbound-status'

// ============================================================
// POST /api/voice/telnyx/status
//
// Telnyx avisa que la llamada terminó (`StatusCallback`, evento `completed`):
// `CallStatus` (completed, busy, no-answer, failed, canceled) y `CallDuration`.
// Cierra la fila de `booking_calls`; si no quedó ningún resultado, queda
// `no_response`. Sirve a las llamadas salientes y a las entrantes:
//
//   - Saliente: la URL se arma por llamada y lleva `call` (el id de la fila) y
//     el token de ese id.
//   - Entrante: Telnyx usa una URL fija, la de la app de TeXML
//     (`…/status?inbound=1&t=<token de "inbound">`), sin id de fila. La llamada
//     se encuentra por su `CallSid`.
//
// Token `t` siempre y firma de Telnyx si trae sus cabeceras (403 si no cuadran).
// Es idempotente: un reintento no cambia nada. Si la base falla responde 500 sin
// detalles para que Telnyx pueda reintentar.
// ============================================================

export async function POST(request: Request) {
  const verified = await readVoiceWebhook(request, {
    subject: (query) => query.get('call') ?? (query.get('inbound') === '1' ? INBOUND_SUBJECT : null),
  })
  if (!verified.ok) return verified.response
  const { query, form } = verified.webhook

  try {
    const callId = query.get('call')
    if (callId !== null) {
      await handleStatusCallback({ db: supabaseAdmin(), callId, form, now: new Date() })
    } else {
      await handleInboundStatus({ db: supabaseAdmin(), form, now: new Date() })
    }
    return texmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>')
  } catch (err) {
    console.error('[voice status] no se pudo guardar el cierre de la llamada:', err instanceof Error ? err.message : 'error')
    return texmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>', 500)
  }
}
