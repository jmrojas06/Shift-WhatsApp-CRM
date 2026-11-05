// ============================================================
// Utilidades de prueba para las rutas de Google Calendar.
//
// Igual que `verticals/agenda/_lib/route-testing.ts` (de ahí salen el
// mock de roles y las constantes), más lo que estas rutas necesitan:
//   - `NextResponse.redirect` que anota las cookies que se ponen.
//   - Requests con `url` y `cookies` (los callbacks no leen un JSON).
//   - Un `fetch` falso de Google: las pruebas nunca tocan la red.
//
// Este módulo NO importa `vitest` (se carga con `await import(...)` desde
// los factories de `vi.mock`). El `fetch` falso es una función simple y
// el test la envuelve en `vi.fn` si quiere espiarla.
// ============================================================

import type { NextRequest } from 'next/server'

import { nextServerMock } from '@/app/api/verticals/agenda/_lib/route-testing'

export {
  TEST_ACCOUNT,
  TEST_USER,
  authMockModule,
  type RouteTestState,
  type TestResponse,
} from '@/app/api/verticals/agenda/_lib/route-testing'

export interface CookieCall {
  name: string
  value: string
  path?: string
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface RedirectResponse {
  status: number
  location: string
  cookieCalls: CookieCall[]
  cookies: { set: (cookie: CookieCall) => void }
}

/** `next/server` falso: `json` plano y `redirect` con cookies anotadas. */
export function nextServerWithRedirectMock() {
  const base = nextServerMock()
  return {
    NextResponse: {
      ...base.NextResponse,
      redirect: (url: URL | string, status = 307): RedirectResponse => {
        const cookieCalls: CookieCall[] = []
        return {
          status,
          location: String(url),
          cookieCalls,
          cookies: { set: (cookie) => void cookieCalls.push(cookie) },
        }
      },
    },
  }
}

/** Request de un GET con query y cookies (lo único que leen estas rutas). */
export function getRequest(args: {
  url?: string
  query?: Record<string, string>
  cookies?: Record<string, string>
} = {}): NextRequest {
  const url = new URL(args.url ?? 'https://crm.example.com/api/integrations/google-calendar/x')
  for (const [key, value] of Object.entries(args.query ?? {})) {
    url.searchParams.set(key, value)
  }
  const jar = args.cookies ?? {}
  return {
    url: url.toString(),
    cookies: {
      get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
    },
  } as unknown as NextRequest
}

export type FakeGoogleHandler = (
  url: URL,
  init: RequestInit,
) => Response | Promise<Response>

export interface FakeGoogleCall {
  method: string
  url: string
  body: string
}

/**
 * `fetch` falso que contesta según el host y la ruta. Cualquier dirección
 * que no esté prevista lanza: así una prueba no puede salir a internet sin
 * enterarse. Devuelve también la lista de llamadas hechas.
 */
export function makeFakeGoogle(handlers: {
  token?: FakeGoogleHandler
  userinfo?: FakeGoogleHandler
  calendarList?: FakeGoogleHandler
  revoke?: FakeGoogleHandler
}) {
  const calls: FakeGoogleCall[] = []
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({
      method: init.method ?? 'GET',
      url: url.toString(),
      body: typeof init.body === 'string' ? init.body : '',
    })
    const route =
      url.href.startsWith('https://oauth2.googleapis.com/token')
        ? handlers.token
        : url.href.startsWith('https://oauth2.googleapis.com/revoke')
          ? handlers.revoke
          : url.href.startsWith('https://openidconnect.googleapis.com/v1/userinfo')
            ? handlers.userinfo
            : url.pathname.endsWith('/users/me/calendarList')
              ? handlers.calendarList
              : undefined
    if (!route) throw new Error(`Llamada inesperada a ${url.origin}${url.pathname}`)
    return route(url, init)
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
