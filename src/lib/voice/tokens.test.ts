import { createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkVoiceToken, isVoiceTokenConfigured, voiceToken, voiceUrl } from './tokens'

const SECRET = 'secreto-de-prueba-voz'

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('voiceToken', () => {
  it('es el HMAC-SHA256 del sujeto en base64url', () => {
    const expected = createHmac('sha256', SECRET).update('call-1').digest('base64url')
    expect(voiceToken('call-1')).toBe(expected)
    expect(voiceToken('call-1')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('cambia con el sujeto y con el secreto', () => {
    const a = voiceToken('call-1')
    expect(voiceToken('call-2')).not.toBe(a)
    vi.stubEnv('VOICE_WEBHOOK_SECRET', 'otro')
    expect(voiceToken('call-1')).not.toBe(a)
  })

  it('sin secreto lanza: nunca firma con una llave vacía', () => {
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    expect(() => voiceToken('call-1')).toThrow(/VOICE_WEBHOOK_SECRET/)
  })
})

describe('checkVoiceToken', () => {
  it('acepta el token correcto del mismo sujeto', () => {
    expect(checkVoiceToken('call-1', voiceToken('call-1'))).toBe(true)
    expect(checkVoiceToken('inbound', voiceToken('inbound'))).toBe(true)
  })

  it('rechaza el token de otro sujeto, uno alterado, uno corto o vacío', () => {
    const token = voiceToken('call-1')
    expect(checkVoiceToken('call-2', token)).toBe(false)
    expect(checkVoiceToken('call-1', `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`)).toBe(false)
    expect(checkVoiceToken('call-1', token.slice(0, 10))).toBe(false)
    expect(checkVoiceToken('call-1', `${token}extra`)).toBe(false)
    expect(checkVoiceToken('call-1', '')).toBe(false)
    expect(checkVoiceToken('call-1', null)).toBe(false)
    expect(checkVoiceToken('call-1', undefined)).toBe(false)
  })

  it('sin secreto siempre es falso, aunque el token "coincida" con una llave vacía', () => {
    const forged = createHmac('sha256', '').update('call-1').digest('base64url')
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    expect(checkVoiceToken('call-1', forged)).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '   ')
    expect(checkVoiceToken('call-1', forged)).toBe(false)
  })
})

describe('isVoiceTokenConfigured', () => {
  it('depende de que haya secreto', () => {
    expect(isVoiceTokenConfigured()).toBe(true)
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    expect(isVoiceTokenConfigured()).toBe(false)
  })
})

describe('voiceUrl', () => {
  it('junta la base sin barra final, la ruta, los parámetros y el token de la llamada', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test///')
    const url = new URL(voiceUrl('/api/voice/telnyx/outbound', { call: 'abc', step: 'menu' }))
    expect(url.origin).toBe('https://crm.example.test')
    expect(url.pathname).toBe('/api/voice/telnyx/outbound')
    expect(url.searchParams.get('call')).toBe('abc')
    expect(url.searchParams.get('step')).toBe('menu')
    expect(url.searchParams.get('t')).toBe(voiceToken('abc'))
  })

  it('sin `call` el token es el de "inbound"', () => {
    const url = new URL(voiceUrl('/api/voice/telnyx/inbound', {}))
    expect(url.searchParams.get('t')).toBe(voiceToken('inbound'))
    expect([...url.searchParams.keys()]).toEqual(['t'])
  })

  it('el sujeto puede darse aparte', () => {
    const url = new URL(voiceUrl('/api/voice/telnyx/status', { call: 'abc' }, 'inbound'))
    expect(url.searchParams.get('t')).toBe(voiceToken('inbound'))
  })

  it('acepta números, deja fuera los indefinidos y escapa lo que lo necesite', () => {
    const url = voiceUrl('/x', { call: 'a b', loop: 1, step: undefined })
    expect(url).toContain('call=a+b')
    expect(url).toContain('loop=1')
    expect(url).not.toContain('step')
  })

  it('una ruta sin barra inicial también funciona', () => {
    expect(voiceUrl('api/voice/x', { call: 'a' }).startsWith('https://crm.example.test/api/voice/x?')).toBe(true)
  })

  it('un parámetro `t` pasado a mano no pisa el token', () => {
    const url = new URL(voiceUrl('/x', { call: 'a', t: 'falso' }))
    expect(url.searchParams.getAll('t')).toEqual([voiceToken('a')])
  })

  it('lanza si falta la URL pública o el secreto', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(() => voiceUrl('/x', { call: 'a' })).toThrow(/NEXT_PUBLIC_APP_URL/)
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test')
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    expect(() => voiceUrl('/x', { call: 'a' })).toThrow(/VOICE_WEBHOOK_SECRET/)
  })
})
