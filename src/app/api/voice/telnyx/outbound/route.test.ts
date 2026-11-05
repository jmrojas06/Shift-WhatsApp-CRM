import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import { callRowSeed, makeCallDb } from '@/verticals/agenda/voice/testing/call-test-db'

import { makeSigningKeys, TEST_APP_URL, TEST_CALL_ID, TEST_VOICE_SECRET, webhookRequest } from '../_lib/route-testing'

// ============================================================
// POST /api/voice/telnyx/outbound — instrucciones de la llamada de
// confirmación y teclas del paciente. La ruta, el handler y la máquina de pasos
// corren de punta a punta contra la base falsa; WhatsApp y Google se mockean.
//
// Lo que se prueba aquí es el contrato de la ruta: el token y la firma (403),
// que siempre responde TeXML con `Content-Type: text/xml`, que lo lento corre
// DESPUÉS de responder (`after`) y que un reintento no repite efectos. Cada
// camino de teclas tiene su prueba en outbound-webhook.test.ts.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    db: null as unknown,
    deferred: [] as (() => Promise<void>)[],
    notify: vi.fn(),
    kick: vi.fn(),
  },
}))

vi.mock('next/server', () => ({
  after: (task: () => Promise<void>) => {
    h.state.deferred.push(task)
  },
}))

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => h.state.db }))

vi.mock('@/verticals/agenda/notify-patient', () => ({
  notifyPatient: (args: unknown) => h.state.notify(args),
}))

vi.mock('@/verticals/agenda/calendar-kick', () => ({
  kickCalendarSync: (accountId: string) => h.state.kick(accountId),
}))

import { POST } from './route'

const ACCOUNT = 'acc-1'
const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'

function seed(overrides: { appointment?: Row } = {}): FakeDb {
  // Cita dentro de un rato, para que siga activa con la hora real del reloj.
  const startsAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Barbería Norte', owner_user_id: 'owner-1', modules: ['agenda'], vertical_key: null }],
    booking_call_settings: [{ account_id: ACCOUNT, inbound_number: '+576015550000', advisor_phones: [], office_hours: {} }],
    booking_appointments: [
      {
        id: APPT,
        account_id: ACCOUNT,
        contact_id: CONTACT,
        staff_id: null,
        status: 'confirmed',
        starts_at: startsAt,
        attendance_confirmed_at: null,
        ...overrides.appointment,
      },
    ],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [],
    ai_configs: [],
    notifications: [],
    booking_calls: [
      callRowSeed({
        id: TEST_CALL_ID,
        appointment_id: APPT,
        contact_id: CONTACT,
        attempt: 1,
        from_number: '+576015550000',
        to_number: '+573001112233',
      }),
    ],
  })
}

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? [])[0] as Row
const appointmentOf = (db: FakeDb) => (db._tables.booking_appointments ?? [])[0] as Row

async function runDeferred() {
  const tasks = h.state.deferred.splice(0)
  for (const task of tasks) await task()
}

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', TEST_VOICE_SECRET)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', TEST_APP_URL)
  h.state.db = seed()
  h.state.deferred.length = 0
  h.state.notify.mockReset().mockResolvedValue({ sent: true, channel: 'text' })
  h.state.kick.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('seguridad del webhook', () => {
  it('403 sin token t', async () => {
    const res = await POST(webhookRequest('outbound', { token: null }))
    expect(res.status).toBe(403)
    expect(callOf(h.state.db as FakeDb).provider_call_sid).toBeNull()
  })

  it('403 con el token de otra llamada o alterado', async () => {
    const { voiceToken } = await import('@/lib/voice/tokens')
    expect((await POST(webhookRequest('outbound', { token: voiceToken('otra') }))).status).toBe(403)
    expect((await POST(webhookRequest('outbound', { token: 'x'.repeat(43) }))).status).toBe(403)
  })

  it('403 sin el id de la llamada', async () => {
    expect((await POST(webhookRequest('outbound', { call: null }))).status).toBe(403)
  })

  it('un 403 no toca la base: ni la cita ni la llamada cambian', async () => {
    const db = h.state.db as FakeDb
    const before = JSON.stringify(db._tables)
    await POST(webhookRequest('outbound', { token: null, form: { Digits: '1' } }))
    expect(JSON.stringify(db._tables)).toBe(before)
  })

  it('con las cabeceras de firma, la firma tiene que cuadrar: 403 si no', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const bad = await POST(
      webhookRequest('outbound', {
        form: { Digits: '1' },
        headers: () => keys.headersFor('Digits=2'), // firmaron otro cuerpo
      }),
    )
    expect(bad.status).toBe(403)
    expect(appointmentOf(h.state.db as FakeDb).attendance_confirmed_at).toBeNull()
  })

  it('con las cabeceras de firma y una firma válida, funciona', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const res = await POST(
      webhookRequest('outbound', { form: { CallSid: 'CA1', Digits: '1' }, headers: (body) => keys.headersFor(body) }),
    )
    expect(res.status).toBe(200)
    expect(callOf(h.state.db as FakeDb).outcome).toBe('confirmed')
  })

  it('sin cabeceras de firma basta el token (Telnyx no firma el primer pedido)', async () => {
    const res = await POST(webhookRequest('outbound'))
    expect(res.status).toBe(200)
  })
})

describe('respuesta', () => {
  it('es TeXML con Content-Type text/xml', async () => {
    const res = await POST(webhookRequest('outbound'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    const xml = await res.text()
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true)
    expect(xml).toContain('<Gather action="')
    expect(xml).toContain('Barbería Norte')
  })

  it('el menú no nombra ningún servicio ni al paciente (esta cuenta no es clínica)', async () => {
    const xml = await (await POST(webhookRequest('outbound'))).text()
    expect(xml).not.toContain('Ana')
    expect(xml).toContain('tu cita')
  })

  it('una llamada que no existe responde colgar, también con text/xml', async () => {
    ;(h.state.db as FakeDb)._tables.booking_calls.length = 0
    const res = await POST(webhookRequest('outbound'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('si algo falla por dentro, igual responde TeXML válido (la llamada no se cae en silencio)', async () => {
    ;(h.state.db as FakeDb)._failNext('select', 'booking_calls', { message: 'boom' })
    const res = await POST(webhookRequest('outbound', { form: { Digits: '1' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    const xml = await res.text()
    expect(xml).toContain('<Hangup/>')
    expect(xml).not.toContain('quedó confirmada')
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).not.toContain('573001112233')
    expect(logged).not.toContain('Ana')
  })
})

describe('efectos y after()', () => {
  it('confirmar cambia la cita al responder, sin avisos para después', async () => {
    const res = await POST(webhookRequest('outbound', { form: { CallSid: 'CA1', Digits: '1' } }))
    expect(await res.text()).toContain('quedó confirmada')
    expect(appointmentOf(h.state.db as FakeDb).attendance_confirmed_at).toBeTruthy()
    expect(h.state.deferred).toHaveLength(0)
  })

  it('cancelar cancela al responder y deja el aviso al paciente y a Google para después', async () => {
    const res = await POST(
      webhookRequest('outbound', { query: { step: 'cancel', loop: '1', path: '2' }, form: { Digits: '1' } }),
    )
    expect(await res.text()).toContain('quedó cancelada')
    expect(appointmentOf(h.state.db as FakeDb).status).toBe('cancelled')

    // Todavía no: el paciente no espera al WhatsApp.
    expect(h.state.notify).not.toHaveBeenCalled()
    expect(h.state.deferred).toHaveLength(2)

    await runDeferred()
    expect(h.state.notify).toHaveBeenCalledTimes(1)
    expect(h.state.notify.mock.calls[0][0]).toMatchObject({ accountId: ACCOUNT, appointmentId: APPT, kind: 'cancelled' })
    expect(h.state.kick).toHaveBeenCalledWith(ACCOUNT)
  })

  it('un reintento de Telnyx con la misma tecla no cancela ni avisa dos veces', async () => {
    const send = () =>
      POST(webhookRequest('outbound', { query: { step: 'cancel', loop: '1', path: '2' }, form: { Digits: '1' } }))
    const first = await (await send()).text()
    const second = await (await send()).text()
    await runDeferred()

    expect(second).toBe(first)
    expect(h.state.notify).toHaveBeenCalledTimes(1)
    expect(h.state.kick).toHaveBeenCalledTimes(1)
  })

  it('un aviso diferido que falla no tumba nada', async () => {
    h.state.notify.mockRejectedValue(new Error('573001112233'))
    await POST(webhookRequest('outbound', { query: { step: 'cancel', loop: '1', path: '2' }, form: { Digits: '1' } }))
    await expect(runDeferred()).resolves.toBeUndefined()
  })

  it('la cita ya cancelada: dice que no está activa y no avisa a nadie', async () => {
    h.state.db = seed({ appointment: { status: 'cancelled' } })
    const res = await POST(webhookRequest('outbound', { form: { Digits: '1' } }))
    expect(await res.text()).toContain('Esta cita ya no está activa')
    expect(h.state.deferred).toHaveLength(0)
    expect(h.state.notify).not.toHaveBeenCalled()
  })
})
