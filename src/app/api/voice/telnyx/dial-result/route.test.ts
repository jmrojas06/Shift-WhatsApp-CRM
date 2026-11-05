import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import { callRowSeed, makeCallDb } from '@/verticals/agenda/voice/testing/call-test-db'

import { makeSigningKeys, TEST_APP_URL, TEST_CALL_ID, TEST_VOICE_SECRET, webhookRequest } from '../_lib/route-testing'

// ============================================================
// POST /api/voice/telnyx/dial-result — terminó el <Dial> a los asesores.
// Compartida con las llamadas entrantes: contestó un asesor (advisor_connected)
// o nadie (advisor_missed + aviso en la app + la frase al paciente).
// ============================================================

const h = vi.hoisted(() => ({ state: { db: null as unknown } }))

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => h.state.db }))

import { POST } from './route'

const ACCOUNT = 'acc-1'
const CONTACT = '11111111-1111-4111-8111-111111111111'

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? [])[0] as Row

function seed(call: Row = {}): FakeDb {
  return makeCallDb({
    accounts: [{ id: ACCOUNT, name: 'Clínica Sonrisa', owner_user_id: 'owner-1' }],
    booking_call_settings: [{ account_id: ACCOUNT }],
    contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    conversations: [],
    ai_configs: [],
    notifications: [],
    booking_calls: [
      callRowSeed({ id: TEST_CALL_ID, contact_id: CONTACT, from_number: '+576015550000', to_number: '+573001112233', ...call }),
    ],
  })
}

beforeEach(() => {
  vi.stubEnv('VOICE_WEBHOOK_SECRET', TEST_VOICE_SECRET)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', TEST_APP_URL)
  h.state.db = seed()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('seguridad', () => {
  it('403 sin token o con un token ajeno, y no cambia nada', async () => {
    const { voiceToken } = await import('@/lib/voice/tokens')
    const before = JSON.stringify((h.state.db as FakeDb)._tables)
    const form = { DialCallStatus: 'no-answer' }
    expect((await POST(webhookRequest('dial-result', { token: null, form }))).status).toBe(403)
    expect((await POST(webhookRequest('dial-result', { token: voiceToken('otra'), form }))).status).toBe(403)
    expect(JSON.stringify((h.state.db as FakeDb)._tables)).toBe(before)
  })

  it('403 con una firma que no cuadra; con una válida pasa', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const bad = await POST(
      webhookRequest('dial-result', {
        form: { DialCallStatus: 'no-answer' },
        headers: () => keys.headersFor('DialCallStatus=completed'),
      }),
    )
    expect(bad.status).toBe(403)
    expect(callOf(h.state.db as FakeDb).outcome).toBeNull()

    const good = await POST(
      webhookRequest('dial-result', { form: { DialCallStatus: 'completed' }, headers: (body) => keys.headersFor(body) }),
    )
    expect(good.status).toBe(200)
    expect(callOf(h.state.db as FakeDb).outcome).toBe('advisor_connected')
  })
})

describe('resultado del Dial', () => {
  it('un asesor contestó: advisor_connected y solo cuelga', async () => {
    const res = await POST(webhookRequest('dial-result', { form: { DialCallStatus: 'completed' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(await res.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
    expect(callOf(h.state.db as FakeDb).outcome).toBe('advisor_connected')
  })

  it('nadie contestó: advisor_missed, la frase del diseño y un aviso en la app', async () => {
    const res = await POST(webhookRequest('dial-result', { form: { DialCallStatus: 'no-answer' } }))
    const xml = await res.text()
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(xml).toContain('En este momento no hay asesores disponibles. Le avisamos al equipo para que te llame.')
    expect(xml).toContain('<Hangup/>')
    expect(callOf(h.state.db as FakeDb).outcome).toBe('advisor_missed')
    expect((h.state.db as FakeDb)._tables.notifications).toHaveLength(1)
  })

  it('un reintento no duplica el aviso', async () => {
    const send = () => POST(webhookRequest('dial-result', { form: { DialCallStatus: 'busy' } }))
    const first = await (await send()).text()
    const second = await (await send()).text()
    expect(second).toBe(first)
    expect((h.state.db as FakeDb)._tables.notifications).toHaveLength(1)
  })

  it('si la base falla, igual cuelga con una despedida válida y sin datos del paciente', async () => {
    ;(h.state.db as FakeDb)._failNext('select', 'booking_calls', { message: 'boom' })
    const res = await POST(webhookRequest('dial-result', { form: { DialCallStatus: 'no-answer' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(await res.text()).toContain('<Hangup/>')
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('573001112233')
  })
})
