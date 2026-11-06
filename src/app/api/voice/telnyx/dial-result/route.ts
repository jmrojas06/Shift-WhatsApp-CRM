import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { readVoiceWebhook, texmlResponse } from '@/lib/voice/webhook'
import { handleDialResult } from '@/verticals/agenda/voice/call-events'
import { failureXml } from '@/verticals/agenda/voice/outbound-flow'
import { resolveVoice } from '@/verticals/agenda/voice/settings'

// ============================================================
// POST /api/voice/telnyx/dial-result
//
// El `action` del `<Dial>`: terminó la llamada pasada a los asesores y Telnyx
// manda `DialCallStatus`. Lo comparten las llamadas salientes (tecla 3 del
// robot de confirmación) y las entrantes (tecla 0 del menú).
//
//   - Contestó un asesor → `advisor_connected` y solo se cuelga.
//   - Nadie contestó → `advisor_missed`, un aviso en la app para que el equipo
//     lo llame, y se le dice al paciente "no hay asesores disponibles".
//
// Token `t` siempre y firma de Telnyx si trae sus cabeceras (403 si no cuadran).
// Es idempotente. Si algo falla, el paciente sigue en la línea: se le responde
// una despedida válida en vez de dejarlo en silencio.
// ============================================================

export async function POST(request: Request) {
  const verified = await readVoiceWebhook(request, { subject: (query) => query.get('call') })
  if (!verified.ok) return verified.response
  const { query, form } = verified.webhook

  try {
    const { xml } = await handleDialResult({
      db: supabaseAdmin(),
      callId: query.get('call') ?? '',
      form,
      now: new Date(),
    })
    return texmlResponse(xml)
  } catch (err) {
    console.error('[voice dial-result] el webhook falló:', err instanceof Error ? err.message : 'error')
    return texmlResponse(failureXml(resolveVoice({ voice: null })))
  }
}
