import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_LABELS } from '../labels'
import { DEFAULT_TOGGLES } from '../toggles'
import { ANSWERS_MAX_BYTES } from '../questions'
import { insertAppointment, loadAppointment, loadBotSettings } from './db'

/** Cliente mínimo: solo la cadena que usa loadBotSettings. */
function stubClient(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => result }),
      }),
    }),
  } as unknown as SupabaseClient
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadBotSettings', () => {
  it('si la lectura falla (p. ej. migración sin aplicar) avisa en el log y cae a los defaults', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const settings = await loadBotSettings(
      stubClient({ data: null, error: { code: '42703', message: 'column booking_settings.labels does not exist' } }),
      'acc-1',
    )

    expect(settings).toEqual({
      botTexts: {},
      labels: DEFAULT_LABELS,
      toggles: DEFAULT_TOGGLES,
    })
    expect(spy).toHaveBeenCalledWith(
      '[agenda] loadBotSettings falló:',
      '42703',
      'column booking_settings.labels does not exist',
    )
  })

  it('una fila válida se lee completa', async () => {
    const settings = await loadBotSettings(
      stubClient({
        data: {
          bot_texts: { welcome: 'Hola' },
          labels: { profesional: 'doctor' },
          choose_staff: false,
        },
        error: null,
      }),
      'acc-1',
    )

    expect(settings.botTexts).toEqual({ welcome: 'Hola' })
    expect(settings.labels).toEqual({ ...DEFAULT_LABELS, profesional: 'doctor' })
    expect(settings.toggles).toEqual({ ...DEFAULT_TOGGLES, chooseStaff: false })
  })

  it('sin fila no hay error ni log: defaults', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const settings = await loadBotSettings(stubClient({ data: null, error: null }), 'acc-1')

    expect(settings.toggles).toEqual(DEFAULT_TOGGLES)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('insertAppointment: respuestas', () => {
  const base = {
    id: 'a1',
    accountId: 'acc-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    serviceId: 'svc-1',
    staffId: 'st-1',
    startsAtIso: '2026-10-19T14:00:00.000Z',
    endsAtIso: '2026-10-19T14:30:00.000Z',
    status: 'confirmed' as const,
    createdVia: 'bot' as const,
    confirmedAtIso: '2026-10-19T13:00:00.000Z',
  }

  function recordingClient() {
    const inserted: Record<string, unknown>[] = []
    const client = {
      from: () => ({
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row)
          return { error: null }
        },
      }),
    } as unknown as SupabaseClient
    return { client, inserted }
  }

  it('no manda la columna cuando no hay respuestas (ni vacías)', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, base)
    await insertAppointment(client, { ...base, answers: {} })
    await insertAppointment(client, { ...base, answers: { q1: '' } })
    expect(inserted).toHaveLength(3)
    for (const row of inserted) expect('answers' in row).toBe(false)
  })

  it('manda las respuestas con texto por id de pregunta', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, { ...base, answers: { q1: 'Control', q2: '' } })
    expect(inserted[0].answers).toEqual({ q1: 'Control' })
  })

  it('red de seguridad: si el JSON pasa de 8000 bytes acorta los valores antes de insertar', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, {
      ...base,
      answers: { q1: 'x'.repeat(6000), q2: 'y'.repeat(6000), q3: 'corta' },
    })
    const sent = inserted[0].answers as Record<string, string>
    expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(ANSWERS_MAX_BYTES)
    expect(sent.q3).toBe('corta')
    expect(sent.q1.length).toBeGreaterThan(0)
  })
})

describe('loadAppointment: respuestas', () => {
  function clientWith(row: Record<string, unknown> | null): SupabaseClient {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.maybeSingle = async () => ({ data: row, error: null })
    return { from: () => chain } as unknown as SupabaseClient
  }
  const row = {
    id: 'a1',
    contact_id: 'ct-1',
    service_id: 's',
    staff_id: 'st',
    starts_at: '2026-10-21T20:00:00.000Z',
    ends_at: '2026-10-21T20:30:00.000Z',
    status: 'confirmed',
  }

  it('lee las respuestas de la cita', async () => {
    const appt = await loadAppointment(clientWith({ ...row, answers: { q1: 'Control' } }), 'acc', 'ct-1', 'a1')
    expect(appt?.answers).toEqual({ q1: 'Control' })
  })

  it('tolera null, arreglos y valores que no son texto', async () => {
    expect((await loadAppointment(clientWith({ ...row, answers: null }), 'acc', 'ct-1', 'a1'))?.answers).toEqual({})
    expect((await loadAppointment(clientWith({ ...row, answers: ['x'] }), 'acc', 'ct-1', 'a1'))?.answers).toEqual({})
    expect(
      (await loadAppointment(clientWith({ ...row, answers: { a: 1, b: 'ok', c: '' } }), 'acc', 'ct-1', 'a1'))?.answers,
    ).toEqual({ b: 'ok' })
  })
})
