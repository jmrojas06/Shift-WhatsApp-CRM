import { beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================
// /api/whatsapp/config — guard de rol en las mutaciones (A8).
//
// La RLS ya rechazaba la escritura de un agente, pero solo DESPUÉS de
// que la ruta llamara a Meta (registro / suscripción del WABA), y el
// DELETE de un agente respondía `success: true` sin borrar nada. Ahora
// POST y DELETE exigen owner/admin antes de tocar Meta o la base.
// El `requireRole` real corre contra un cliente de Supabase simulado.
// ============================================================

const state = vi.hoisted(() => ({
  role: 'agent' as string,
  deletes: 0,
}))

function makeSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from(table: string) {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'neq', 'update', 'insert', 'upsert']) {
        b[m] = vi.fn(chain)
      }
      b.delete = vi.fn(() => {
        if (table === 'whatsapp_config') state.deletes += 1
        return b
      })
      const result = () => {
        if (table === 'profiles') {
          return {
            data: { account_id: 'acct-1', account_role: state.role },
            error: null,
          }
        }
        if (table === 'accounts') {
          return { data: { id: 'acct-1', name: 'Barbería' }, error: null }
        }
        return { data: null, error: null }
      }
      b.maybeSingle = vi.fn(async () => result())
      b.single = vi.fn(async () => result())
      b.then = (resolve: (v: unknown) => unknown) => resolve(result())
      return b
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSupabaseMock()),
}))

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(async () => ({ display_phone_number: '+57 300' })),
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => ({ success: true })),
  getSubscribedApps: vi.fn(async () => []),
  listWabaPhoneNumbers: vi.fn(async () => []),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: vi.fn(() => makeSupabaseMock()),
}))

import { DELETE, POST } from './route'

function postConfig() {
  return POST(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number_id: '123456789',
        waba_id: '987654321',
        access_token: 'EAAG-test-token',
        pin: '123456',
      }),
    }),
  )
}

beforeEach(() => {
  state.role = 'agent'
  state.deletes = 0
  for (const fn of Object.values(meta)) fn.mockClear()
})

describe('POST /api/whatsapp/config', () => {
  it.each(['agent', 'viewer'])('un %s recibe 403 antes de llamar a Meta', async (role) => {
    state.role = role

    const res = await postConfig()

    expect(res.status).toBe(403)
    for (const fn of Object.values(meta)) expect(fn).not.toHaveBeenCalled()
  })

  it('un admin pasa el guard y llega a verificar con Meta', async () => {
    state.role = 'admin'

    await postConfig()

    expect(meta.verifyPhoneNumber).toHaveBeenCalled()
  })
})

describe('DELETE /api/whatsapp/config', () => {
  it('un agente recibe 403 y no se intenta borrar nada', async () => {
    const res = await DELETE()

    expect(res.status).toBe(403)
    expect(state.deletes).toBe(0)
  })

  it('un owner puede desconectar el número', async () => {
    state.role = 'owner'

    const res = await DELETE()

    expect(res.status).toBe(200)
    expect(state.deletes).toBe(1)
  })
})
