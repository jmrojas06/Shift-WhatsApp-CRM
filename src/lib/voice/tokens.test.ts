import { createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkVoiceToken, isVoiceTokenConfigured, publicBaseUrl, voiceToken, voiceUrl } from './tokens'

const SECRET = 'secreto-de-prueba-voz'

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', SECRET)
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
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

  it('sin parámetros de estado es el HMAC del sujeto solo (el `t` fijo de la URL entrante no cambia)', () => {
    const expected = createHmac('sha256', SECRET).update('inbound').digest('base64url')
    expect(voiceToken('inbound')).toBe(expected)
    expect(voiceToken('inbound', {})).toBe(expected)
    expect(voiceToken('inbound', new URLSearchParams())).toBe(expected)
  })

  it('el `t` de la URL de estado entrante (`…/status?inbound=1`) se puede generar con un comando de una línea', () => {
    // node -e "console.log(require('crypto').createHmac('sha256', process.argv[1]).update(JSON.stringify(['inbound', [['inbound','1']]])).digest('base64url'))" "<secreto>"
    const byHand = createHmac('sha256', SECRET)
      .update(JSON.stringify(['inbound', [['inbound', '1']]]))
      .digest('base64url')
    expect(voiceToken('inbound', { inbound: '1' })).toBe(byHand)
    expect(voiceToken('inbound', new URLSearchParams('inbound=1'))).toBe(byHand)
  })

  it('con parámetros de estado firma también el paso, la vuelta, el camino y la cita', () => {
    const base = voiceToken('call-1', { call: 'call-1', step: 'menu', loop: 1 })
    expect(base).not.toBe(voiceToken('call-1'))
    expect(voiceToken('call-1', { call: 'call-1', step: 'cancel', loop: 1 })).not.toBe(base)
    expect(voiceToken('call-1', { call: 'call-1', step: 'menu', loop: 2 })).not.toBe(base)
    expect(voiceToken('call-1', { call: 'call-1', step: 'menu', loop: 1, path: '2' })).not.toBe(base)
    expect(voiceToken('call-1', { call: 'call-1', step: 'menu', loop: 1, appt: 'a' })).not.toBe(base)
  })

  it('el orden de los parámetros no cambia el token; un `t` y los vacíos no cuentan', () => {
    const a = voiceToken('c', { call: 'c', step: 'menu', loop: 1 })
    expect(voiceToken('c', { loop: 1, step: 'menu', call: 'c' })).toBe(a)
    expect(voiceToken('c', { loop: '1', call: 'c', step: 'menu', path: undefined, appt: null, t: 'x' })).toBe(a)
    expect(voiceToken('c', new URLSearchParams('loop=1&t=falso&step=menu&call=c'))).toBe(a)
  })

  it('no se confunde un valor con otra combinación de parámetros', () => {
    expect(voiceToken('c', { a: 'b&c=d' })).not.toBe(voiceToken('c', { a: 'b', c: 'd' }))
    expect(voiceToken('c', { a: '1', b: '2' })).not.toBe(voiceToken('c', { a: '12' }))
  })

  it('un parámetro repetido en la URL también cuenta (no se cuela un segundo `step`)', () => {
    const once = voiceToken('c', new URLSearchParams('call=c&step=menu'))
    expect(voiceToken('c', new URLSearchParams('call=c&step=menu&step=cancel'))).not.toBe(once)
  })
})

describe('checkVoiceToken', () => {
  it('acepta el token correcto del mismo sujeto', () => {
    expect(checkVoiceToken('call-1', voiceToken('call-1'), {})).toBe(true)
    expect(checkVoiceToken('inbound', voiceToken('inbound'), {})).toBe(true)
  })

  it('acepta el token del mismo sujeto con los mismos parámetros, en cualquier orden y con `t` aparte', () => {
    const query = new URLSearchParams({ call: 'call-1', step: 'cancel', loop: '2', path: '2', appt: 'abc' })
    const t = voiceToken('call-1', query)
    query.set('t', t)
    expect(checkVoiceToken('call-1', t, query)).toBe(true)
    const shuffled = new URLSearchParams(`t=${t}&appt=abc&path=2&loop=2&step=cancel&call=call-1`)
    expect(checkVoiceToken('call-1', t, shuffled)).toBe(true)
  })

  it('un token válido NO sirve para otro paso, otra vuelta, otro camino ni otra cita', () => {
    const t = voiceToken('call-1', { call: 'call-1', step: 'menu', loop: 1 })
    const same = { call: 'call-1', step: 'menu', loop: '1' }
    expect(checkVoiceToken('call-1', t, same)).toBe(true)
    expect(checkVoiceToken('call-1', t, { ...same, step: 'appt' })).toBe(false)
    expect(checkVoiceToken('call-1', t, { ...same, loop: '3' })).toBe(false)
    expect(checkVoiceToken('call-1', t, { ...same, path: '2>1' })).toBe(false)
    expect(checkVoiceToken('call-1', t, { ...same, appt: '77777777-7777-4777-8777-777777777777' })).toBe(false)
    expect(checkVoiceToken('call-1', t, { call: 'call-1', step: 'menu' })).toBe(false)
    expect(checkVoiceToken('call-1', t, new URLSearchParams('call=call-1&step=menu&loop=1&step=cancel'))).toBe(false)
  })

  it('un token sin parámetros no vale para una URL que trae estado', () => {
    expect(checkVoiceToken('call-1', voiceToken('call-1'), { call: 'call-1', step: 'cancel' })).toBe(false)
  })

  it('rechaza el token de otro sujeto, uno alterado, uno corto o vacío', () => {
    const token = voiceToken('call-1')
    expect(checkVoiceToken('call-2', token, {})).toBe(false)
    expect(checkVoiceToken('call-1', `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, {})).toBe(false)
    expect(checkVoiceToken('call-1', token.slice(0, 10), {})).toBe(false)
    expect(checkVoiceToken('call-1', `${token}extra`, {})).toBe(false)
    expect(checkVoiceToken('call-1', '', {})).toBe(false)
    expect(checkVoiceToken('call-1', null, {})).toBe(false)
    expect(checkVoiceToken('call-1', undefined, {})).toBe(false)
  })

  it('sin secreto siempre es falso, aunque el token "coincida" con una llave vacía', () => {
    const forged = createHmac('sha256', '').update('call-1').digest('base64url')
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    expect(checkVoiceToken('call-1', forged, {})).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '   ')
    expect(checkVoiceToken('call-1', forged, {})).toBe(false)
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
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test///')
    const url = new URL(voiceUrl('/api/voice/telnyx/outbound', { call: 'abc', step: 'menu' }))
    expect(url.origin).toBe('https://crm.example.test')
    expect(url.pathname).toBe('/api/voice/telnyx/outbound')
    expect(url.searchParams.get('call')).toBe('abc')
    expect(url.searchParams.get('step')).toBe('menu')
    expect(url.searchParams.get('t')).toBe(voiceToken('abc', { call: 'abc', step: 'menu' }))
    expect(checkVoiceToken('abc', url.searchParams.get('t'), url.searchParams)).toBe(true)
  })

  it('firma el estado: cambiar el paso o la cita de la URL la invalida', () => {
    const url = new URL(voiceUrl('/api/voice/telnyx/inbound', { call: 'abc', step: 'appt', loop: 1, appt: 'cita-1' }))
    const t = url.searchParams.get('t')
    expect(checkVoiceToken('abc', t, url.searchParams)).toBe(true)

    const otherAppointment = new URLSearchParams(url.searchParams)
    otherAppointment.set('appt', 'cita-ajena')
    expect(checkVoiceToken('abc', t, otherAppointment)).toBe(false)

    const otherStep = new URLSearchParams(url.searchParams)
    otherStep.set('step', 'cancel')
    expect(checkVoiceToken('abc', t, otherStep)).toBe(false)
  })

  it('sin `call` el token es el de "inbound"', () => {
    const url = new URL(voiceUrl('/api/voice/telnyx/inbound', {}))
    expect(url.searchParams.get('t')).toBe(voiceToken('inbound'))
    expect([...url.searchParams.keys()]).toEqual(['t'])
  })

  it('el sujeto puede darse aparte', () => {
    const url = new URL(voiceUrl('/api/voice/telnyx/status', { call: 'abc' }, 'inbound'))
    expect(url.searchParams.get('t')).toBe(voiceToken('inbound', { call: 'abc' }))
    expect(checkVoiceToken('inbound', url.searchParams.get('t'), url.searchParams)).toBe(true)
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
    expect(url.searchParams.getAll('t')).toEqual([voiceToken('a', { call: 'a' })])
  })

  it('lanza si falta la URL pública o el secreto', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    expect(() => voiceUrl('/x', { call: 'a' })).toThrow(/NEXT_PUBLIC_SITE_URL/)
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.test')
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    expect(() => voiceUrl('/x', { call: 'a' })).toThrow(/VOICE_WEBHOOK_SECRET/)
  })

  it('usa NEXT_PUBLIC_SITE_URL y, si no está, NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://sitio.example.test')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test')
    expect(voiceUrl('/x', { call: 'a' }).startsWith('https://sitio.example.test/x?')).toBe(true)

    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '   ')
    expect(voiceUrl('/x', { call: 'a' }).startsWith('https://app.example.test/x?')).toBe(true)

    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(() => voiceUrl('/x', { call: 'a' })).toThrow(/NEXT_PUBLIC_SITE_URL/)
  })
})

describe('publicBaseUrl', () => {
  it('prefiere NEXT_PUBLIC_SITE_URL, cae a NEXT_PUBLIC_APP_URL y quita las barras finales', () => {
    expect(publicBaseUrl({ NEXT_PUBLIC_SITE_URL: ' https://a.test// ', NEXT_PUBLIC_APP_URL: 'https://b.test' })).toBe(
      'https://a.test',
    )
    expect(publicBaseUrl({ NEXT_PUBLIC_APP_URL: 'https://b.test/' })).toBe('https://b.test')
    expect(publicBaseUrl({ NEXT_PUBLIC_SITE_URL: '/', NEXT_PUBLIC_APP_URL: 'https://b.test' })).toBe('https://b.test')
    expect(publicBaseUrl({})).toBeNull()
  })
})
