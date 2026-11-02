import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_LABELS } from '../labels'
import { DEFAULT_TOGGLES } from '../toggles'
import { ANSWERS_MAX_BYTES } from '../questions'
import {
  hasRecentNotification,
  insertAppointment,
  insertNotification,
  loadAppointment,
  loadAppointmentPatientId,
  loadBotSettings,
} from './db'
import { asClient, makeFakeDb } from './testing/fake-db'

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
    await insertAppointment(client, { ...base, answers: { q1: { label: 'Motivo', value: '' } } })
    expect(inserted).toHaveLength(3)
    for (const row of inserted) expect('answers' in row).toBe(false)
  })

  it('manda las respuestas con texto por id de pregunta', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, {
      ...base,
      answers: { q1: { label: 'Motivo', value: 'Control' }, q2: { label: 'Sede', value: '' } },
    })
    expect(inserted[0].answers).toEqual({ q1: { label: 'Motivo', value: 'Control' } })
  })

  it('red de seguridad: si el JSON pasa de 8000 bytes acorta los valores antes de insertar', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, {
      ...base,
      answers: {
        q1: { label: 'A', value: 'x'.repeat(6000) },
        q2: { label: 'B', value: 'y'.repeat(6000) },
        q3: { label: 'C', value: 'corta' },
      },
    })
    const sent = inserted[0].answers as Record<string, { label: string; value: string }>
    expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(ANSWERS_MAX_BYTES)
    expect(sent.q3).toEqual({ label: 'C', value: 'corta' })
    expect(sent.q1.value.length).toBeGreaterThan(0)
  })
})

describe('insertAppointment: paciente y sede', () => {
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

  it('manda el paciente y la sede cuando vienen', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, { ...base, patientId: 'pat-1', locationId: 'loc-1' })
    expect(inserted[0]).toMatchObject({ patient_id: 'pat-1', location_id: 'loc-1' })
  })

  it('no manda las columnas cuando no vienen (ni nulas): los demás negocios no las tienen', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, base)
    await insertAppointment(client, { ...base, patientId: null, locationId: null })
    await insertAppointment(client, { ...base, patientId: undefined, locationId: undefined })
    expect(inserted).toHaveLength(3)
    for (const row of inserted) {
      expect('patient_id' in row).toBe(false)
      expect('location_id' in row).toBe(false)
    }
  })

  it('cada una va por su lado', async () => {
    const { client, inserted } = recordingClient()
    await insertAppointment(client, { ...base, patientId: 'pat-1' })
    await insertAppointment(client, { ...base, locationId: 'loc-1' })
    expect(inserted[0]).toMatchObject({ patient_id: 'pat-1' })
    expect('location_id' in inserted[0]).toBe(false)
    expect(inserted[1]).toMatchObject({ location_id: 'loc-1' })
    expect('patient_id' in inserted[1]).toBe(false)
  })
})

describe('insertNotification', () => {
  const args = {
    accountId: 'acc-1',
    userId: 'u-1',
    conversationId: 'cv-1',
    contactId: 'ct-1',
    title: 'Aviso',
    body: 'Cuerpo',
  }

  it('guarda el aviso, con la hora que se le pase', async () => {
    const db = makeFakeDb({ notifications: [] })
    await insertNotification(asClient(db), { ...args, createdAtIso: '2026-10-19T13:00:00.000Z' })
    expect(db._tables.notifications).toMatchObject([
      { user_id: 'u-1', title: 'Aviso', created_at: '2026-10-19T13:00:00.000Z' },
    ])
  })

  it('si la base lo rechaza, lanza: un aviso que no se guardó no puede darse por enviado', async () => {
    const db = makeFakeDb({ notifications: [] })
    db._failNext('insert', 'notifications', { message: 'boom' })
    await expect(insertNotification(asClient(db), args)).rejects.toThrow('boom')
    expect(db._tables.notifications).toHaveLength(0)
  })
})

describe('hasRecentNotification', () => {
  const row = (createdAt: string, overrides = {}) => ({
    id: createdAt,
    account_id: 'acc-1',
    conversation_id: 'cv-1',
    title: 'Aviso',
    created_at: createdAt,
    ...overrides,
  })
  const ask = (db: ReturnType<typeof makeFakeDb>) =>
    hasRecentNotification(asClient(db), {
      accountId: 'acc-1',
      conversationId: 'cv-1',
      title: 'Aviso',
      sinceIso: '2026-10-19T12:50:00.000Z',
    })

  it('ve un aviso igual de esa conversación desde esa hora', async () => {
    expect(await ask(makeFakeDb({ notifications: [row('2026-10-19T12:55:00.000Z')] }))).toBe(true)
  })

  it('no ve uno más viejo, de otro título ni de otra conversación', async () => {
    const db = makeFakeDb({
      notifications: [
        row('2026-10-19T12:40:00.000Z'),
        row('2026-10-19T12:55:00.000Z', { title: 'Otro' }),
        row('2026-10-19T12:55:00.000Z', { conversation_id: 'cv-2' }),
      ],
    })
    expect(await ask(db)).toBe(false)
  })

  it('si no se pudo leer, dice que no hay: ante la duda, se avisa', async () => {
    const db = makeFakeDb({ notifications: [row('2026-10-19T12:55:00.000Z')] })
    db._failNext('select', 'notifications', { message: 'boom' })
    expect(await ask(db)).toBe(false)
  })
})

describe('loadAppointmentPatientId', () => {
  const seed = () =>
    makeFakeDb({
      booking_appointments: [
        { id: 'ap-1', account_id: 'acc-1', patient_id: 'pat-1' },
        { id: 'ap-2', account_id: 'acc-2', patient_id: 'pat-9' },
        { id: 'ap-3', account_id: 'acc-1', patient_id: null },
        { id: 'ap-4', account_id: 'acc-1' },
      ],
    })

  it('devuelve el paciente de la cita', async () => {
    expect(await loadAppointmentPatientId(asClient(seed()), 'acc-1', 'ap-1')).toBe('pat-1')
  })

  it('una cita sin paciente, o que no existe, da null', async () => {
    const db = asClient(seed())
    expect(await loadAppointmentPatientId(db, 'acc-1', 'ap-3')).toBeNull()
    expect(await loadAppointmentPatientId(db, 'acc-1', 'ap-4')).toBeNull()
    expect(await loadAppointmentPatientId(db, 'acc-1', 'ap-no')).toBeNull()
  })

  it('no lee la cita de otra cuenta', async () => {
    expect(await loadAppointmentPatientId(asClient(seed()), 'acc-1', 'ap-2')).toBeNull()
  })

  it('si la lectura falla lanza: no se confunde con una cita sin paciente', async () => {
    const db = seed()
    db._failNext('select', 'booking_appointments', { message: 'timeout' })
    await expect(loadAppointmentPatientId(asClient(db), 'acc-1', 'ap-1')).rejects.toThrow(
      'No se pudo leer el paciente de la cita: timeout',
    )
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

  it('lee las respuestas de la cita con su etiqueta', async () => {
    const appt = await loadAppointment(
      clientWith({ ...row, answers: { q1: { label: 'Motivo', value: 'Control' } } }),
      'acc',
      'ct-1',
      'a1',
    )
    expect(appt?.answers).toEqual({ q1: { label: 'Motivo', value: 'Control' } })
  })

  it('lee también el formato viejo (solo el valor)', async () => {
    const appt = await loadAppointment(clientWith({ ...row, answers: { q1: 'Control' } }), 'acc', 'ct-1', 'a1')
    expect(appt?.answers).toEqual({ q1: { label: '', value: 'Control' } })
  })

  it('tolera null, arreglos y valores que no son texto', async () => {
    expect((await loadAppointment(clientWith({ ...row, answers: null }), 'acc', 'ct-1', 'a1'))?.answers).toEqual({})
    expect((await loadAppointment(clientWith({ ...row, answers: ['x'] }), 'acc', 'ct-1', 'a1'))?.answers).toEqual({})
    expect(
      (await loadAppointment(clientWith({ ...row, answers: { a: 1, b: 'ok', c: '' } }), 'acc', 'ct-1', 'a1'))?.answers,
    ).toEqual({ b: { label: '', value: 'ok' } })
  })
})
