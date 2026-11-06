import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type RedirectResponse,
  type TestResponse,
} from '../_lib/route-testing'
import { CALLBACK_PATH, STATE_COOKIE } from '../_lib/google-env'

// ============================================================
// GET /api/integrations/google-calendar/connect — manda a Google.
// ============================================================

const h = vi.hoisted(() => ({
  state: { role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer', db: null as unknown },
}))

vi.mock('next/server', async () => {
  const { nextServerWithRedirectMock } = await import(
    '@/app/api/integrations/google-calendar/_lib/route-testing'
  )
  return nextServerWithRedirectMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import(
    '@/app/api/integrations/google-calendar/_lib/route-testing'
  )
  return authMockModule(h.state)
})

import { GET } from './route'

function setEnv() {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id-123')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'client-secret-456')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/')
}

beforeEach(() => {
  h.state.role = 'owner'
  setEnv()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function connect() {
  return (await GET()) as unknown as RedirectResponse
}

describe('GET /connect', () => {
  it('manda a Google con los permisos de calendario y pide el permiso permanente', async () => {
    const res = await connect()

    expect(res.status).toBe(307)
    const url = new URL(res.location)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('client-id-123')
    expect(url.searchParams.get('redirect_uri')).toBe(
      `https://crm.example.com${CALLBACK_PATH}`,
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('calendar.events')
    expect(url.searchParams.get('scope')).toContain('calendar.calendarlist.readonly')
  })

  it('guarda el state en una cookie httpOnly de 10 minutos que solo viaja al callback', async () => {
    const res = await connect()

    const state = new URL(res.location).searchParams.get('state')
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.cookieCalls).toHaveLength(1)
    expect(res.cookieCalls[0]).toMatchObject({
      name: STATE_COOKIE,
      value: state,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600,
      path: CALLBACK_PATH,
      secure: false,
    })
  })

  it('en producción la cookie es secure', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = await connect()
    expect(res.cookieCalls[0].secure).toBe(true)
  })

  it('cada conexión usa un state distinto', async () => {
    const a = new URL((await connect()).location).searchParams.get('state')
    const b = new URL((await connect()).location).searchParams.get('state')
    expect(a).not.toBe(b)
  })

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_SITE_URL'])(
    'sin %s contesta 503 con un mensaje claro y no redirige',
    async (name) => {
      vi.stubEnv(name, '')

      const res = (await GET()) as unknown as TestResponse
      expect(res.status).toBe(503)
      expect(String(res.body.error)).toContain('Google Calendar')
      expect(JSON.stringify(res.body)).not.toContain('client-secret-456')
    },
  )

  it.each(['admin', 'owner'] as const)('deja pasar a %s', async (role) => {
    h.state.role = role
    expect((await connect()).status).toBe(307)
  })

  it.each(['agent', 'viewer'] as const)('%s recibe 403 y no se arma ningún state', async (role) => {
    h.state.role = role
    const res = (await GET()) as unknown as TestResponse
    expect(res.status).toBe(403)
  })
})
