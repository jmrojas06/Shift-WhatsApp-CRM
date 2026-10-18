import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Tests de la ruta del runner de recordatorios (Fase 3 + Fase 5).
//
// Se mockean el runner, el sender real, el service-role y las
// alertas: aquí se verifica el contrato de la ruta — secreto
// compartido contra AUTOMATION_CRON_SECRET (por `x-cron-secret` o
// por `Authorization: Bearer`, el header de Vercel Cron), que el
// runner reciba el service-role y el sender de producción, y que los
// fallos avisen por ALERT_WEBHOOK_URL sin romper la respuesta. La
// decisión del runner tiene su propio test con fake de base
// (reminders.test.ts); el envío real, su E2E.
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
    alerts: [] as string[],
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

vi.mock('@/lib/ops/alert', () => ({
  notifyAlert: async (text: string) => {
    h.state.alerts.push(text)
  },
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

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  h.state.runnerCalls = []
  h.state.runnerError = null
  h.state.runnerResult.failed = 0
  h.state.runnerResult.errors = []
  h.state.alerts = []
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.AUTOMATION_CRON_SECRET = SECRET
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
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

  it('acepta el secreto por Authorization: Bearer (Vercel Cron)', async () => {
    const res = (await GET(
      req({ authorization: `Bearer ${SECRET}` }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.runnerCalls).toHaveLength(1)
  })

  it('rechaza si el Bearer no coincide', async () => {
    const res = (await GET(
      req({ authorization: 'Bearer otro-secreto' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(401)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('avisa por webhook cuando la corrida queda con fallos (y responde 200)', async () => {
    h.state.runnerResult.failed = 2
    h.state.runnerResult.errors = ['meta 500']

    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0]).toContain('2 fallo(s)')
  })

  it('no avisa cuando la corrida queda limpia', async () => {
    await GET(req({ 'x-cron-secret': SECRET }))

    expect(h.state.alerts).toHaveLength(0)
  })

  it('avisa y responde 500 si el runner lanza', async () => {
    h.state.runnerError = new Error('boom')

    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(500)
    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0]).toContain('boom')
  })
})
