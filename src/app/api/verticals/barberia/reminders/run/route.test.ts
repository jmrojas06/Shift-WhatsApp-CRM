import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Tests de la ruta del runner de recordatorios (Fase 3).
//
// Se mockean el runner, el sender real y el service-role: aquí se
// verifica el contrato de la ruta — secreto compartido contra
// AUTOMATION_CRON_SECRET y que el runner reciba el service-role y el
// sender de producción. La decisión del runner tiene su propio test
// con fake de base (reminders.test.ts); el envío real, su E2E.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    runnerCalls: [] as { db: unknown; send: unknown }[],
    runnerResult: {
      accounts: 1,
      due: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      byChannel: { text: 0, template: 0 },
      byKind: { h24: 0, h2: 0 },
      errors: [] as string[],
    },
    runnerError: null as Error | null,
    /** Cliente service-role falso que debe llegar al runner. */
    adminClient: { kind: 'service-role' },
    send: vi.fn(),
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/verticals/admin-client', () => ({
  supabaseAdmin: () => h.state.adminClient,
}))

vi.mock('@/verticals/barberia/agent/reminders', () => ({
  runBarberiaReminders: async (args: { db: unknown; send: unknown }) => {
    h.state.runnerCalls.push(args)
    if (h.state.runnerError) throw h.state.runnerError
    return h.state.runnerResult
  },
}))

vi.mock('@/verticals/barberia/agent/reminders-send', () => ({
  sendBarberiaReminder: h.state.send,
}))

import { GET } from './route'

type TestResponse = { status: number; body: Record<string, unknown> }

const SECRET = 'secreto-de-prueba'
const URL_RUN = 'http://localhost/api/verticals/barberia/reminders/run'

function req(headers?: Record<string, string>) {
  return new Request(URL_RUN, headers ? { headers } : undefined)
}

beforeEach(() => {
  h.state.runnerCalls = []
  h.state.runnerError = null
  process.env.AUTOMATION_CRON_SECRET = SECRET
})

afterEach(() => {
  delete process.env.AUTOMATION_CRON_SECRET
})

describe('GET /api/verticals/barberia/reminders/run', () => {
  it('responde 503 si el secreto del cron no está configurado', async () => {
    delete process.env.AUTOMATION_CRON_SECRET

    const res = (await GET(req())) as unknown as TestResponse

    expect(res.status).toBe(503)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('responde 401 sin header y no corre nada', async () => {
    const res = (await GET(req())) as unknown as TestResponse

    expect(res.status).toBe(401)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('responde 401 con un secreto incorrecto', async () => {
    const res = (await GET(
      req({ 'x-cron-secret': 'otro-secreto' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(401)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('responde 401 con un secreto de la misma longitud (timingSafeEqual)', async () => {
    const res = (await GET(
      req({ 'x-cron-secret': 'x'.repeat(SECRET.length) }),
    )) as unknown as TestResponse

    expect(res.status).toBe(401)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('corre el runner con el service-role y el sender de producción', async () => {
    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ accounts: 1, sent: 0, failed: 0 })
    expect(h.state.runnerCalls).toHaveLength(1)
    // Nunca un cliente del usuario: el runner escribe con service-role.
    expect(h.state.runnerCalls[0].db).toBe(h.state.adminClient)
    expect(h.state.runnerCalls[0].send).toBe(h.state.send)
  })

  it('responde 500 si el runner falla', async () => {
    h.state.runnerError = new Error('boom')

    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('boom')
  })
})
