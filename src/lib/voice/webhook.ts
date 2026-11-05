// ============================================================
// Lo común de los webhooks de voz (Telnyx / TeXML).
//
// Cada ruta de webhook hace lo mismo antes de mirar la llamada:
//   1. Lee el cuerpo crudo UNA sola vez (`request.text()`): la firma se calcula
//      sobre esos bytes y un cuerpo leído dos veces no se puede.
//   2. Exige el token `t` de la URL, SIEMPRE. Telnyx no documenta que firme el
//      primer pedido de instrucciones, así que el token es lo único que prueba
//      que la URL es la que armamos nosotros.
//   3. Si llegan las cabeceras de firma de Telnyx (`telnyx-signature-ed25519`,
//      `telnyx-timestamp`), la firma tiene que cuadrar; si no, 403. Llegar con
//      solo una de las dos, o sin clave pública configurada, también es 403.
//   4. Responde TeXML con `Content-Type: text/xml`.
//
// El 403 no repite nada del pedido (ni el número ni el id de la llamada).
// ============================================================

import { verifyTelnyxSignature, parseForm } from './telnyx'
import { checkVoiceToken } from './tokens'

const SIGNATURE_HEADER = 'telnyx-signature-ed25519'
const TIMESTAMP_HEADER = 'telnyx-timestamp'

/** Una respuesta de TeXML: siempre `text/xml`. */
export function texmlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } })
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export interface VoiceWebhook {
  /** La query de la URL: `call`, `t`, `step`, `loop`… */
  query: URLSearchParams
  /** El formulario del cuerpo: `CallSid`, `From`, `To`, `Digits`… */
  form: Record<string, string>
  /** El cuerpo tal cual llegó. */
  rawBody: string
}

export type VoiceWebhookResult = { ok: true; webhook: VoiceWebhook } | { ok: false; response: Response }

export interface ReadVoiceWebhookOptions {
  /**
   * De qué se firmó el token: el id de la llamada (`query.get('call')`) o
   * `'inbound'`. Devolver null es un pedido sin sujeto: 403.
   */
  subject: (query: URLSearchParams) => string | null
  /** Hora actual en segundos; solo para probar la tolerancia de la firma. */
  nowSec?: number
}

/**
 * Lee, verifica y descompone un webhook de voz. Nunca lanza por un pedido
 * dañado: lo que no cuadra es un 403.
 */
export async function readVoiceWebhook(
  request: Request,
  options: ReadVoiceWebhookOptions,
): Promise<VoiceWebhookResult> {
  const rawBody = await request.text()
  const query = new URL(request.url).searchParams

  const subject = options.subject(query)
  if (!subject || !checkVoiceToken(subject, query.get('t'))) return { ok: false, response: forbidden() }

  const signature = request.headers.get(SIGNATURE_HEADER)
  const timestamp = request.headers.get(TIMESTAMP_HEADER)
  if (signature !== null || timestamp !== null) {
    const valid = verifyTelnyxSignature({
      rawBody,
      signature,
      timestamp,
      publicKeyB64: process.env.TELNYX_PUBLIC_KEY?.trim(),
      nowSec: options.nowSec ?? Math.floor(Date.now() / 1000),
    })
    if (!valid) return { ok: false, response: forbidden() }
  }

  return { ok: true, webhook: { query, form: parseForm(rawBody), rawBody } }
}
