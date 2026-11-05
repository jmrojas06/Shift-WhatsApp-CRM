import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Tests de la ruta del runner de Google Calendar.
//
// Se mockean el runner, el service-role y las alertas: aquí se verifica el
// contrato de la ruta — secreto compartido contra AUTOMATION_CRON_SECRET (por
// `x-cron-secret` o por `Authorization: Bearer`, el header de Vercel Cron), que
// el runner reciba el service-role y la hora, y cuándo se avisa por
// ALERT_WEBHOOK_URL. La decisión del runner tiene su propio test con base y
// Google falsos (calendar-sync.test.ts).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    runnerCalls: [] as { db: unknown; now: unknown }[],
    runnerResult: {
      accounts: 1,
      synced: 3,
      failed: 0,
      raced: 0,
      revoked: 0,
      connectionErrors: 0,
      errors: [] as string[],
    },
    runnerError: null as Error | null,
    /** Cliente service-role falso que debe llegar al runner. */
    adminClient: { kind: 'service-role' },
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

vi.mock('@/verticals/agenda/calendar-sync', () => ({
  runCalendarSync: async (args: { db: unknown; now: unknown }) => {
    h.state.runnerCalls.push(args)
    if (h.state.runnerError) throw h.state.runnerError
    return h.state.runnerResult
  },
}))

import { GET } from './route'

type TestResponse = { status: number; body: Record<string, unknown> }

const SECRET = 'secreto-de-prueba'
const URL_RUN = 'http://localhost/api/verticals/agenda/calendar-sync/run'

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

describe('GET /api/verticals/agenda/calendar-sync/run', () => {
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

  it('acepta el secreto por x-cron-secret', async () => {
    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.runnerCalls).toHaveLength(1)
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

  it('corre el runner con el service-role y la hora actual, y devuelve el resumen', async () => {
    const before = Date.now()
    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ accounts: 1, synced: 3, failed: 0 })
    expect(h.state.runnerCalls).toHaveLength(1)
    // Nunca un cliente del usuario: el runner escribe con service-role.
    expect(h.state.runnerCalls[0].db).toBe(h.state.adminClient)
    const now = h.state.runnerCalls[0].now
    expect(now).toBeInstanceOf(Date)
    expect((now as Date).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('avisa por webhook cuando alguna cuenta falló (y responde 200)', async () => {
    h.state.runnerResult.errors = ['cuenta abc: se cayó']

    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0]).toContain('1 error(es)')
  })

  it('no avisa por una cita que falló en Google (se anota en la cita y se reintenta)', async () => {
    h.state.runnerResult.failed = 4

    await GET(req({ 'x-cron-secret': SECRET }))

    expect(h.state.alerts).toHaveLength(0)
  })

  it('no avisa cuando la corrida queda limpia', async () => {
    await GET(req({ 'x-cron-secret': SECRET }))

    expect(h.state.alerts).toHaveLength(0)
  })

  it('avisa y responde 500 si el runner lanza', async () => {
    h.state.runnerError = new Error(
      'No se pudieron leer las conexiones de Google: connection reset',
    )

    const res = (await GET(
      req({ 'x-cron-secret': SECRET }),
    )) as unknown as TestResponse

    expect(res.status).toBe(500)
    expect(res.body.error).toContain('connection reset')
    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0]).toContain('connection reset')
  })

  it('declara maxDuration = 60 para que la corrida no se corte', async () => {
    const mod = await import('./route')
    expect(mod.maxDuration).toBe(60)
  })
})
