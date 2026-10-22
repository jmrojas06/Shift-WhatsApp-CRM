// ============================================================
// Utilidades compartidas por los tests de las rutas de
// configuración del vertical de la agenda.
//
// Los `vi.mock` de cada archivo de test quedan diminutos: aquí
// viven el mock de `next/server` (NextResponse.json → objeto plano
// con `status`, igual que el patrón de setup/route.test.ts) y el de
// `@/lib/auth/account`:
//
//   - requireRole: aplica la misma jerarquía que el real
//     (viewer < agent < admin < owner) contra `state.role`, y
//     devuelve el contexto con el fake-db en `state.db` — así las
//     rutas + el repositorio se ejercitan de punta a punta.
//   - toErrorResponse: mismo contrato de status que el real
//     (401/403 con mensaje; el resto, 500 genérico sin filtrar).
//
// Este módulo NO importa `vitest`: se carga desde los factories con
// `await import(...)`, la forma segura con el hoisting de vi.mock.
// ============================================================

export type RouteTestRole = 'owner' | 'admin' | 'agent' | 'viewer'

export interface RouteTestState {
  role: RouteTestRole
  /** Fake de Supabase (makeFakeDb) asignado en cada test. */
  db: unknown
}

export const TEST_ACCOUNT = 'acc-1'
export const TEST_USER = 'user-1'

const ROLE_RANK: Record<RouteTestRole, number> = {
  viewer: 1,
  agent: 2,
  admin: 3,
  owner: 4,
}

export function nextServerMock() {
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      }),
    },
  }
}

export function authMockModule(state: RouteTestState) {
  return {
    requireRole: async (min: RouteTestRole) => {
      if (ROLE_RANK[state.role] < ROLE_RANK[min]) {
        const err = new Error('No tienes permiso para esta acción.') as Error & {
          status: number
        }
        err.status = 403
        throw err
      }
      return {
        supabase: state.db,
        userId: TEST_USER,
        accountId: TEST_ACCOUNT,
        role: state.role,
        account: { id: TEST_ACCOUNT, name: 'Barbería de prueba' },
      }
    },
    toErrorResponse: (err: unknown) => {
      const status = (err as { status?: number } | null)?.status
      if (status === 401 || status === 403) {
        return {
          body: { error: err instanceof Error ? err.message : 'error' },
          status,
        }
      }
      // Contrato real: los errores no clasificados no filtran detalles.
      return { body: { error: 'Error interno.' }, status: 500 }
    },
  }
}

/** Request mínimo: las rutas solo usan `request.json()`. */
export function jsonRequest(body?: unknown): Request {
  return {
    json: async () => body,
  } as unknown as Request
}

/** Request cuyo cuerpo no es JSON válido (llamada rota). */
export function brokenJsonRequest(): Request {
  return {
    json: async () => {
      throw new Error('JSON roto')
    },
  } as unknown as Request
}

/** Forma del NextResponse mockeado. */
export interface TestResponse {
  status: number
  body: Record<string, unknown>
}
