import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import { callRowSeed, makeCallDb } from '@/verticals/agenda/voice/testing/call-test-db'

import { makeSigningKeys, TEST_APP_URL, TEST_VOICE_SECRET, webhookRequest } from '../_lib/route-testing'

// ============================================================
// POST /api/voice/telnyx/inbound — instrucciones de la llamada entrante. La
// ruta, el handler y la máquina de pasos corren de punta a punta contra la base
// falsa; WhatsApp, contactos y Google se mockean.
//
// Lo que se prueba aquí es el contrato de la ruta: el token y la firma (403),
// que siempre responde TeXML con `Content-Type: text/xml`, que lo lento corre
// DESPUÉS de responder (`after`) y que un reintento no repite efectos. Cada
// rama del menú tiene su prueba en voice/inbound-webhook.test.ts.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    db: null as unknown,
    deferred: [] as (() => Promise<void>)[],
    notify: vi.fn(),
    kick: vi.fn(),
    sendLink: vi.fn(),
    ensureCaller: vi.fn(),
    findContact: vi.fn(),
  },
}))

vi.mock('next/server', () => ({
  after: (task: () => Promise<void>) => {
    h.state.deferred.push(task)
  },
}))

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => h.state.db }))

vi.mock('@/verticals/agenda/voice/inbound-deps', () => ({
  inboundDeps: {
    notifyPatient: (args: unknown) => h.state.notify(args),
    kickCalendar: (accountId: string) => h.state.kick(accountId),
    sendBookingLink: (args: unknown) => h.state.sendLink(args),
    ensureCaller: (...args: unknown[]) => h.state.ensureCaller(...args),
    findContact: (...args: unknown[]) => h.state.findContact(...args),
  },
}))

import { POST } from './route'

const ACCOUNT = 'acc-1'
const CALL_ID = '99999999-9999-4999-8999-aaaaaaaaaaaa'
const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const INBOUND = '+576015550000'
const CALLER = '+573001112233'

function seed(overrides: { call?: Row | null; appointment?: Row } = {}): FakeDb {
  // Cita dentro de un rato, para que siga activa con la hora real del reloj.
  const startsAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Barbería Norte', owner_user_id: 'owner-1', modules: ['agenda'], vertical_key: null }],
    booking_call_settings: [
      { account_id: ACCOUNT, inbound_enabled: true, inbound_number: INBOUND, advisor_phones: [], office_hours: {} },
    ],
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
    booking_calls:
      overrides.call === null
        ? []
        : [
            callRowSeed({
              id: CALL_ID,
              direction: 'inbound',
              status: 'in_progress',
              contact_id: CONTACT,
              from_number: CALLER,
              to_number: INBOUND,
              provider_call_sid: 'CA-1',
              created_at: new Date().toISOString(),
              ...overrides.call,
            }),
          ],
  })
}

const calls = () => (h.state.db as FakeDb)._tables.booking_calls ?? []
const callOf = () => calls().find((row) => row.id === CALL_ID) as Row
const appointmentOf = () => ((h.state.db as FakeDb)._tables.booking_appointments ?? [])[0] as Row

/** El primer pedido de Telnyx: sin `call`, con el token de "inbound". */
const firstRequest = (extra: Parameters<typeof webhookRequest>[1] = {}) =>
  webhookRequest('inbound', { call: null, form: { CallSid: 'CA-1', From: CALLER, To: INBOUND }, ...extra })

async function runDeferred() {
  const tasks = h.state.deferred.splice(0)
  for (const task of tasks) await task()
}

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', TEST_VOICE_SECRET)
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', TEST_APP_URL)
  h.state.db = seed({ call: null })
  h.state.deferred.length = 0
  h.state.notify.mockReset().mockResolvedValue({ sent: true, channel: 'text' })
  h.state.kick.mockReset().mockResolvedValue(undefined)
  h.state.sendLink.mockReset().mockResolvedValue({ sent: true, channel: 'template' })
  h.state.ensureCaller.mockReset().mockResolvedValue({ contactId: CONTACT, conversationId: 'conv-1' })
  h.state.findContact.mockReset().mockResolvedValue({ id: CONTACT })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('seguridad del webhook', () => {
  it('403 sin token t, y no se crea ninguna llamada', async () => {
    const res = await POST(firstRequest({ token: null }))
    expect(res.status).toBe(403)
    expect(calls()).toHaveLength(0)
  })

  it('403 con un token alterado o de otro sujeto', async () => {
    const { voiceToken } = await import('@/lib/voice/tokens')
    expect((await POST(firstRequest({ token: voiceToken('otra') }))).status).toBe(403)
    expect((await POST(firstRequest({ token: 'x'.repeat(43) }))).status).toBe(403)
    expect(calls()).toHaveLength(0)
  })

  it('el token de "inbound" no sirve para una llamada concreta, ni el de una llamada para el primer pedido', async () => {
    const { voiceToken } = await import('@/lib/voice/tokens')
    h.state.db = seed()
    expect((await POST(webhookRequest('inbound', { call: CALL_ID, token: voiceToken('inbound') }))).status).toBe(403)
    expect((await POST(webhookRequest('inbound', { call: null, token: voiceToken(CALL_ID) }))).status).toBe(403)
  })

  it('403 si alguien cambia el paso o la cita de una URL firmada: no se salta preguntas ni apunta a otra cita', async () => {
    const { voiceToken } = await import('@/lib/voice/tokens')
    h.state.db = seed()
    const before = JSON.stringify((h.state.db as FakeDb)._tables)
    // El servidor firmó la URL del menú (`step=menu`, `loop=1`); quien llama la cambia al paso "confirmar cita".
    const token = voiceToken(CALL_ID, { call: CALL_ID, step: 'menu', loop: '1' })
    const forged = webhookRequest('inbound', {
      call: CALL_ID,
      token,
      query: { step: 'appt', loop: '1', appt: APPT },
      form: { CallSid: 'CA-1', Digits: '1' },
    })
    expect((await POST(forged)).status).toBe(403)
    expect(JSON.stringify((h.state.db as FakeDb)._tables)).toBe(before)
    expect(appointmentOf().attendance_confirmed_at).toBeNull()
  })

  it('un pedido del menú con otro CallSid cuelga y no cambia nada', async () => {
    h.state.db = seed()
    const before = JSON.stringify((h.state.db as FakeDb)._tables)
    const res = await POST(
      webhookRequest('inbound', {
        call: CALL_ID,
        query: { step: 'appt', loop: '1', appt: APPT },
        form: { CallSid: 'CA-AJENO', Digits: '1' },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
    expect(JSON.stringify((h.state.db as FakeDb)._tables)).toBe(before)
  })

  it('403 con call vacío', async () => {
    expect((await POST(webhookRequest('inbound', { call: '' }))).status).toBe(403)
  })

  it('un 403 no toca la base', async () => {
    h.state.db = seed()
    const before = JSON.stringify((h.state.db as FakeDb)._tables)
    await POST(webhookRequest('inbound', { call: CALL_ID, token: null, form: { Digits: '1' } }))
    expect(JSON.stringify((h.state.db as FakeDb)._tables)).toBe(before)
  })

  it('con las cabeceras de firma, la firma tiene que cuadrar: 403 si no', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const bad = await POST(firstRequest({ headers: () => keys.headersFor('To=otro') }))
    expect(bad.status).toBe(403)
    expect(calls()).toHaveLength(0)
  })

  it('con las cabeceras de firma y una firma válida, funciona', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const res = await POST(firstRequest({ headers: (body) => keys.headersFor(body) }))
    expect(res.status).toBe(200)
    expect(calls()).toHaveLength(1)
  })

  it('sin cabeceras de firma basta el token (Telnyx no firma el primer pedido)', async () => {
    expect((await POST(firstRequest())).status).toBe(200)
  })
})

describe('respuesta', () => {
  it('el primer pedido es TeXML con Content-Type text/xml: saluda y abre el menú', async () => {
    const res = await POST(firstRequest())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    const xml = await res.text()
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true)
    expect(xml).toContain('Barbería Norte')
    expect(xml).toContain('<Gather action="')
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ direction: 'inbound', channel: 'robot', provider_call_sid: 'CA-1' })
  })

  it('el Gather del menú apunta a esta misma ruta con el id de la llamada y su token', async () => {
    const xml = await (await POST(firstRequest())).text()
    const action = /<Gather action="([^"]*)"/.exec(xml)![1].replace(/&amp;/g, '&')
    const url = new URL(action)
    expect(url.origin + url.pathname).toBe(`${TEST_APP_URL}/api/voice/telnyx/inbound`)
    expect(url.searchParams.get('call')).toBe(String(calls()[0].id))

    // Y esa URL, tal cual, es aceptada por la ruta.
    const next = new Request(action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CA-1&Digits=3',
    })
    expect((await POST(next)).status).toBe(200)
  })

  it('un número sin cuenta responde "no disponible" y cuelga, también con text/xml', async () => {
    const res = await POST(firstRequest({ form: { CallSid: 'CA-1', From: CALLER, To: '+576019999999' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    const xml = await res.text()
    expect(xml).toContain('Este número no está disponible.')
    expect(xml).toContain('<Hangup/>')
    expect(calls()).toHaveLength(0)
  })

  it('una llamada que no existe responde colgar, también con text/xml', async () => {
    const res = await POST(webhookRequest('inbound', { call: CALL_ID, form: { Digits: '1' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
  })

  it('si algo falla por dentro, igual responde TeXML válido y no promete una llamada de vuelta', async () => {
    ;(h.state.db as FakeDb)._failNext('select', 'booking_call_settings', { message: 'boom' })
    const res = await POST(firstRequest())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    const xml = await res.text()
    expect(xml).toContain('<Hangup/>')
    expect(xml).toContain('Escríbenos por WhatsApp')
    expect(xml).not.toContain('te va a contactar')
    const logged = vi.mocked(console.error).mock.calls.flat().join(' ')
    expect(logged).not.toContain('573001112233')
  })
})

describe('efectos y after()', () => {
  const step = (digits: string, query: Record<string, string> = {}) =>
    webhookRequest('inbound', {
      call: CALL_ID,
      query: { step: 'menu', loop: '1', ...query },
      form: { CallSid: 'CA-1', Digits: digits },
    })

  it('agendar manda el WhatsApp antes de responder (de él depende lo que se dice)', async () => {
    h.state.db = seed()
    const res = await POST(step('1'))
    expect(await res.text()).toContain('Te enviamos un WhatsApp')
    expect(h.state.sendLink).toHaveBeenCalledTimes(1)
    expect(h.state.sendLink.mock.calls[0][0]).toMatchObject({ accountId: ACCOUNT, contactId: CONTACT, conversationId: 'conv-1' })
    expect(callOf().outcome).toBe('booking_link_sent')
  })

  it('confirmar cambia la cita al responder, sin avisos para después', async () => {
    h.state.db = seed()
    const res = await POST(step('1', { step: 'appt', path: '2', appt: APPT }))
    expect(await res.text()).toContain('quedó confirmada')
    expect(appointmentOf().attendance_confirmed_at).toBeTruthy()
    expect(h.state.deferred).toHaveLength(0)
  })

  it('cancelar cancela al responder y deja el aviso al paciente y a Google para después', async () => {
    h.state.db = seed()
    const res = await POST(step('1', { step: 'cancel', path: '2>2', appt: APPT }))
    expect(await res.text()).toContain('quedó cancelada')
    expect(appointmentOf().status).toBe('cancelled')

    // Todavía no: quien llama no espera al WhatsApp.
    expect(h.state.notify).not.toHaveBeenCalled()
    expect(h.state.deferred).toHaveLength(2)

    await runDeferred()
    expect(h.state.notify.mock.calls[0][0]).toMatchObject({ accountId: ACCOUNT, appointmentId: APPT, kind: 'cancelled' })
    expect(h.state.kick).toHaveBeenCalledWith(ACCOUNT)
  })

  it('un reintento de Telnyx con la misma tecla no cancela ni avisa dos veces', async () => {
    h.state.db = seed()
    const send = () => POST(step('1', { step: 'cancel', path: '2>2', appt: APPT }))
    const first = await (await send()).text()
    const second = await (await send()).text()
    await runDeferred()

    expect(second).toBe(first)
    expect(h.state.notify).toHaveBeenCalledTimes(1)
    expect(h.state.kick).toHaveBeenCalledTimes(1)
  })

  it('un aviso diferido que falla no tumba nada', async () => {
    h.state.db = seed()
    h.state.notify.mockRejectedValue(new Error('573001112233'))
    await POST(step('1', { step: 'cancel', path: '2>2', appt: APPT }))
    await expect(runDeferred()).resolves.toBeUndefined()
  })
})
