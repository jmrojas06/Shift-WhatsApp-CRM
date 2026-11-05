import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTelnyxProvider,
  parseForm,
  readTelnyxConfig,
  verifyTelnyxSignature,
} from './telnyx'

afterEach(() => {
  vi.useRealTimers()
})

// ------------------------------------------------------------
// startCall
// ------------------------------------------------------------

interface Captured {
  url: string
  init: RequestInit
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Captured[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const CALL_ARGS = {
  to: '+573001234567',
  from: '+576015550000',
  url: 'https://crm.example.test/api/voice/telnyx/outbound?call=abc&t=tok',
  statusCallback: 'https://crm.example.test/api/voice/telnyx/status?call=abc&t=tok',
}

describe('createTelnyxProvider.startCall', () => {
  it('hace el POST del diseño: ruta, cabeceras y cuerpo de formulario', async () => {
    const { impl, calls } = fakeFetch(() => new Response('{}', { status: 200 }))
    const provider = createTelnyxProvider({
      apiKey: 'KEY123',
      accountSid: 'ACC456',
      appId: 'APP789',
      fetchImpl: impl,
    })

    await expect(provider.startCall(CALL_ARGS)).resolves.toEqual({ ok: true })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/texml/Accounts/ACC456/Calls')
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('authorization')).toBe('Bearer KEY123')
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')

    const body = new URLSearchParams(String(calls[0].init.body))
    expect(Object.fromEntries(body)).toEqual({
      To: CALL_ARGS.to,
      From: CALL_ARGS.from,
      ApplicationSid: 'APP789',
      Url: CALL_ARGS.url,
      StatusCallback: CALL_ARGS.statusCallback,
      StatusCallbackEvent: 'completed',
      Timeout: '25',
    })
  })

  it('codifica el accountSid en la ruta', async () => {
    const { impl, calls } = fakeFetch(() => new Response('{}', { status: 200 }))
    await createTelnyxProvider({ apiKey: 'k', accountSid: 'a/b c', appId: 'x', fetchImpl: impl }).startCall(CALL_ARGS)
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/texml/Accounts/a%2Fb%20c/Calls')
  })

  it('si Telnyx rechaza, devuelve el error sin el teléfono ni datos del cuerpo', async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            errors: [
              {
                code: '10015',
                title: 'Invalid parameter',
                detail: 'The destination number +573001234567 is not allowed',
              },
            ],
          }),
          { status: 400 },
        ),
    )
    const result = await createTelnyxProvider({ apiKey: 'k', accountSid: 'a', appId: 'x', fetchImpl: impl }).startCall(
      CALL_ARGS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Telnyx rechazó la llamada (400): 10015 Invalid parameter')
    expect(result.error).not.toMatch(/\d{6,}/)
    expect(result.error).not.toContain('573001234567')
  })

  it('un cuerpo que no es JSON solo deja el código HTTP', async () => {
    const { impl } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }))
    const result = await createTelnyxProvider({ apiKey: 'k', accountSid: 'a', appId: 'x', fetchImpl: impl }).startCall(
      CALL_ARGS,
    )
    expect(result).toEqual({ ok: false, error: 'Telnyx rechazó la llamada (502)' })
  })

  it('tapa cualquier número largo que venga en el título del error', async () => {
    const { impl } = fakeFetch(
      () => new Response(JSON.stringify({ errors: [{ code: '1', title: 'Bad number 573001234567' }] }), { status: 422 }),
    )
    const result = await createTelnyxProvider({ apiKey: 'k', accountSid: 'a', appId: 'x', fetchImpl: impl }).startCall(
      CALL_ARGS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).not.toMatch(/\d{6,}/)
  })

  it('un fallo de red devuelve un mensaje fijo, sin el texto del error', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND +573001234567')
    }) as unknown as typeof fetch
    const result = await createTelnyxProvider({ apiKey: 'k', accountSid: 'a', appId: 'x', fetchImpl: impl }).startCall(
      CALL_ARGS,
    )
    expect(result).toEqual({ ok: false, error: 'No se pudo contactar a Telnyx' })
  })

  it('corta a los 10 segundos', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const impl = ((_input: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch

    const pending = createTelnyxProvider({ apiKey: 'k', accountSid: 'a', appId: 'x', fetchImpl: impl }).startCall(
      CALL_ARGS,
    )
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await expect(pending).resolves.toEqual({ ok: false, error: 'Telnyx tardó más de 10 segundos en responder' })
    expect(signal?.aborted).toBe(true)
  })
})

// ------------------------------------------------------------
// Firma
// ------------------------------------------------------------

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // El SPKI de Ed25519 son 12 bytes de prefijo y luego los 32 de la clave.
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  return { privateKey, publicKeyB64: raw.toString('base64') }
}

function signed(privateKey: KeyObject, timestamp: string, body: string): string {
  return sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64')
}

describe('verifyTelnyxSignature', () => {
  const NOW = 1_800_000_000
  const BODY = 'CallSid=abc&From=%2B573001234567&To=%2B576015550000'

  it('acepta una firma válida', () => {
    const { privateKey, publicKeyB64 } = keyPair()
    const timestamp = String(NOW)
    expect(
      verifyTelnyxSignature({
        rawBody: BODY,
        signature: signed(privateKey, timestamp, BODY),
        timestamp,
        publicKeyB64,
        nowSec: NOW,
      }),
    ).toBe(true)
  })

  it('rechaza si cambió el cuerpo, el timestamp o la clave', () => {
    const { privateKey, publicKeyB64 } = keyPair()
    const timestamp = String(NOW)
    const signature = signed(privateKey, timestamp, BODY)
    const base = { rawBody: BODY, signature, timestamp, publicKeyB64, nowSec: NOW }

    expect(verifyTelnyxSignature(base)).toBe(true)
    expect(verifyTelnyxSignature({ ...base, rawBody: `${BODY}&Digits=1` })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, timestamp: String(NOW + 1) })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, publicKeyB64: keyPair().publicKeyB64 })).toBe(false)
  })

  it('tolera 5 minutos, pero ni un segundo más (pasado o futuro)', () => {
    const { privateKey, publicKeyB64 } = keyPair()
    const check = (age: number) => {
      const timestamp = String(NOW - age)
      return verifyTelnyxSignature({
        rawBody: BODY,
        signature: signed(privateKey, timestamp, BODY),
        timestamp,
        publicKeyB64,
        nowSec: NOW,
      })
    }
    expect(check(300)).toBe(true)
    expect(check(301)).toBe(false)
    expect(check(-300)).toBe(true)
    expect(check(-301)).toBe(false)
  })

  it('rechaza lo que falta o viene dañado, sin lanzar', () => {
    const { privateKey, publicKeyB64 } = keyPair()
    const timestamp = String(NOW)
    const signature = signed(privateKey, timestamp, BODY)
    const base = { rawBody: BODY, signature, timestamp, publicKeyB64, nowSec: NOW }

    expect(verifyTelnyxSignature({ ...base, signature: null })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, signature: '' })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, signature: 'no-es-base64-!!' })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, signature: signature.slice(0, 20) })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, timestamp: null })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, timestamp: 'ayer' })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, timestamp: '1e9' })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, publicKeyB64: undefined })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, publicKeyB64: '' })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, publicKeyB64: 'AAAA' })).toBe(false)
    expect(verifyTelnyxSignature({ ...base, nowSec: Number.NaN })).toBe(false)
  })
})

// ------------------------------------------------------------
// Formulario
// ------------------------------------------------------------

describe('parseForm', () => {
  it('lee un formulario de Telnyx', () => {
    expect(parseForm('CallSid=v3%3Aabc&From=%2B573001234567&To=%2B576015550000&Digits=1')).toEqual({
      CallSid: 'v3:abc',
      From: '+573001234567',
      To: '+576015550000',
      Digits: '1',
    })
  })

  it('vacío, valores vacíos, "+" como espacio y claves repetidas (gana la última)', () => {
    expect(parseForm('')).toEqual({})
    expect(parseForm('Digits=&a=b+c&a=d')).toEqual({ Digits: '', a: 'd' })
  })

  it('una clave peligrosa no toca el prototipo', () => {
    const form = parseForm('__proto__=x&constructor=y')
    expect(Object.getPrototypeOf(form)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})

// ------------------------------------------------------------
// Variables de entorno
// ------------------------------------------------------------

describe('readTelnyxConfig', () => {
  const FULL = {
    TELNYX_API_KEY: 'k',
    TELNYX_ACCOUNT_SID: 'a',
    TELNYX_TEXML_APP_ID: 'x',
    TELNYX_PUBLIC_KEY: 'p',
    VOICE_WEBHOOK_SECRET: 's',
    NEXT_PUBLIC_APP_URL: 'https://crm.example.test',
  }

  it('con todo puesto devuelve las credenciales', () => {
    expect(readTelnyxConfig(FULL)).toEqual({
      ok: true,
      config: { apiKey: 'k', accountSid: 'a', appId: 'x', publicKey: 'p' },
    })
  })

  it('lista exactamente lo que falta, y un valor en blanco cuenta como falta', () => {
    expect(readTelnyxConfig({ ...FULL, TELNYX_API_KEY: '', TELNYX_PUBLIC_KEY: '   ' })).toEqual({
      ok: false,
      missing: ['TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY'],
    })
    expect(readTelnyxConfig({})).toEqual({
      ok: false,
      missing: [
        'TELNYX_API_KEY',
        'TELNYX_ACCOUNT_SID',
        'TELNYX_TEXML_APP_ID',
        'TELNYX_PUBLIC_KEY',
        'VOICE_WEBHOOK_SECRET',
        'NEXT_PUBLIC_APP_URL',
      ],
    })
  })
})
