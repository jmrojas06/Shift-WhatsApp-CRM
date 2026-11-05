// ============================================================
// Token de las URL de webhook de voz.
//
// Telnyx no documenta que firme el primer pedido de instrucciones de una
// llamada. Por eso toda URL de webhook que armamos lleva además un parámetro
// `t`: HMAC-SHA256 con `VOICE_WEBHOOK_SECRET` de "a qué llamada pertenece"
// (el id de nuestra fila, o la palabra "inbound" para el primer pedido de una
// llamada entrante, que aún no tiene fila). Sin un `t` válido, 403.
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

function sign(subject: string, key: string): string {
  return createHmac('sha256', key).update(subject).digest('base64url')
}

/** Token (`t`) de un sujeto. Lanza si falta `VOICE_WEBHOOK_SECRET`. */
export function voiceToken(subject: string): string {
  const key = secret()
  if (!key) throw new Error('Falta VOICE_WEBHOOK_SECRET para firmar las URL de voz.')
  return sign(subject, key)
}

/**
 * ¿`token` es el del sujeto? Comparación en tiempo constante. Sin secreto, o
 * sin token, siempre es falso: jamás se compara contra una llave vacía.
 */
export function checkVoiceToken(subject: string, token: string | null | undefined): boolean {
  const key = secret()
  if (!key || typeof token !== 'string' || token === '') return false
  const expected = Buffer.from(sign(subject, key))
  const received = Buffer.from(token)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

export type VoiceUrlParams = Record<string, string | number | null | undefined>

/**
 * URL absoluta de un webhook de voz con su token. La base es
 * `NEXT_PUBLIC_APP_URL` (sin barra final). El token se firma con el sujeto
 * dado; si no se da, con el parámetro `call` o, si tampoco hay, con "inbound".
 * Un `t` que venga en `params` se ignora: el token siempre es el calculado.
 */
export function voiceUrl(path: string, params: VoiceUrlParams, subject?: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  if (!base) throw new Error('Falta NEXT_PUBLIC_APP_URL para armar las URL de voz.')

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === 't' || value === undefined || value === null) continue
    query.set(key, String(value))
  }
  const tokenSubject = subject ?? (params.call != null ? String(params.call) : INBOUND_SUBJECT)
  query.set('t', voiceToken(tokenSubject))

  return `${base}/${path.replace(/^\/+/, '')}?${query.toString()}`
}
