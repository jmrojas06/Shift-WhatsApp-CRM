import { afterEach, describe, expect, it, vi } from 'vitest'

import { BARBERIA_TEXTS as T } from '@/verticals/barberia/texts'

import { barberiaConfigApi } from './api'

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

describe('barberiaConfigApi.saveHours', () => {
  it('un 500 del servidor llega como error con su mensaje, no como guardado', async () => {
    stubFetch(500, { error: 'Error interno.' })

    const res = await barberiaConfigApi.saveHours('st-1', [
      { weekday: 1, start_time: '09:00', end_time: '12:00' },
    ])

    expect(res).toEqual({ ok: false, error: 'Error interno.' })
  })

  it('un 500 sin cuerpo JSON usa el mensaje genérico de guardado fallido', async () => {
    stubFetch(500, undefined)

    const res = await barberiaConfigApi.saveHours('st-1', [])

    expect(res).toEqual({ ok: false, error: T.config.saveFailed })
  })

  it('un 200 sí es guardado', async () => {
    stubFetch(200, { ok: true, count: 1 })

    const res = await barberiaConfigApi.saveHours('st-1', [
      { weekday: 1, start_time: '09:00', end_time: '12:00' },
    ])

    expect(res.ok).toBe(true)
  })
})
