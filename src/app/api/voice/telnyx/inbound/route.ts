import { after } from 'next/server'

import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { INBOUND_SUBJECT } from '@/lib/voice/tokens'
import { readVoiceWebhook, texmlResponse } from '@/lib/voice/webhook'
import { inboundDeps } from '@/verticals/agenda/voice/inbound-deps'
import { inboundFailureXml } from '@/verticals/agenda/voice/inbound-flow'
import { handleInboundWebhook } from '@/verticals/agenda/voice/inbound-webhook'
import { resolveVoice } from '@/verticals/agenda/voice/settings'

// ============================================================
// POST /api/voice/telnyx/inbound
//
// Las instrucciones de una llamada ENTRANTE, las 24 horas (diseño §6.3). Telnyx
// llama aquí cuando alguien marca el número de la cuenta (la URL de la app de
// TeXML: `…/inbound?t=<token de "inbound">`) y cada vez que quien llama marca
// una tecla (el `action` del Gather, que sí lleva el id de la llamada). El
// estado del menú viaja en la query (`step`, `loop`, `path`, `appt`), nunca en
// memoria.
//
//   - Lee el cuerpo crudo UNA vez y exige el token `t` (siempre): el del sujeto
//     "inbound" en el primer pedido (aún no hay fila), y el del id de la llamada
//     en los siguientes. Si llegan las cabeceras de firma Ed25519 de Telnyx, la
//     firma tiene que cuadrar; si no, 403.
//   - Responde siempre TeXML con `Content-Type: text/xml`. Si algo falla por
//     dentro, responde una despedida válida (que no promete que alguien llamará)
//     en vez de dejar la llamada muda.
//   - Lo lento (avisar al paciente por WhatsApp de una cancelación, copiar a
//     Google Calendar) corre con `after()`, ya respondida la llamada.
//
// La lógica vive en `voice/inbound-webhook.ts`; aquí solo está el HTTP. Nada de
// lo que se loguea lleva el nombre ni el teléfono de quien llama.
// ============================================================

export async function POST(request: Request) {
  const verified = await readVoiceWebhook(request, {
    subject: (query) => query.get('call') ?? INBOUND_SUBJECT,
  })
  if (!verified.ok) return verified.response
  const { query, form } = verified.webhook

  try {
    const result = await handleInboundWebhook({
      db: supabaseAdmin(),
      query,
      form,
      now: new Date(),
      deps: inboundDeps,
    })
    for (const task of result.deferred) after(task)
    return texmlResponse(result.xml)
  } catch (err) {
    console.error('[voice inbound] el webhook falló:', err instanceof Error ? err.message : 'error')
    return texmlResponse(inboundFailureXml(resolveVoice({ voice: null })))
  }
}
