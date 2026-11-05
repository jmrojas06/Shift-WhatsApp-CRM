import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { readVoiceWebhook, texmlResponse } from '@/lib/voice/webhook'
import { handleStatusCallback } from '@/verticals/agenda/voice/call-events'

// ============================================================
// POST /api/voice/telnyx/status
//
// Telnyx avisa que la llamada terminó (`StatusCallback`, evento `completed`):
// `CallStatus` (completed, busy, no-answer, failed, canceled) y `CallDuration`.
// Cierra la fila de `booking_calls`; si no quedó ningún resultado, queda
// `no_response`. Sirve a las llamadas salientes y a las entrantes.
//
// Token `t` siempre y firma de Telnyx si trae sus cabeceras (403 si no cuadran).
// Es idempotente: un reintento no cambia nada. Si la base falla responde 500 sin
// detalles para que Telnyx pueda reintentar.
// ============================================================

export async function POST(request: Request) {
  const verified = await readVoiceWebhook(request, { subject: (query) => query.get('call') })
  if (!verified.ok) return verified.response
  const { query, form } = verified.webhook

  try {
    await handleStatusCallback({
      db: supabaseAdmin(),
      callId: query.get('call') ?? '',
      form,
      now: new Date(),
    })
    return texmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>')
  } catch (err) {
    console.error('[voice status] no se pudo guardar el cierre de la llamada:', err instanceof Error ? err.message : 'error')
    return texmlResponse('<?xml version="1.0" encoding="UTF-8"?><Response/>', 500)
  }
}
