import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StartCallArgs, StartCallResult } from '@/lib/voice/telnyx'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import { makeCallDb } from '@/verticals/agenda/voice/testing/call-test-db'

import { brokenJsonRequest, jsonRequest, TEST_ACCOUNT, TEST_USER, type RouteTestRole, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// POST /api/verticals/agenda/calls/test — "Probar llamada" de la tarjeta de
// llamadas. Solo el admin; llama al número que escribe con el guion de ejemplo,
// con una fila sin cita ni contacto.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'admin' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
    admin: null as unknown,
    providerCalls: [] as StartCallArgs[],
    providerResult: { ok: true } as StartCallResult,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import('@/app/api/verticals/agenda/_lib/route-testing')
  return authMockModule(h.state)
})

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => h.state.admin }))

vi.mock('@/lib/voice/telnyx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/telnyx')>()),
  createTelnyxProvider: () => ({
    async startCall(args: StartCallArgs) {
      h.state.providerCalls.push(args)
      return h.state.providerResult
    },
  }),
}))

import { POST } from './route'

const TELNYX_ENV = {
  TELNYX_API_KEY: 'KEY123',
  TELNYX_ACCOUNT_SID: 'ACC456',
  TELNYX_TEXML_APP_ID: 'APP789',
  TELNYX_PUBLIC_KEY: 'cHVibGljLWtleS1kZS1wcnVlYmE=',
  VOICE_WEBHOOK_SECRET: 'secreto-de-voz',
  NEXT_PUBLIC_APP_URL: 'https://crm.example.test',
}

function seed(): FakeDb {
  return makeCallDb({
    booking_call_settings: [
      { account_id: TEST_ACCOUNT, outbound_enabled: false, inbound_number: '+576015550000', monthly_limit: 300 },
    ],
    booking_appointments: [],
    booking_calls: [],
  })
}

const post = async (body: unknown) => (await POST(jsonRequest(body))) as unknown as TestResponse
const rows = () => ((h.state.admin as FakeDb)._tables.booking_calls ?? []) as Row[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T15:00:00.000Z'))
  for (const [key, value] of Object.entries(TELNYX_ENV)) vi.stubEnv(key, value)
  h.state.role = 'admin'
  h.state.admin = seed()
  h.state.db = h.state.admin
  h.state.providerCalls = []
  h.state.providerResult = { ok: true }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('permisos', () => {
  it.each<[RouteTestRole, number]>([
    ['viewer', 403],
    ['agent', 403],
    ['admin', 200],
    ['owner', 200],
  ])('el rol %s recibe %i', async (role, status) => {
    h.state.role = role
    expect((await post({ to: '+573009998877' })).status).toBe(status)
  })

  it('un agente no llama a nadie', async () => {
    h.state.role = 'agent'
    await post({ to: '+573009998877' })
    expect(h.state.providerCalls).toHaveLength(0)
    expect(rows()).toHaveLength(0)
  })
})

describe('cuerpo', () => {
  it.each([[undefined], [''], ['3009998877'], ['no es un número'], [12345]])(
    'un número inválido (%j) es 400 y no llama',
    async (phone) => {
      const res = await post({ to: phone })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('invalid_phone')
      expect(h.state.providerCalls).toHaveLength(0)
    },
  )

  it('un cuerpo roto o que no es un objeto es 400', async () => {
    expect(((await POST(brokenJsonRequest())) as unknown as TestResponse).status).toBe(400)
    expect((await post(null)).status).toBe(400)
  })
})

describe('llamada de prueba', () => {
  it('llama al número escrito, con una fila sin cita ni contacto, a nombre del admin', async () => {
    const res = await post({ to: '+57 300 999 8877' })

    expect(res.status).toBe(200)
    expect(h.state.providerCalls[0]).toMatchObject({ to: '+573009998877', from: '+576015550000' })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      account_id: TEST_ACCOUNT,
      appointment_id: null,
      contact_id: null,
      attempt: null,
      created_by: TEST_USER,
    })
    expect(res.body).toMatchObject({ ok: true, call_id: rows()[0].id })
  })

  it('también acepta el número como `phone`', async () => {
    const res = await post({ phone: '+573009998877' })
    expect(res.status).toBe(200)
    expect(h.state.providerCalls[0].to).toBe('+573009998877')
  })

  it('funciona con las salientes apagadas (es la forma de probar antes de prenderlas)', async () => {
    expect((await post({ to: '+573009998877' })).status).toBe(200)
  })

  it('no repite el número en la respuesta', async () => {
    const res = await post({ to: '+573009998877' })
    expect(JSON.stringify(res.body)).not.toContain('573009998877')
  })

  it('un segundo clic en el mismo minuto es 429', async () => {
    await post({ to: '+573009998877' })
    const again = await post({ to: '+573009998877' })
    expect(again.status).toBe(429)
    expect(h.state.providerCalls).toHaveLength(1)
  })

  it('faltan variables de entorno: 503 y no se crea ninguna fila', async () => {
    vi.stubEnv('VOICE_WEBHOOK_SECRET', '')
    const res = await post({ to: '+573009998877' })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('not_configured')
    expect(rows()).toHaveLength(0)
  })

  it('si Telnyx la rechaza, 502', async () => {
    h.state.providerResult = { ok: false, error: 'Telnyx rechazó la llamada (400)' }
    expect((await post({ to: '+573009998877' })).status).toBe(502)
  })
})
