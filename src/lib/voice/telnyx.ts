// ============================================================
// Telnyx (TeXML): llamadas salientes y firma de los webhooks.
//
// Todo queda detrás de `VoiceProvider` para poder cambiar de proveedor
// (TeXML es compatible con TwiML). En esta entrega solo existe Telnyx.
//
// Nada de este archivo guarda ni imprime teléfonos: los mensajes de error
// llevan el código HTTP y el título genérico de Telnyx, con cualquier número
// largo tapado, porque el detalle de Telnyx suele repetir el número marcado.
// ============================================================

import { createPublicKey, verify } from 'node:crypto'

// ------------------------------------------------------------
// Llamada saliente
// ------------------------------------------------------------

export interface StartCallArgs {
  /** Teléfono del paciente, E.164. */
  to: string
  /** Número que verá el paciente, E.164. */
  from: string
  /** URL de las instrucciones (TeXML) cuando contesten. */
  url: string
  /** URL que recibe el resultado de la llamada. */
  statusCallback: string
}

export type StartCallResult = { ok: true } | { ok: false; error: string }

export interface VoiceProvider {
  startCall(args: StartCallArgs): Promise<StartCallResult>
}

export interface TelnyxProviderOptions {
  apiKey: string
  accountSid: string
  /** Id de la aplicación TeXML (`TELNYX_TEXML_APP_ID`). */
  appId: string
  /** Para las pruebas: un `fetch` falso. */
  fetchImpl?: typeof fetch
}

const TELNYX_API = 'https://api.telnyx.com/v2/texml/Accounts'
/** Segundos que suena el teléfono del paciente antes de rendirse. */
const RING_TIMEOUT_SECONDS = 25
const NETWORK_TIMEOUT_MS = 10_000

/** Tapa los números largos (teléfonos) que Telnyx pueda repetir en un texto. */
const maskLongNumbers = (text: string): string => text.replace(/\+?\d{6,}/g, '…')

/** "400" + {errors:[{code,title}]} → "Telnyx rechazó la llamada (400): 10015 Invalid parameter". */
function describeRejection(status: number, rawBody: string): string {
  let extra = ''
  try {
    const parsed = JSON.parse(rawBody) as { errors?: { code?: unknown; title?: unknown }[] }
    const first = Array.isArray(parsed.errors) ? parsed.errors[0] : undefined
    const parts = [first?.code, first?.title]
      .filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      .map(String)
    if (parts.length > 0) extra = `: ${maskLongNumbers(parts.join(' ')).slice(0, 150)}`
  } catch {
    // No es JSON: solo queda el código HTTP.
  }
  return `Telnyx rechazó la llamada (${status})${extra}`
}

export function createTelnyxProvider(options: TelnyxProviderOptions): VoiceProvider {
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    async startCall(args) {
      const body = new URLSearchParams({
        To: args.to,
        From: args.from,
        ApplicationSid: options.appId,
        Url: args.url,
        StatusCallback: args.statusCallback,
        StatusCallbackEvent: 'completed',
        Timeout: String(RING_TIMEOUT_SECONDS),
      })

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
      try {
        const res = await fetchImpl(`${TELNYX_API}/${encodeURIComponent(options.accountSid)}/Calls`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: controller.signal,
        })
        if (!res.ok) return { ok: false, error: describeRejection(res.status, await res.text()) }
        return { ok: true }
      } catch {
        // Mensajes fijos: el texto del error de red puede traer la URL o el número.
        return {
          ok: false,
          error: controller.signal.aborted
            ? 'Telnyx tardó más de 10 segundos en responder'
            : 'No se pudo contactar a Telnyx',
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ------------------------------------------------------------
// Firma del webhook
// ------------------------------------------------------------

/** Prefijo SPKI de una clave pública Ed25519 de 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const TOLERANCE_SECONDS = 5 * 60

export interface VerifySignatureArgs {
  /** El cuerpo tal cual llegó (`await request.text()`), sin tocar. */
  rawBody: string
  /** Cabecera `telnyx-signature-ed25519` (base64). */
  signature: string | null | undefined
  /** Cabecera `telnyx-timestamp` (segundos). */
  timestamp: string | null | undefined
  /** `TELNYX_PUBLIC_KEY`: base64 de 32 bytes. */
  publicKeyB64: string | null | undefined
  /** Hora actual en segundos (se pasa para poder probarlo). */
  nowSec: number
}

/**
 * ¿La firma Ed25519 de Telnyx sobre `"{timestamp}|{cuerpo}"` es válida y tiene
 * menos de 5 minutos? Cualquier dato que falte o venga dañado es `false`;
 * nunca lanza.
 */
export function verifyTelnyxSignature(args: VerifySignatureArgs): boolean {
  const { rawBody, signature, timestamp, publicKeyB64, nowSec } = args
  if (!signature || !timestamp || !publicKeyB64) return false
  if (!/^\d{1,12}$/.test(timestamp)) return false
  if (!Number.isFinite(nowSec) || Math.abs(nowSec - Number(timestamp)) > TOLERANCE_SECONDS) return false

  try {
    const rawKey = Buffer.from(publicKeyB64, 'base64')
    const signatureBytes = Buffer.from(signature, 'base64')
    if (rawKey.length !== 32 || signatureBytes.length !== 64) return false

    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, signatureBytes)
  } catch {
    return false
  }
}

// ------------------------------------------------------------
// Formulario de los webhooks
// ------------------------------------------------------------

/** `CallSid=…&From=…&Digits=1` → objeto. Si una clave se repite, gana la última. */
export function parseForm(rawBody: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(rawBody))
}

// ------------------------------------------------------------
// Variables de entorno
// ------------------------------------------------------------

export interface TelnyxConfig {
  apiKey: string
  accountSid: string
  appId: string
  publicKey: string
}

export type TelnyxConfigResult = { ok: true; config: TelnyxConfig } | { ok: false; missing: string[] }

/**
 * Lee las variables que necesita el robot de voz. Si falta alguna, dice cuáles
 * (el cron no hace nada y la tarjeta de ajustes avisa). Además de las de
 * Telnyx pide `VOICE_WEBHOOK_SECRET` y `NEXT_PUBLIC_APP_URL`, sin las cuales no
 * se puede armar ni verificar una URL de webhook.
 */
export function readTelnyxConfig(env: Record<string, string | undefined> = process.env): TelnyxConfigResult {
  const read = (name: string): string => env[name]?.trim() ?? ''
  const missing = [
    'TELNYX_API_KEY',
    'TELNYX_ACCOUNT_SID',
    'TELNYX_TEXML_APP_ID',
    'TELNYX_PUBLIC_KEY',
    'VOICE_WEBHOOK_SECRET',
    'NEXT_PUBLIC_APP_URL',
  ].filter((name) => read(name) === '')
  if (missing.length > 0) return { ok: false, missing }

  return {
    ok: true,
    config: {
      apiKey: read('TELNYX_API_KEY'),
      accountSid: read('TELNYX_ACCOUNT_SID'),
      appId: read('TELNYX_TEXML_APP_ID'),
      publicKey: read('TELNYX_PUBLIC_KEY'),
    },
  }
}
