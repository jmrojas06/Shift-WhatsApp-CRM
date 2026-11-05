import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StartCallArgs, StartCallResult } from '@/lib/voice/telnyx'
import type { FakeDb, Row } from '@/verticals/agenda/agent/testing/fake-db'
import { makeCallDb } from '@/verticals/agenda/voice/testing/call-test-db'

import { brokenJsonRequest, jsonRequest, TEST_ACCOUNT, TEST_USER, type RouteTestRole, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// POST /api/verticals/agenda/calls/robot — "Llamar con el robot ahora" desde
// la lista Para llamar. La ruta, la lógica de call-requests y la base falsa
// corren de punta a punta; el proveedor de voz es un doble (nunca hay red).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
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

const APPT = '77777777-7777-4777-8777-777777777777'
const CONTACT = '11111111-1111-4111-8111-111111111111'

const TELNYX_ENV = {
  TELNYX_API_KEY: 'KEY123',
  TELNYX_ACCOUNT_SID: 'ACC456',
  TELNYX_TEXML_APP_ID: 'APP789',
  TELNYX_PUBLIC_KEY: 'cHVibGljLWtleS1kZS1wcnVlYmE=',
  VOICE_WEBHOOK_SECRET: 'secreto-de-voz',
  NEXT_PUBLIC_SITE_URL: 'https://crm.example.test',
  // En blanco: así la URL de respaldo no tapa la que se prueba.
  NEXT_PUBLIC_APP_URL: '',
}

function seed(): FakeDb {
  return makeCallDb({
    accounts: [{ id: TEST_ACCOUNT, name: 'Clínica Sonrisa', modules: ['agenda'], vertical_key: null }],
    booking_call_settings: [
      {
        account_id: TEST_ACCOUNT,
        outbound_enabled: true,
        inbound_number: '+576015550000',
        window_start: '08:00',
        window_end: '19:00',
        call_saturday: true,
        monthly_limit: 300,
      },
    ],
    booking_appointments: [
      {
        id: APPT,
        account_id: TEST_ACCOUNT,
        contact_id: CONTACT,
        status: 'confirmed',
        starts_at: '2026-11-05T21:00:00.000Z',
        attendance_confirmed_at: null,
      },
    ],
    contacts: [{ id: CONTACT, account_id: TEST_ACCOUNT, name: 'Ana Pérez', phone: '573001112233' }],
    tags: [],
    contact_tags: [],
    clinic_consents: [],
    booking_calls: [],
  })
}

const post = async (body: unknown) => (await POST(jsonRequest(body))) as unknown as TestResponse
const rows = () => ((h.state.admin as FakeDb)._tables.booking_calls ?? []) as Row[]

beforeEach(() => {
  // Jueves 5 de noviembre de 2026, 10:00 en Bogotá.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T15:00:00.000Z'))
  for (const [key, value] of Object.entries(TELNYX_ENV)) vi.stubEnv(key, value)
  h.state.role = 'agent'
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

describe('permisos y cuerpo', () => {
  it.each<[RouteTestRole, number]>([
    ['viewer', 403],
    ['agent', 200],
    ['admin', 200],
    ['owner', 200],
  ])('el rol %s recibe %i', async (role, status) => {
    h.state.role = role
    expect((await post({ appointment_id: APPT })).status).toBe(status)
  })

  it('un viewer no llama a nadie', async () => {
    h.state.role = 'viewer'
    await post({ appointment_id: APPT })
    expect(h.state.providerCalls).toHaveLength(0)
    expect(rows()).toHaveLength(0)
  })

  it.each([[undefined], [null], [''], ['no-es-un-uuid'], [123], [{ id: APPT }]])(
    'un appointment_id inválido (%j) es 400',
    async (value) => {
      const res = await post({ appointment_id: value })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('invalid_appointment')
      expect(h.state.providerCalls).toHaveLength(0)
    },
  )

  it('un cuerpo que no es JSON o no es un objeto es 400', async () => {
    expect(((await POST(brokenJsonRequest())) as unknown as TestResponse).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    expect((await post('texto')).status).toBe(400)
  })
})

describe('llamada', () => {
  it('llama y responde con el id de la llamada y el intento', async () => {
    const res = await post({ appointment_id: APPT })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, attempt: 1 })
    expect(rows()).toHaveLength(1)
    expect(res.body.call_id).toBe(rows()[0].id)
    expect(rows()[0]).toMatchObject({ account_id: TEST_ACCOUNT, created_by: TEST_USER, channel: 'robot' })
    expect(h.state.providerCalls).toHaveLength(1)
  })

  it('la cuenta sale de la sesión: un account_id en el cuerpo no cambia nada', async () => {
    await post({ appointment_id: APPT, account_id: 'acc-2' })
    expect(rows()[0].account_id).toBe(TEST_ACCOUNT)
  })

  it('no repite el teléfono del paciente en la respuesta', async () => {
    const res = await post({ appointment_id: APPT })
    expect(JSON.stringify(res.body)).not.toContain('573001112233')
  })

  it('faltan variables de entorno: 503 sin crear ninguna fila', async () => {
    vi.stubEnv('TELNYX_API_KEY', '')
    const res = await post({ appointment_id: APPT })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('not_configured')
    expect(rows()).toHaveLength(0)
  })

  it('una regla de la llamada rota llega como 409 con su código y su texto', async () => {
    ;(h.state.admin as FakeDb)._tables.booking_call_settings[0].outbound_enabled = false
    const res = await post({ appointment_id: APPT })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'outbound_off' })
    expect(String(res.body.error)).toMatch(/apagadas/)
  })

  it('una cita que no existe es 404', async () => {
    const res = await post({ appointment_id: '99999999-9999-4999-8999-999999999999' })
    expect(res.status).toBe(404)
  })

  it('si Telnyx rechaza la llamada, 502', async () => {
    h.state.providerResult = { ok: false, error: 'Telnyx rechazó la llamada (400)' }
    const res = await post({ appointment_id: APPT })
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('provider_rejected')
  })

  it('un error inesperado es 500 genérico, sin detalles', async () => {
    ;(h.state.admin as FakeDb)._failNext('select', 'booking_call_settings', { message: 'boom secreto' })
    const res = await post({ appointment_id: APPT })
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('boom')
  })
})
