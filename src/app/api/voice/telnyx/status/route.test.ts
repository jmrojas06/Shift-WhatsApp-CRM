import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import { callRowSeed, makeCallDb } from '@/verticals/agenda/voice/testing/call-test-db'

import { makeSigningKeys, TEST_APP_URL, TEST_CALL_ID, TEST_VOICE_SECRET, webhookRequest } from '../_lib/route-testing'

// ============================================================
// POST /api/voice/telnyx/status — Telnyx avisa que la llamada terminó
// (`StatusCallback`). Cierra la fila: estado, duración, hora y, si no quedó
// ningún resultado, no_response.
// ============================================================

const h = vi.hoisted(() => ({ state: { db: null as unknown } }))

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => h.state.db }))

import { POST } from './route'

const callOf = (db: FakeDb) => (db._tables.booking_calls ?? [])[0] as Row

function seed(call: Row = {}): FakeDb {
  return makeCallDb({
    booking_calls: [callRowSeed({ id: TEST_CALL_ID, status: 'in_progress', ...call })],
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
  it('403 sin token o con un token de otra llamada, y la fila no cambia', async () => {
    const { voiceToken } = await import('@/lib/voice/tokens')
    const before = JSON.stringify((h.state.db as FakeDb)._tables)
    const form = { CallStatus: 'completed', CallDuration: '30' }
    expect((await POST(webhookRequest('status', { token: null, form }))).status).toBe(403)
    expect((await POST(webhookRequest('status', { token: voiceToken('otra'), form }))).status).toBe(403)
    expect(JSON.stringify((h.state.db as FakeDb)._tables)).toBe(before)
  })

  it('403 con una firma que no cuadra', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const res = await POST(
      webhookRequest('status', {
        form: { CallStatus: 'completed' },
        headers: () => keys.headersFor('CallStatus=busy'),
      }),
    )
    expect(res.status).toBe(403)
    expect(callOf(h.state.db as FakeDb).status).toBe('in_progress')
  })

  it('con una firma válida pasa', async () => {
    const keys = makeSigningKeys()
    vi.stubEnv('TELNYX_PUBLIC_KEY', keys.publicKeyB64)
    const res = await POST(
      webhookRequest('status', { form: { CallStatus: 'completed' }, headers: (body) => keys.headersFor(body) }),
    )
    expect(res.status).toBe(200)
    expect(callOf(h.state.db as FakeDb).status).toBe('completed')
  })
})

describe('cierre de la llamada', () => {
  it('guarda estado, duración y hora; sin resultado queda no_response', async () => {
    const res = await POST(
      webhookRequest('status', { form: { CallSid: 'CA9', CallStatus: 'completed', CallDuration: '42' } }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/xml/)
    expect(callOf(h.state.db as FakeDb)).toMatchObject({
      status: 'completed',
      duration_seconds: 42,
      outcome: 'no_response',
      provider_call_sid: 'CA9',
    })
    expect(callOf(h.state.db as FakeDb).finished_at).toBeTruthy()
  })

  it.each([
    ['busy', 'busy'],
    ['no-answer', 'no_answer'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
  ])('%s → %s', async (raw, status) => {
    h.state.db = seed({ status: 'calling' })
    await POST(webhookRequest('status', { form: { CallStatus: raw } }))
    expect(callOf(h.state.db as FakeDb)).toMatchObject({ status, outcome: 'no_response' })
  })

  it('respeta el resultado que ya puso el paciente (confirmó y colgó)', async () => {
    h.state.db = seed({ outcome: 'confirmed' })
    await POST(webhookRequest('status', { form: { CallStatus: 'completed', CallDuration: '25' } }))
    expect(callOf(h.state.db as FakeDb)).toMatchObject({ status: 'completed', outcome: 'confirmed' })
  })

  it('es idempotente: el mismo aviso dos veces deja lo mismo', async () => {
    const send = () => POST(webhookRequest('status', { form: { CallStatus: 'completed', CallDuration: '42' } }))
    await send()
    const after = JSON.stringify(callOf(h.state.db as FakeDb))
    await send()
    expect(JSON.stringify(callOf(h.state.db as FakeDb))).toBe(after)
  })

  it('una llamada que no existe responde 200 sin hacer nada', async () => {
    ;(h.state.db as FakeDb)._tables.booking_calls.length = 0
    const res = await POST(webhookRequest('status', { form: { CallStatus: 'completed' } }))
    expect(res.status).toBe(200)
  })

  it('si la base falla responde 500 para que Telnyx pueda reintentar, sin datos del paciente', async () => {
    ;(h.state.db as FakeDb)._failNext('select', 'booking_calls', { message: 'boom' })
    const res = await POST(webhookRequest('status', { form: { CallStatus: 'completed' } }))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('boom')
  })
})
