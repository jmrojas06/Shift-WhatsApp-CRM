import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Tests de la ruta de instalación.
//
// Se mockean auth (requireRole/toErrorResponse), el cliente
// service-role y el instalador: aquí se verifica el contrado de la
// ruta — rol mínimo, vertical activo y que el instalador reciba el
// service-role con la cuenta correcta. La lógica de siembra tiene su
// propio test con un fake de base de datos (install.test.ts).
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    /** Rol que devolverá el requireRole mockeado. */
    role: 'owner' as 'owner' | 'admin' | 'viewer',
    /** vertical_key que reporta la cuenta. */
    verticalKey: 'agenda' as string | null,
    /** Error simulado en el select de la cuenta (p. ej. 047 sin aplicar). */
    verticalError: null as { code: string; message: string } | null,
    /** Llamadas capturadas al instalador. */
    installCalls: [] as {
      accountId: string
      userId: string
      db: unknown
      presetKey?: string
    }[],
    installError: null as Error | null,
    /** Cliente service-role falso que debe llegar al instalador. */
    adminClient: { kind: 'service-role' },
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

vi.mock('@/lib/auth/account', () => {
  const RANK: Record<string, number> = { viewer: 1, agent: 2, admin: 3, owner: 4 }
  return {
    requireRole: async (min: string) => {
      if (RANK[h.state.role] < RANK[min]) {
        const err = new Error('No tienes permiso para esta acción.') as Error & {
          status: number
        }
        err.status = 403
        throw err
      }
      return {
        accountId: 'acc-1',
        userId: 'user-1',
        role: h.state.role,
        account: { id: 'acc-1', name: 'Barbería de prueba' },
        supabase: {
          from: () => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: h.state.verticalError
                    ? null
                    : { vertical_key: h.state.verticalKey },
                  error: h.state.verticalError,
                }),
              }),
            }),
          }),
        },
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
})

vi.mock('@/lib/verticals/admin-client', () => ({
  supabaseAdmin: () => h.state.adminClient,
}))

vi.mock('@/verticals/agenda/install', () => ({
  installAgendaTemplate: async (args: {
    accountId: string
    userId: string
    db: unknown
    presetKey?: string
  }) => {
    h.state.installCalls.push(args)
    if (h.state.installError) throw h.state.installError
    return {
      services: { created: 3, skipped: 0 },
      staff: { created: 1, skipped: 0 },
      staffServices: { created: 3, skipped: 0 },
      workingHours: { created: 12, skipped: 0 },
      tags: { created: 6, skipped: 0 },
      customFields: { created: 2, skipped: 0 },
      pipeline: { created: true, stagesCreated: 5 },
      quickReplies: { created: 4, skipped: 0 },
      knowledge: { created: 5, skipped: 0 },
      aiPrompt: 'written',
      warnings: [],
    }
  },
}))

import { POST } from './route'

/** Pide la instalación; sin `body` el cuerpo va vacío (el botón de siempre). */
const post = (body?: BodyInit) =>
  new Request('http://localhost/api/verticals/agenda/setup', { method: 'POST', body })

type TestResponse = { status: number; body: { error?: string; report?: unknown } }

beforeEach(() => {
  h.state.role = 'owner'
  h.state.verticalKey = 'agenda'
  h.state.verticalError = null
  h.state.installCalls = []
  h.state.installError = null
})

describe('POST /api/verticals/agenda/setup', () => {
  it('instala con el service-role y responde el reporte', async () => {
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.report).toMatchObject({
      services: { created: 3, skipped: 0 },
      aiPrompt: 'written',
    })
    expect(h.state.installCalls).toHaveLength(1)
    expect(h.state.installCalls[0].accountId).toBe('acc-1')
    expect(h.state.installCalls[0].userId).toBe('user-1')
    // Nunca el cliente del usuario: el instalador escribe con service-role.
    expect(h.state.installCalls[0].db).toBe(h.state.adminClient)
  })

  it('sin cuerpo no pide punto de partida: el instalador usa el de la cuenta', async () => {
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.installCalls[0].presetKey).toBeUndefined()
  })

  it('un cuerpo sin preset_key tampoco lo pide', async () => {
    const res = (await POST(post('{}'))) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.installCalls[0].presetKey).toBeUndefined()
  })

  it('pasa el punto de partida elegido al instalador', async () => {
    const res = (await POST(post(JSON.stringify({ preset_key: 'salud' })))) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.installCalls).toHaveLength(1)
    expect(h.state.installCalls[0].presetKey).toBe('salud')
    expect(h.state.installCalls[0].db).toBe(h.state.adminClient)
  })

  it.each(['tienda', '', 3, ['salud'], { a: 1 }])(
    'rechaza preset_key inválido (%j) con 400 y no instala',
    async (preset_key) => {
      const res = (await POST(post(JSON.stringify({ preset_key })))) as unknown as TestResponse

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Ese punto de partida no existe.')
      expect(h.state.installCalls).toHaveLength(0)
    },
  )

  it.each(['[]', '"salud"', '42', 'null'])(
    'rechaza un cuerpo que no es un objeto (%s)',
    async (raw) => {
      const res = (await POST(post(raw))) as unknown as TestResponse

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('El cuerpo no es JSON válido.')
      expect(h.state.installCalls).toHaveLength(0)
    },
  )

  it.each(['{"preset_key":', 'salud', '{preset_key: "salud"}'])(
    'un JSON roto (%s) es 400, no el punto de partida por defecto',
    async (raw) => {
      const res = (await POST(post(raw))) as unknown as TestResponse

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('El cuerpo no es JSON válido.')
      expect(h.state.installCalls).toHaveLength(0)
    },
  )

  it('un cuerpo en blanco cuenta como vacío: usa el de la cuenta', async () => {
    const res = (await POST(post('  \n '))) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.installCalls[0].presetKey).toBeUndefined()
  })

  it('con un punto de partida inválido, un viewer sigue recibiendo 403', async () => {
    h.state.role = 'viewer'
    const res = (await POST(post(JSON.stringify({ preset_key: 'tienda' })))) as unknown as TestResponse

    expect(res.status).toBe(403)
  })

  it('permite a un admin (el límite exacto del rol)', async () => {
    h.state.role = 'admin'
    const res = (await POST(post())) as unknown as TestResponse
    expect(res.status).toBe(200)
    expect(h.state.installCalls).toHaveLength(1)
  })

  it('acepta la clave anterior barberia (cuentas sin migrar)', async () => {
    h.state.verticalKey = 'barberia'
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(h.state.installCalls).toHaveLength(1)
  })

  it('rechaza a un agente/viewer con 403 y no instala nada', async () => {
    h.state.role = 'viewer'
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(403)
    expect(h.state.installCalls).toHaveLength(0)
  })

  it('rechaza una cuenta sin el vertical de la agenda', async () => {
    h.state.verticalKey = 'inmobiliaria'
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('no está habilitado')
    expect(h.state.installCalls).toHaveLength(0)
  })

  it('rechaza también cuando vertical_key es null', async () => {
    h.state.verticalKey = null
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(409)
    expect(h.state.installCalls).toHaveLength(0)
  })

  it('trata una columna ausente (047 sin aplicar) como módulo no habilitado', async () => {
    h.state.verticalError = {
      code: '42703',
      message: 'column accounts.vertical_key does not exist',
    }
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('no está habilitado')
    expect(h.state.installCalls).toHaveLength(0)
  })

  it('convierte un fallo del instalador en 500 sin filtrar detalles', async () => {
    h.state.installError = new Error('boom secreto')
    const res = (await POST(post())) as unknown as TestResponse

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Error interno.')
  })
})
