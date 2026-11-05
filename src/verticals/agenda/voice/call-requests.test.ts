import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StartCallArgs, StartCallResult, VoiceProvider } from '@/lib/voice/telnyx'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'

import { requestRobotCallNow, requestTestCall } from './call-requests'
import { asDb, callRowSeed, makeCallDb } from './testing/call-test-db'

// ============================================================
// "Llamar con el robot ahora" (la recepción, desde Para llamar) y "Probar
// llamada" (el admin, a un número que escribe). Las dos reglas de la llamada
// automática que protegen al paciente (ventana, festivos, baja, autorización,
// tope del mes) valen también aquí; lo que cambia es que las pide una persona.
//
// "Ahora" es el jueves 5 de noviembre de 2026, 10:00 en Bogotá.
// ============================================================

const ACCOUNT = 'acc-1'
const USER = 'user-1'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const APPT = '77777777-7777-4777-8777-777777777777'
const NOW = new Date('2026-11-05T15:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

interface SeedOptions {
  clinic?: boolean
  settings?: Row
  appointment?: Row
  contact?: Row
  tags?: Row[]
  contactTags?: Row[]
  consents?: Row[]
  calls?: Row[]
}

function seed(options: SeedOptions = {}): FakeDb {
  return makeCallDb({
    accounts: [
      {
        id: ACCOUNT,
        name: 'Clínica Sonrisa',
        modules: options.clinic ? ['agenda', 'clinica'] : ['agenda'],
        vertical_key: null,
      },
    ],
    booking_call_settings: [
      {
        account_id: ACCOUNT,
        outbound_enabled: true,
        inbound_number: '+576015550000',
        caller_id: null,
        window_start: '08:00',
        window_end: '19:00',
        call_saturday: true,
        monthly_limit: 300,
        max_attempts: 2,
        ...options.settings,
      },
    ],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        staff_id: null,
        status: 'confirmed',
        starts_at: '2026-11-05T21:00:00.000Z',
        reminder_sent_at: null,
        attendance_confirmed_at: null,
        ...options.appointment,
      },
    ],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233', ...options.contact }],
    tags: options.tags ?? [],
    contact_tags: options.contactTags ?? [],
    clinic_consents: options.consents ?? [],
    booking_calls: options.calls ?? [],
  })
}

function pastCall(overrides: Row = {}): Row {
  return callRowSeed({
    id: crypto.randomUUID(),
    appointment_id: APPT,
    contact_id: CONTACT,
    attempt: 1,
    status: 'no_answer',
    outcome: 'no_response',
    created_at: minutesAgo(300),
    ...overrides,
  })
}

interface FakeProvider extends VoiceProvider {
  calls: StartCallArgs[]
}

function fakeProvider(respond: () => StartCallResult = () => ({ ok: true })): FakeProvider {
  const calls: StartCallArgs[] = []
  return {
    calls,
    async startCall(args) {
      calls.push(args)
      return respond()
    },
  }
}

const robotRows = (db: FakeDb) => (db._tables.booking_calls ?? []).filter((row) => row.channel === 'robot')

const robot = (db: FakeDb, provider: VoiceProvider, now = NOW, appointmentId = APPT) =>
  requestRobotCallNow({ db: asDb(db), provider, accountId: ACCOUNT, userId: USER, appointmentId, now })

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', 'secreto-de-prueba-voz')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('llamar con el robot ahora', () => {
  it('llama, deja la fila a nombre de quien la pidió y devuelve su id y el intento', async () => {
    const db = seed()
    const provider = fakeProvider()
    const result = await robot(db, provider)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attempt).toBe(1)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]).toMatchObject({ to: '+573001112233', from: '+576015550000' })
    expect(robotRows(db)[0]).toMatchObject({
      id: result.callId,
      appointment_id: APPT,
      contact_id: CONTACT,
      attempt: 1,
      created_by: USER,
      channel: 'robot',
      direction: 'outbound',
      status: 'calling',
    })
  })

  it('no necesita que haya salido el recordatorio ni esperar call_after_minutes', async () => {
    const db = seed({ appointment: { reminder_sent_at: null, starts_at: '2026-11-05T15:30:00.000Z' } })
    const result = await robot(db, fakeProvider())
    expect(result.ok).toBe(true)
  })

  it('puede hacer un intento más allá de max_attempts, hasta el tope de 3 de la base', async () => {
    const db = seed({ calls: [pastCall({ attempt: 1 }), pastCall({ attempt: 2 })] })
    const result = await robot(db, fakeProvider())
    expect(result.ok && result.attempt).toBe(3)
  })

  it('con 3 intentos ya hechos no llama', async () => {
    const db = seed({ calls: [pastCall({ attempt: 1 }), pastCall({ attempt: 2 }), pastCall({ attempt: 3 })] })
    const provider = fakeProvider()
    const result = await robot(db, provider)
    expect(result).toMatchObject({ ok: false, status: 409, code: 'attempts' })
    expect(provider.calls).toHaveLength(0)
  })

  it('no llama si hay una llamada del robot en curso', async () => {
    const db = seed({ calls: [pastCall({ status: 'in_progress', outcome: null, created_at: minutesAgo(2) })] })
    const result = await robot(db, fakeProvider())
    expect(result).toMatchObject({ ok: false, status: 409, code: 'in_flight' })
  })

  it('un doble clic: la segunda petición pierde el intento (23505) y no llama', async () => {
    const db = seed()
    const provider = fakeProvider()
    const [a, b] = await Promise.all([robot(db, provider), robot(db, provider)])
    expect(provider.calls).toHaveLength(1)
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(loser).toMatchObject({ ok: false, status: 409, code: 'in_flight' })
  })

  it('las salientes apagadas', async () => {
    const result = await robot(seed({ settings: { outbound_enabled: false } }), fakeProvider())
    expect(result).toMatchObject({ ok: false, status: 409, code: 'outbound_off' })
  })

  it.each([
    ['domingo', '2026-11-08T15:00:00.000Z'],
    ['festivo', '2026-11-16T15:00:00.000Z'],
    ['antes de la ventana (7:00)', '2026-11-05T12:00:00.000Z'],
    ['después de la ventana (19:00)', '2026-11-06T00:00:00.000Z'],
  ])('fuera de la ventana de llamadas: %s', async (_name, iso) => {
    const db = seed({ appointment: { starts_at: '2026-11-20T21:00:00.000Z' } })
    const provider = fakeProvider()
    const result = await robot(db, provider, new Date(iso))
    expect(result).toMatchObject({ ok: false, status: 409, code: 'outside_window' })
    expect(provider.calls).toHaveLength(0)
  })

  it('el mensaje de la ventana dice las horas de la cuenta', async () => {
    const db = seed({ settings: { window_start: '09:00', window_end: '17:00' } })
    const result = await robot(db, fakeProvider(), new Date('2026-11-08T15:00:00.000Z'))
    expect(!result.ok && result.error).toMatch(/9:00.*17:00|09:00.*17:00/)
  })

  it('una cita que no existe, de otra cuenta o con un id raro', async () => {
    const db = seed()
    expect(await robot(db, fakeProvider(), NOW, '99999999-9999-4999-8999-999999999999')).toMatchObject({
      ok: false,
      status: 404,
      code: 'not_found',
    })
    expect(await robot(db, fakeProvider(), NOW, 'no-es-un-uuid')).toMatchObject({ ok: false, status: 404 })

    db._tables.booking_appointments[0].account_id = 'acc-2'
    expect(await robot(db, fakeProvider())).toMatchObject({ ok: false, status: 404 })
  })

  it.each([
    ['cancelada', { status: 'cancelled' }],
    ['ya empezó', { starts_at: '2026-11-05T14:00:00.000Z' }],
  ])('una cita %s ya no está activa', async (_name, appointment) => {
    const result = await robot(seed({ appointment }), fakeProvider())
    expect(result).toMatchObject({ ok: false, status: 409, code: 'not_active' })
  })

  it('una cita que el paciente ya confirmó no necesita llamada', async () => {
    const db = seed({ appointment: { attendance_confirmed_at: minutesAgo(30) } })
    expect(await robot(db, fakeProvider())).toMatchObject({ ok: false, status: 409, code: 'already_confirmed' })
  })

  it('un contacto sin teléfono válido', async () => {
    const db = seed({ contact: { phone: null } })
    expect(await robot(db, fakeProvider())).toMatchObject({ ok: false, status: 409, code: 'no_phone' })
  })

  it.each([
    ['no-llamar', 'no-llamar', 'no_call'],
    ['baja-envios', 'baja-envios', 'opt_out'],
  ])('la etiqueta %s frena la llamada', async (_label, tagName, code) => {
    const db = seed({
      tags: [{ id: 'tag-1', account_id: ACCOUNT, name: tagName }],
      contactTags: [{ contact_id: CONTACT, tag_id: 'tag-1' }],
    })
    const provider = fakeProvider()
    const result = await robot(db, provider)
    expect(result).toMatchObject({ ok: false, status: 409, code })
    expect(provider.calls).toHaveLength(0)
  })

  it('en una clínica, la autorización revocada frena la llamada', async () => {
    const db = seed({
      clinic: true,
      consents: [
        { account_id: ACCOUNT, contact_id: CONTACT, kind: 'datos_sensibles', granted: false, created_at: '2026-10-20T00:00:00.000Z' },
      ],
    })
    expect(await robot(db, fakeProvider())).toMatchObject({ ok: false, status: 409, code: 'consent_revoked' })
  })

  it('el tope del mes frena la llamada', async () => {
    const db = seed({
      settings: { monthly_limit: 1 },
      calls: [pastCall({ appointment_id: 'otra', created_at: '2026-11-02T15:00:00.000Z' })],
    })
    expect(await robot(db, fakeProvider())).toMatchObject({ ok: false, status: 409, code: 'monthly_limit' })
  })

  it('sin número que marcar', async () => {
    const db = seed({ settings: { inbound_number: null, caller_id: null } })
    expect(await robot(db, fakeProvider())).toMatchObject({ ok: false, status: 409, code: 'no_caller_id' })
  })

  it('si Telnyx la rechaza, responde 502 con un texto genérico y la fila queda failed', async () => {
    const db = seed()
    const provider = fakeProvider(() => ({ ok: false, error: 'Telnyx rechazó la llamada (400)' }))
    const result = await robot(db, provider)
    expect(result).toMatchObject({ ok: false, status: 502, code: 'provider_rejected' })
    expect(robotRows(db)[0].status).toBe('failed')
    // El detalle de Telnyx no llega a la pantalla.
    expect(!result.ok && result.error).not.toContain('400')
  })
})

describe('probar llamada', () => {
  const test = (db: FakeDb, provider: VoiceProvider, phone: unknown, now = NOW) =>
    requestTestCall({ db: asDb(db), provider, accountId: ACCOUNT, userId: USER, phone, now })

  it('llama al número escrito con una fila sin cita ni contacto', async () => {
    const db = seed()
    const provider = fakeProvider()
    const result = await test(db, provider, '+57 300 999 8877')

    expect(result.ok).toBe(true)
    expect(provider.calls[0]).toMatchObject({ to: '+573009998877', from: '+576015550000' })
    expect(robotRows(db)[0]).toMatchObject({
      appointment_id: null,
      contact_id: null,
      attempt: null,
      created_by: USER,
      status: 'calling',
    })
  })

  it('funciona aunque las salientes estén apagadas: es la forma de probar antes de prenderlas', async () => {
    const db = seed({ settings: { outbound_enabled: false } })
    const result = await test(db, fakeProvider(), '+573009998877')
    expect(result.ok).toBe(true)
  })

  it.each([[undefined], [null], [''], ['3009998877'], ['no es un número'], [12345], ['+57']])(
    'un número inválido (%s) es 400',
    async (phone) => {
      const db = seed()
      const provider = fakeProvider()
      const result = await test(db, provider, phone)
      expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_phone' })
      expect(provider.calls).toHaveLength(0)
    },
  )

  it('no toca ninguna cita', async () => {
    const db = seed()
    const before = JSON.stringify(db._tables.booking_appointments)
    await test(db, fakeProvider(), '+573009998877')
    expect(JSON.stringify(db._tables.booking_appointments)).toBe(before)
  })

  it('cuenta para el tope del mes', async () => {
    const db = seed({
      settings: { monthly_limit: 1 },
      calls: [pastCall({ appointment_id: 'otra', created_at: '2026-11-02T15:00:00.000Z' })],
    })
    expect(await test(db, fakeProvider(), '+573009998877')).toMatchObject({ ok: false, status: 409, code: 'monthly_limit' })
  })

  it('sin número que marcar', async () => {
    const db = seed({ settings: { inbound_number: null, caller_id: null } })
    expect(await test(db, fakeProvider(), '+573009998877')).toMatchObject({ ok: false, status: 409, code: 'no_caller_id' })
  })

  it('no deja pedir otra prueba en el mismo minuto (un doble clic cuesta dinero)', async () => {
    const db = seed()
    const provider = fakeProvider()
    await test(db, provider, '+573009998877')
    const again = await test(db, provider, '+573009998877', new Date(NOW.getTime() + 30_000))
    expect(again).toMatchObject({ ok: false, status: 429, code: 'too_soon' })
    expect(provider.calls).toHaveLength(1)

    const later = await test(db, provider, '+573009998877', new Date(NOW.getTime() + 61_000))
    expect(later.ok).toBe(true)
  })

  it('si Telnyx la rechaza, responde 502 sin repetir el número', async () => {
    const db = seed()
    const result = await test(db, fakeProvider(() => ({ ok: false, error: 'Telnyx rechazó la llamada (400)' })), '+573009998877')
    expect(result).toMatchObject({ ok: false, status: 502, code: 'provider_rejected' })
    expect(JSON.stringify(result)).not.toContain('573009998877')
  })
})
