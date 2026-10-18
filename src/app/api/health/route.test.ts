import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// Tests de GET /api/health (Fase 5).
//
// La ruta es pública y de infraestructura: aquí se verifica que
// responda 200/503 según env + ping a la DB, que el ping tenga
// timeout real, y que NUNCA filtre valores de entorno ni mensajes
// de error.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    dbError: null as { message: string } | null,
    dbRejects: false,
    hangs: false,
    abortSignals: 0,
    clients: 0,
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) => ({ body, status: init?.status ?? 200, headers: init?.headers ?? {} }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    h.state.clients += 1
    return {
      from: () => ({
        select: () => ({
          abortSignal: (signal: AbortSignal) => {
            h.state.abortSignals += 1
            if (h.state.hangs) {
              return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () =>
                  reject(new DOMException('aborted', 'AbortError')),
                )
              })
            }
            if (h.state.dbRejects) {
              return Promise.reject(new Error('connect ECONNREFUSED'))
            }
            return Promise.resolve({ error: h.state.dbError })
          },
        }),
      }),
    }
  },
}))

import { GET, dynamic } from './route'

type TestResponse = {
  status: number
  body: {
    ok: boolean
    checks: { env: string; db: string }
    time?: string
  }
  headers: Record<string, string>
}

const ENV_OK: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://health-test.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
  ENCRYPTION_KEY: 'e'.repeat(64),
  META_APP_SECRET: 'meta-secret-value',
}

function stubEnvOk() {
  for (const [key, value] of Object.entries(ENV_OK)) vi.stubEnv(key, value)
}

beforeEach(() => {
  h.state.dbError = null
  h.state.dbRejects = false
  h.state.hangs = false
  h.state.abortSignals = 0
  h.state.clients = 0
  stubEnvOk()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('GET /api/health', () => {
  it('responde 200 con env y DB en ok, sin caché', async () => {
    const res = (await GET()) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.checks).toEqual({ env: 'ok', db: 'ok' })
    expect(dynamic).toBe('force-dynamic')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('no filtra valores de entorno ni mensajes de error', async () => {
    h.state.dbError = { message: 'relation "accounts" does not exist' }

    const res = (await GET()) as unknown as TestResponse
    const raw = JSON.stringify(res.body)

    expect(res.status).toBe(503)
    expect(raw).not.toContain('health-test.supabase.co')
    expect(raw).not.toContain('service-role-value')
    expect(raw).not.toContain('anon-key-value')
    expect(raw).not.toContain('relation "accounts"')
  })

  it('responde 503 si la DB devuelve error', async () => {
    h.state.dbError = { message: 'boom' }

    const res = (await GET()) as unknown as TestResponse

    expect(res.status).toBe(503)
    expect(res.body.ok).toBe(false)
    expect(res.body.checks).toEqual({ env: 'ok', db: 'fail' })
  })

  it('responde 503 si el ping lanza', async () => {
    h.state.dbRejects = true

    const res = (await GET()) as unknown as TestResponse

    expect(res.status).toBe(503)
    expect(res.body.checks.db).toBe('fail')
  })

  it('responde 503 si falta una env requerida y no toca la DB', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')

    const res = (await GET()) as unknown as TestResponse

    expect(res.status).toBe(503)
    expect(res.body.checks).toEqual({ env: 'fail', db: 'fail' })
    expect(h.state.clients).toBe(0)
  })

  it('corta el ping a la DB con timeout (aborta a los 4 s)', async () => {
    vi.useFakeTimers()
    h.state.hangs = true

    const pending = GET() as unknown as Promise<TestResponse>
    await vi.advanceTimersByTimeAsync(4_000)
    const res = await pending

    expect(h.state.abortSignals).toBe(1)
    expect(res.status).toBe(503)
    expect(res.body.checks.db).toBe('fail')
  })
})
