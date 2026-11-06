import { generateKeyPairSync, sign } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { voiceToken } from './tokens'
import { readVoiceWebhook, texmlResponse } from './webhook'

// ============================================================
// Lo común de los webhooks de voz: leer el cuerpo una sola vez, exigir el
// token `t` siempre y la firma de Telnyx cuando llegan sus cabeceras.
// ============================================================

const SECRET = 'secreto-de-prueba-voz'
const CALL = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-11-05T15:00:00.000Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)

const keys = generateKeyPairSync('ed25519')
/** La clave pública cruda de 32 bytes en base64, como la entrega Telnyx. */
const PUBLIC_KEY_B64 = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')

function signature(body: string, timestamp = String(NOW_SEC)): string {
  return sign(null, Buffer.from(`${timestamp}|${body}`), keys.privateKey).toString('base64')
}

function post(options: {
  query?: Record<string, string>
  body?: string
  headers?: Record<string, string>
}): Request {
  const query = new URLSearchParams(options.query ?? {})
  return new Request(`https://crm.example.test/api/voice/telnyx/outbound?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers },
    body: options.body ?? 'CallSid=CA1&Digits=1',
  })
}

const bySubject = (query: URLSearchParams) => query.get('call')

/** La query tal como la arma `voiceUrl`: el token firma el sujeto y todos los demás parámetros. */
const signed = (query: Record<string, string>): Record<string, string> => ({
  ...query,
  t: voiceToken(query.call ?? 'inbound', query),
})

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
  vi.stubEnv('TELNYX_PUBLIC_KEY', PUBLIC_KEY_B64)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('texmlResponse', () => {
  it('responde con Content-Type text/xml y el estado pedido', async () => {
    const res = texmlResponse('<Response/>')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(await res.text()).toBe('<Response/>')
    expect(texmlResponse('<Response/>', 500).status).toBe(500)
  })
})

describe('readVoiceWebhook — el token t', () => {
  it('acepta un token válido y entrega la query y el formulario', async () => {
    const result = await readVoiceWebhook(
      post({ query: signed({ call: CALL, step: 'menu' }), body: 'CallSid=CA1&Digits=2' }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.webhook.query.get('step')).toBe('menu')
    expect(result.webhook.form).toEqual({ CallSid: 'CA1', Digits: '2' })
    expect(result.webhook.rawBody).toBe('CallSid=CA1&Digits=2')
  })

  it('403 sin t', async () => {
    const result = await readVoiceWebhook(post({ query: { call: CALL } }), { subject: bySubject, nowSec: NOW_SEC })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('403 con un t que no es de esa llamada', async () => {
    const result = await readVoiceWebhook(
      post({ query: { call: CALL, t: voiceToken('otra-llamada') } }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('403 si se cambió el paso, la vuelta, el camino o la cita de una URL firmada', async () => {
    const original = signed({ call: CALL, step: 'menu', loop: '1' })
    const tampered: Record<string, string>[] = [
      { ...original, step: 'cancel' },
      { ...original, loop: '3' },
      { ...original, path: '2>1' },
      { ...original, appt: '77777777-7777-4777-8777-777777777777' },
    ]
    for (const query of tampered) {
      const result = await readVoiceWebhook(post({ query }), { subject: bySubject, nowSec: NOW_SEC })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.response.status).toBe(403)
    }
    const untouched = await readVoiceWebhook(post({ query: original }), { subject: bySubject, nowSec: NOW_SEC })
    expect(untouched.ok).toBe(true)
  })

  it('403 si se agrega un segundo `step` a una URL firmada', async () => {
    const original = signed({ call: CALL, step: 'menu', loop: '1' })
    const request = new Request(
      `https://crm.example.test/api/voice/telnyx/outbound?${new URLSearchParams(original)}&step=cancel`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'CallSid=CA1' },
    )
    const result = await readVoiceWebhook(request, { subject: bySubject, nowSec: NOW_SEC })
    expect(result.ok).toBe(false)
  })

  it('403 si no hay de qué llamada se trata', async () => {
    const result = await readVoiceWebhook(post({ query: signed({ step: 'menu' }) }), {
      subject: bySubject,
      nowSec: NOW_SEC,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('403 sin VOICE_WEBHOOK_SECRET aunque venga un t', async () => {
    const token = voiceToken(CALL)
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    const result = await readVoiceWebhook(post({ query: { call: CALL, t: token } }), {
      subject: bySubject,
      nowSec: NOW_SEC,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('lee el cuerpo una sola vez', async () => {
    const request = post({ query: { call: CALL, t: voiceToken(CALL) } })
    const spy = vi.spyOn(request, 'text')
    await readVoiceWebhook(request, { subject: bySubject, nowSec: NOW_SEC })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('readVoiceWebhook — la firma de Telnyx', () => {
  const query = () => signed({ call: CALL })

  it('sin cabeceras de firma basta el token', async () => {
    const result = await readVoiceWebhook(post({ query: query() }), { subject: bySubject, nowSec: NOW_SEC })
    expect(result.ok).toBe(true)
  })

  it('con cabeceras y firma válida pasa', async () => {
    const body = 'CallSid=CA1&Digits=1'
    const result = await readVoiceWebhook(
      post({
        query: query(),
        body,
        headers: { 'telnyx-signature-ed25519': signature(body), 'telnyx-timestamp': String(NOW_SEC) },
      }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(true)
  })

  it('403 si la firma no cuadra con el cuerpo', async () => {
    const result = await readVoiceWebhook(
      post({
        query: query(),
        body: 'CallSid=CA1&Digits=1',
        headers: {
          'telnyx-signature-ed25519': signature('CallSid=CA1&Digits=2'),
          'telnyx-timestamp': String(NOW_SEC),
        },
      }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('403 si la firma es vieja (más de 5 minutos)', async () => {
    const body = 'CallSid=CA1'
    const old = String(NOW_SEC - 10 * 60)
    const result = await readVoiceWebhook(
      post({ query: query(), body, headers: { 'telnyx-signature-ed25519': signature(body, old), 'telnyx-timestamp': old } }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('403 si llega solo una de las dos cabeceras', async () => {
    const result = await readVoiceWebhook(
      post({ query: query(), headers: { 'telnyx-signature-ed25519': signature('CallSid=CA1&Digits=1') } }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('403 si llegan las cabeceras pero no hay clave pública configurada', async () => {
    vi.stubEnv('TELNYX_PUBLIC_KEY', '')
    const body = 'CallSid=CA1&Digits=1'
    const result = await readVoiceWebhook(
      post({
        query: query(),
        body,
        headers: { 'telnyx-signature-ed25519': signature(body), 'telnyx-timestamp': String(NOW_SEC) },
      }),
      { subject: bySubject, nowSec: NOW_SEC },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.response.status).toBe(403)
  })

  it('el cuerpo del 403 no repite nada del pedido', async () => {
    const result = await readVoiceWebhook(post({ query: { call: CALL }, body: 'From=%2B573001234567' }), {
      subject: bySubject,
      nowSec: NOW_SEC,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const text = await result.response.text()
    expect(text).not.toContain('573001234567')
    expect(text).not.toContain(CALL)
  })
})
