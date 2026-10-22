import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'

// ============================================================
// Cliente HTTP de Configuración — contrato con las secciones.
//
// La sección de horario solo muestra "Guardado" cuando `ok` es true
// (schedule-section.tsx: `if (!res.ok) { setError(...); return }`).
// Aquí se fija que un 500 del servidor (p. ej. falló borrar los
// bloques viejos) llegue como `ok: false` con un mensaje visible.
// ============================================================

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error('sin JSON')
        return body
      },
    })),
  )
}

describe('agendaConfigApi.saveHours', () => {
  it('un 500 del servidor llega como error con su mensaje, no como guardado', async () => {
    stubFetch(500, { error: 'Error interno.' })

    const res = await agendaConfigApi.saveHours('st-1', [
      { weekday: 1, start_time: '09:00', end_time: '12:00' },
    ])

    expect(res).toEqual({ ok: false, error: 'Error interno.' })
  })

  it('un 500 sin cuerpo JSON usa el mensaje genérico de guardado fallido', async () => {
    stubFetch(500, undefined)

    const res = await agendaConfigApi.saveHours('st-1', [])

    expect(res).toEqual({ ok: false, error: T.config.saveFailed })
  })

  it('un 200 sí es guardado', async () => {
    stubFetch(200, { ok: true, count: 1 })

    const res = await agendaConfigApi.saveHours('st-1', [
      { weekday: 1, start_time: '09:00', end_time: '12:00' },
    ])

    expect(res.ok).toBe(true)
  })
})

// ============================================================
// Tipo de negocio, piezas, palabras y preguntas: forma de cada request.
// ============================================================

function stubFetchSpy(status: number, body: unknown) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

function lastCall(spy: ReturnType<typeof stubFetchSpy>): [string, RequestInit] {
  const calls = spy.mock.calls as unknown as [string, RequestInit][]
  return calls[calls.length - 1]
}

describe('agendaConfigApi.installPreset', () => {
  it('cambia el tipo de negocio solo por POST /setup con preset_key', async () => {
    const spy = stubFetchSpy(200, { report: { presetKey: 'salud' } })

    const res = await agendaConfigApi.installPreset('salud')

    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/verticals/agenda/setup')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ preset_key: 'salud' })
    expect(res.ok).toBe(true)
  })

  it('sin clave reinstala el de la cuenta: no manda cuerpo', async () => {
    const spy = stubFetchSpy(200, { report: { presetKey: 'barberia' } })

    await agendaConfigApi.installPreset()

    const [, init] = lastCall(spy)
    expect(init.body).toBeUndefined()
  })

  it('un error del servidor llega con su mensaje', async () => {
    stubFetchSpy(409, { error: 'El módulo de agenda no está habilitado para esta cuenta.' })

    expect(await agendaConfigApi.installPreset('blanco')).toEqual({
      ok: false,
      error: 'El módulo de agenda no está habilitado para esta cuenta.',
    })
  })
})

describe('agendaConfigApi.patchConfig (palabras y piezas)', () => {
  it('manda las palabras y una pieza por columna', async () => {
    const spy = stubFetchSpy(200, { settings: null, currency: null })

    await agendaConfigApi.patchConfig({
      labels: {
        profesional: 'doctor',
        profesionales: '',
        servicio: '',
        servicios: '',
        cita: '',
        citas: '',
      },
    })
    expect(JSON.parse(lastCall(spy)[1].body as string).labels.profesionales).toBe('')

    await agendaConfigApi.patchConfig({ toggles: { choose_staff: false } })
    const [url, init] = lastCall(spy)
    expect(url).toBe('/api/verticals/agenda/config')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ toggles: { choose_staff: false } })
  })

  it('un 400 de validación conserva el mensaje del servidor', async () => {
    stubFetchSpy(400, { error: '"cita" no puede pasar de 24 caracteres.' })

    expect(await agendaConfigApi.patchConfig({ toggles: { show_price: true } })).toEqual({
      ok: false,
      error: '"cita" no puede pasar de 24 caracteres.',
    })
  })
})

describe('agendaConfigApi preguntas', () => {
  const body = { label: 'Placa', kind: 'texto' as const, required: true, options: [] }

  it('crear es POST, editar es PATCH con la definición completa y quitar es DELETE', async () => {
    const spy = stubFetchSpy(200, { question: { id: 'q1', ...body }, ok: true })

    await agendaConfigApi.createQuestion(body)
    expect(lastCall(spy)[0]).toBe('/api/verticals/agenda/questions')
    expect(lastCall(spy)[1].method).toBe('POST')

    await agendaConfigApi.updateQuestion('q1', body)
    expect(lastCall(spy)[0]).toBe('/api/verticals/agenda/questions/q1')
    expect(lastCall(spy)[1].method).toBe('PATCH')
    expect(JSON.parse(lastCall(spy)[1].body as string)).toEqual(body)

    await agendaConfigApi.deleteQuestion('q1')
    expect(lastCall(spy)[0]).toBe('/api/verticals/agenda/questions/q1')
    expect(lastCall(spy)[1].method).toBe('DELETE')
    expect(lastCall(spy)[1].body).toBeUndefined()
  })

  it('el tope de 5 preguntas llega como error con su mensaje', async () => {
    stubFetchSpy(409, { error: 'Ya tienes 5 preguntas.', code: 'limit_reached' })

    expect(await agendaConfigApi.createQuestion(body)).toEqual({
      ok: false,
      error: 'Ya tienes 5 preguntas.',
    })
  })
})
