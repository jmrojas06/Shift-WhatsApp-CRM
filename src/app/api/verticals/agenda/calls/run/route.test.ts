import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// GET /api/verticals/agenda/calls/run — el cron de las llamadas de
// confirmación. Se mockean el runner, el service role y las alertas: aquí se
// prueba el contrato de la ruta (secreto, credenciales de voz, alertas). Qué se
// llama y qué no tiene su prueba en voice/outbound-runner.test.ts.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    runnerCalls: [] as { db: unknown; provider: unknown; missingCredentials?: string[] }[],
    runnerResult: {
      accounts: 1,
      inWindow: 1,
      considered: 0,
      called: 0,
      failed: 0,
      claimedByOther: 0,
      skipped: {},
      credentialsMissing: [] as string[],
      errors: [] as string[],
    } as Record<string, unknown>,
    runnerError: null as Error | null,
    adminClient: { kind: 'service-role' },
    alerts: [] as string[],
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))

vi.mock('@/lib/verticals/admin-client', () => ({ supabaseAdmin: () => h.state.adminClient }))

vi.mock('@/lib/ops/alert', () => ({
  notifyAlert: async (text: string) => {
    h.state.alerts.push(text)
  },
}))

vi.mock('@/verticals/agenda/voice/outbound-runner', () => ({
  runOutboundCalls: async (args: { db: unknown; provider: unknown; missingCredentials?: string[] }) => {
    h.state.runnerCalls.push(args)
    if (h.state.runnerError) throw h.state.runnerError
    return h.state.runnerResult
  },
}))

import { GET, maxDuration } from './route'

type TestResponse = { status: number; body: Record<string, unknown> }

const SECRET = 'secreto-de-prueba'
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

const req = (headers?: Record<string, string>) =>
  new Request('http://localhost/api/verticals/agenda/calls/run', headers ? { headers } : undefined)

const call = async (headers?: Record<string, string>) => (await GET(req(headers))) as unknown as TestResponse

beforeEach(() => {
  vi.stubEnv('AUTOMATION_CRON_SECRET', SECRET)
  for (const [key, value] of Object.entries(TELNYX_ENV)) vi.stubEnv(key, value)
  h.state.runnerCalls = []
  h.state.runnerError = null
  h.state.alerts = []
  h.state.runnerResult = {
    accounts: 1,
    inWindow: 1,
    considered: 0,
    called: 0,
    failed: 0,
    claimedByOther: 0,
    skipped: {},
    credentialsMissing: [],
    errors: [],
  }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('secreto del cron', () => {
  it('503 si AUTOMATION_CRON_SECRET no está configurado', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    const res = await call({ 'x-cron-secret': SECRET })
    expect(res.status).toBe(503)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('401 sin secreto o con uno equivocado', async () => {
    expect((await call()).status).toBe(401)
    expect((await call({ 'x-cron-secret': 'otro' })).status).toBe(401)
    expect((await call({ authorization: 'Bearer otro' })).status).toBe(401)
    expect(h.state.runnerCalls).toHaveLength(0)
  })

  it('acepta el secreto por x-cron-secret o por Authorization: Bearer', async () => {
    expect((await call({ 'x-cron-secret': SECRET })).status).toBe(200)
    expect((await call({ authorization: `Bearer ${SECRET}` })).status).toBe(200)
    expect(h.state.runnerCalls).toHaveLength(2)
  })
})

describe('el runner', () => {
  it('recibe el service role y un proveedor cuando están todas las credenciales', async () => {
    await call({ 'x-cron-secret': SECRET })
    expect(h.state.runnerCalls[0].db).toBe(h.state.adminClient)
    expect(h.state.runnerCalls[0].provider).not.toBeNull()
    expect(typeof (h.state.runnerCalls[0].provider as { startCall: unknown }).startCall).toBe('function')
  })

  it.each([
    'TELNYX_API_KEY',
    'TELNYX_ACCOUNT_SID',
    'TELNYX_TEXML_APP_ID',
    'TELNYX_PUBLIC_KEY',
    'VOICE_WEBHOOK_SECRET',
    'NEXT_PUBLIC_SITE_URL',
  ])('si falta %s, el proveedor es null y el runner sabe cuál falta', async (name) => {
    vi.stubEnv(name, '')
    await call({ 'x-cron-secret': SECRET })
    expect(h.state.runnerCalls[0].provider).toBeNull()
    expect(h.state.runnerCalls[0].missingCredentials).toEqual([name])
  })

  it('la URL pública también puede venir de NEXT_PUBLIC_APP_URL (respaldo)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.example.test')
    await call({ 'x-cron-secret': SECRET })
    expect(h.state.runnerCalls[0].provider).not.toBeNull()
    expect(h.state.runnerCalls[0].missingCredentials).toBeUndefined()
  })

  it('responde el resumen tal cual', async () => {
    h.state.runnerResult = { ...h.state.runnerResult, called: 3 }
    const res = await call({ 'x-cron-secret': SECRET })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ called: 3, accounts: 1 })
  })

  it('tiene maxDuration para cubrir una pasada con varias llamadas', () => {
    expect(maxDuration).toBeGreaterThanOrEqual(60)
  })
})

describe('alertas', () => {
  it('un fallo o un error en la corrida avisa por la alerta, sin datos de pacientes', async () => {
    h.state.runnerResult = { ...h.state.runnerResult, failed: 1, errors: ['cita abc: Telnyx rechazó la llamada (400)'] }
    const res = await call({ 'x-cron-secret': SECRET })
    expect(res.status).toBe(200)
    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0]).toMatch(/Llamadas agenda/)
  })

  it('una pasada sin problemas no avisa', async () => {
    await call({ 'x-cron-secret': SECRET })
    expect(h.state.alerts).toHaveLength(0)
  })

  it('las credenciales que faltan se dicen en el resumen pero no mandan una alerta cada 10 minutos', async () => {
    vi.stubEnv('TELNYX_API_KEY', '')
    h.state.runnerResult = { ...h.state.runnerResult, credentialsMissing: ['TELNYX_API_KEY'] }
    const res = await call({ 'x-cron-secret': SECRET })
    expect(res.body.credentialsMissing).toEqual(['TELNYX_API_KEY'])
    expect(h.state.alerts).toHaveLength(0)
  })

  it('si el runner lanza: 500 con el mensaje, alerta y log', async () => {
    h.state.runnerError = new Error('no se pudieron leer las cuentas: boom')
    const res = await call({ 'x-cron-secret': SECRET })
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('no se pudieron leer las cuentas')
    expect(h.state.alerts).toHaveLength(1)
    expect(h.state.alerts[0]).toContain('el runner falló')
  })
})
