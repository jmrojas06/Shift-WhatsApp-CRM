import { after } from 'next/server'

import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { readVoiceWebhook, texmlResponse } from '@/lib/voice/webhook'
import { kickCalendarSync } from '@/verticals/agenda/calendar-kick'
import { notifyPatient } from '@/verticals/agenda/notify-patient'
import { failureXml } from '@/verticals/agenda/voice/outbound-flow'
import { handleOutboundWebhook } from '@/verticals/agenda/voice/outbound-webhook'
import { resolveVoice } from '@/verticals/agenda/voice/settings'

// ============================================================
// POST /api/voice/telnyx/outbound
//
// Las instrucciones de una llamada saliente de confirmación (diseño §6.2).
// Telnyx llama aquí cuando el paciente contesta (`Url` de la llamada) y cada
// vez que marca una tecla (`action` del Gather). El estado del menú viaja en la
// query (`step`, `loop`, `path`), nunca en memoria.
//
//   - Lee el cuerpo crudo UNA vez, exige el token `t` (siempre) y la firma
//     Ed25519 de Telnyx si trae sus cabeceras: si no cuadra, 403.
//   - Responde siempre TeXML con `Content-Type: text/xml`. Si algo falla por
//     dentro, responde una despedida válida en vez de dejar la llamada muda.
//   - Lo lento (avisar al paciente por WhatsApp, copiar a Google Calendar) corre
//     con `after()`, ya respondida la llamada.
//
// La lógica vive en `voice/outbound-webhook.ts`; aquí solo está el HTTP. Nada de
// lo que se loguea lleva el nombre ni el teléfono del paciente.
// ============================================================

export async function POST(request: Request) {
  const verified = await readVoiceWebhook(request, { subject: (query) => query.get('call') })
  if (!verified.ok) return verified.response
  const { query, form } = verified.webhook

  try {
    const result = await handleOutboundWebhook({
      db: supabaseAdmin(),
      callId: query.get('call') ?? '',
      query,
      form,
      now: new Date(),
      deps: { notifyPatient, kickCalendar: kickCalendarSync },
    })
    for (const task of result.deferred) after(task)
    return texmlResponse(result.xml)
  } catch (err) {
    console.error('[voice outbound] el webhook falló:', err instanceof Error ? err.message : 'error')
    return texmlResponse(failureXml(resolveVoice({ voice: null })))
  }
}
