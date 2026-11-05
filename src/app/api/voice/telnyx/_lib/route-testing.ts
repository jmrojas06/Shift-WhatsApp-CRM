// ============================================================
// Utilidades de las pruebas de los webhooks de voz de Telnyx.
//
// Arma un pedido como el de Telnyx: POST con formulario, el `call` y el token
// `t` en la URL y, si se pide, las cabeceras de la firma Ed25519. No importa
// `vitest` (se carga con `await import` desde los `vi.mock`, o directo).
// ============================================================

import { generateKeyPairSync, sign } from 'node:crypto'

import { voiceToken } from '@/lib/voice/tokens'

export const TEST_CALL_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'
export const TEST_VOICE_SECRET = 'secreto-de-prueba-voz'
export const TEST_APP_URL = 'https://crm.example.test'

/** Un par de claves de prueba; la pública va en `TELNYX_PUBLIC_KEY` (base64 de 32 bytes). */
export function makeSigningKeys() {
  const keys = generateKeyPairSync('ed25519')
  const publicKeyB64 = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  return {
    publicKeyB64,
    /** Cabeceras de firma para un cuerpo, como las manda Telnyx. */
    headersFor(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
      return {
        'telnyx-signature-ed25519': sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64'),
        'telnyx-timestamp': timestamp,
      }
    },
  }
}

export interface WebhookRequestOptions {
  /** Id de la llamada (por defecto, `TEST_CALL_ID`); null = sin `call`. */
  call?: string | null
  /** Token (por defecto, el correcto para esa llamada); null = sin `t`. */
  token?: string | null
  /** Parámetros extra de la query (`step`, `loop`, `path`). */
  query?: Record<string, string>
  /** El formulario del cuerpo. */
  form?: Record<string, string>
  /** Cabeceras extra (la firma). Si es una función, recibe el cuerpo. */
  headers?: Record<string, string> | ((body: string) => Record<string, string>)
}

export function webhookRequest(route: string, options: WebhookRequestOptions = {}): Request {
  const call = options.call === undefined ? TEST_CALL_ID : options.call
  const query = new URLSearchParams()
  if (call !== null) query.set('call', call)
  if (options.token !== null) query.set('t', options.token ?? voiceToken(call ?? 'inbound'))
  for (const [key, value] of Object.entries(options.query ?? {})) query.set(key, value)

  const body = new URLSearchParams(options.form ?? {}).toString()
  const extra = typeof options.headers === 'function' ? options.headers(body) : (options.headers ?? {})
  return new Request(`${TEST_APP_URL}/api/voice/telnyx/${route}?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body,
  })
}
