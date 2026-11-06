import { afterEach, describe, expect, it, vi } from 'vitest'

import { callSettingsApi } from './api'
import { CALLS_TEXTS } from './calls-texts'

// ============================================================
// Cliente HTTP de la tarjeta "Llamadas": forma de cada request y errores.
// ============================================================

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('sin JSON')
      return body
    },
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

function lastCall(spy: ReturnType<typeof stubFetch>): [string, RequestInit] {
  const calls = spy.mock.calls as unknown as [string, RequestInit][]
  return calls[calls.length - 1]
}

describe('callSettingsApi', () => {
  it('get pide la configuración por GET, sin cuerpo', async () => {
    const spy = stubFetch(200, { settings: {}, usage: { month: '2026-11', used: 0 }, telnyx: { configured: false } })

    const res = await callSettingsApi.get()

    expect(res.ok).toBe(true)
    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/verticals/agenda/call-settings')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  it('get con un fallo sin cuerpo usa el mensaje de carga', async () => {
    stubFetch(500, undefined)

    expect(await callSettingsApi.get()).toEqual({ ok: false, error: CALLS_TEXTS.loadFailed })
  })

  it('save manda por PATCH solo el parche recibido', async () => {
    const spy = stubFetch(200, { settings: {}, usage: {}, telnyx: {} })

    await callSettingsApi.save({ call_saturday: false })

    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/verticals/agenda/call-settings')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ call_saturday: false })
  })

  it('save deja pasar el mensaje del servidor y, sin él, usa el de guardado', async () => {
    stubFetch(409, { error: 'Falta un paso de Shift.' })
    expect(await callSettingsApi.save({ outbound_enabled: true })).toEqual({
      ok: false,
      error: 'Falta un paso de Shift.',
    })

    stubFetch(500, undefined)
    expect(await callSettingsApi.save({ outbound_enabled: true })).toEqual({
      ok: false,
      error: CALLS_TEXTS.saveFailed,
    })
  })

  it('test llama a la ruta de prueba con el número', async () => {
    const spy = stubFetch(200, { ok: true })

    const res = await callSettingsApi.test('+573001234567')

    expect(res.ok).toBe(true)
    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/verticals/agenda/calls/test')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ to: '+573001234567' })
  })

  it('test muestra el error de la ruta y, si no hay, el de prueba fallida', async () => {
    stubFetch(502, { error: 'Telnyx rechazó la llamada (400).' })
    expect(await callSettingsApi.test('+573001234567')).toEqual({
      ok: false,
      error: 'Telnyx rechazó la llamada (400).',
    })

    stubFetch(404, undefined)
    expect(await callSettingsApi.test('+573001234567')).toEqual({
      ok: false,
      error: CALLS_TEXTS.testFailed,
    })
  })
})
