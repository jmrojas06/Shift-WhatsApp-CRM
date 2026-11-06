// ============================================================
// Token de las URL de webhook de voz.
//
// Telnyx no documenta que firme el primer pedido de instrucciones de una
// llamada. Por eso toda URL de webhook que armamos lleva además un parámetro
// `t`: HMAC-SHA256 con `VOICE_WEBHOOK_SECRET` de dos cosas:
//
//   1. el SUJETO: "a qué llamada pertenece" (el id de nuestra fila, o la palabra
//      "inbound" para el primer pedido de una llamada entrante, que aún no tiene
//      fila);
//   2. el ESTADO de la URL: todos los demás parámetros de la query (`call`,
//      `step`, `loop`, `path`, `appt`, `inbound`…), menos `t`. El estado del menú
//      viaja en la URL, así que sin firmarlo quien tenga una URL válida podría
//      cambiar `step` o `appt` y saltarse una pregunta o apuntar a otra cita.
//
// Sin un `t` válido para ESE sujeto y ESE estado, 403.
//
// Los parámetros se firman en forma canónica (ordenados por nombre y luego por
// valor, y como JSON para que un valor nunca se confunda con otro parámetro).
// Sin parámetros el texto firmado es el sujeto solo: así el `t` fijo de la URL
// de voz entrante (`…/inbound?t=<HMAC de "inbound">`) no cambia.
//
// Se lee el secreto en cada uso (no al cargar el módulo) para que las pruebas
// y los despliegues puedan cambiarlo. Sin secreto, nada se firma ni se acepta.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Sujeto del token cuando la llamada aún no tiene fila propia. */
export const INBOUND_SUBJECT = 'inbound'

function secret(): string | null {
  const value = process.env.VOICE_WEBHOOK_SECRET?.trim()
  return value ? value : null
}

/** ¿Hay secreto para firmar? Quien arma llamadas lo revisa antes de empezar. */
export function isVoiceTokenConfigured(): boolean {
  return secret() !== null
}

/**
 * La URL pública de la app, sin barra final: `NEXT_PUBLIC_SITE_URL` (la variable
 * que ya usa el resto de la app) y, si no está, `NEXT_PUBLIC_APP_URL`. null si
 * ninguna de las dos tiene valor.
 */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const read = (name: string): string => env[name]?.trim().replace(/\/+$/, '') ?? ''
  return read('NEXT_PUBLIC_SITE_URL') || read('NEXT_PUBLIC_APP_URL') || null
}

export type VoiceUrlParams = Record<string, string | number | null | undefined>
/** El estado a firmar: la query de una URL recibida, o los parámetros con que se arma una. */
export type VoiceTokenParams = URLSearchParams | VoiceUrlParams

/** Pares nombre/valor del estado, sin `t` ni vacíos, en orden estable. */
function stateEntries(params: VoiceTokenParams | undefined): [string, string][] {
  const entries: [string, string][] =
    params instanceof URLSearchParams
      ? [...params.entries()]
      : Object.entries(params ?? {})
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
  return entries
    .filter(([key]) => key !== 't')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
}

/** Lo que se firma: el sujeto solo, o el sujeto junto con el estado. */
function signedText(subject: string, params: VoiceTokenParams | undefined): string {
  const entries = stateEntries(params)
  return entries.length === 0 ? subject : JSON.stringify([subject, entries])
}

function sign(text: string, key: string): string {
  return createHmac('sha256', key).update(text).digest('base64url')
}

/**
 * Token (`t`) de un sujeto y del estado de la URL (`params`; sin ellos, solo el
 * sujeto). Lanza si falta `VOICE_WEBHOOK_SECRET`.
 */
export function voiceToken(subject: string, params?: VoiceTokenParams): string {
  const key = secret()
  if (!key) throw new Error('Falta VOICE_WEBHOOK_SECRET para firmar las URL de voz.')
  return sign(signedText(subject, params), key)
}

/**
 * ¿`token` es el del sujeto y del estado que trae la URL (`params` = su query
 * completa; el `t` se ignora)? Comparación en tiempo constante. Sin secreto, o
 * sin token, siempre es falso: jamás se compara contra una llave vacía.
 */
export function checkVoiceToken(
  subject: string,
  token: string | null | undefined,
  params: VoiceTokenParams,
): boolean {
  const key = secret()
  if (!key || typeof token !== 'string' || token === '') return false
  const expected = Buffer.from(sign(signedText(subject, params), key))
  const received = Buffer.from(token)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

/**
 * URL absoluta de un webhook de voz con su token. La base es
 * `NEXT_PUBLIC_SITE_URL` (o, si no está, `NEXT_PUBLIC_APP_URL`), sin barra final.
 * El token firma el sujeto y todos los `params`; el sujeto es el dado, o el
 * parámetro `call` o, si tampoco hay, "inbound". Un `t` que venga en `params` se
 * ignora: el token siempre es el calculado.
 */
export function voiceUrl(path: string, params: VoiceUrlParams, subject?: string): string {
  const base = publicBaseUrl()
  if (!base) throw new Error('Falta NEXT_PUBLIC_SITE_URL para armar las URL de voz.')

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === 't' || value === undefined || value === null) continue
    query.set(key, String(value))
  }
  const tokenSubject = subject ?? (params.call != null ? String(params.call) : INBOUND_SUBJECT)
  query.set('t', voiceToken(tokenSubject, query))

  return `${base}/${path.replace(/^\/+/, '')}?${query.toString()}`
}
