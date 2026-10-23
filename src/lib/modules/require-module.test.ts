import { beforeEach, describe, expect, it, vi } from 'vitest'

// toErrorResponse real arrastra next/headers; aquí solo importa que
// los errores que no son de módulo se deleguen a él.
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (err: unknown) => ({
    body: { error: 'delegado' },
    status: 500,
    err,
  }),
}))
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

import {
  ModuleNotActiveError,
  moduleNotActiveMessage,
  requireModule,
  toModuleErrorResponse,
} from './require-module'

type Result = { data: unknown; error: unknown }

const h = vi.hoisted(() => ({
  results: [] as { data: unknown; error: unknown }[],
  selects: [] as string[],
  eqs: [] as [string, unknown][],
}))

function makeCtx() {
  return {
    accountId: 'acc-1',
    supabase: {
      from: (table: string) => {
        expect(table).toBe('accounts')
        const chain = {
          select: (cols: string) => {
            h.selects.push(cols)
            return chain
          },
          eq: (col: string, value: unknown) => {
            h.eqs.push([col, value])
            return chain
          },
          maybeSingle: async () =>
            h.results.shift() ?? ({ data: null, error: null } as Result),
        }
        return chain
      },
    },
  } as never
}

beforeEach(() => {
  h.results = []
  h.selects = []
  h.eqs = []
})

describe('requireModule', () => {
  it('deja pasar cuando la cuenta tiene el módulo en modules', async () => {
    h.results = [
      { data: { modules: ['agenda', 'ventas'], vertical_key: null }, error: null },
    ]
    await expect(requireModule(makeCtx(), 'ventas')).resolves.toBeUndefined()
    expect(h.selects).toEqual(['modules, vertical_key'])
    expect(h.eqs).toEqual([['id', 'acc-1']])
  })

  it('cae a vertical_key (también la clave vieja barberia)', async () => {
    h.results = [{ data: { modules: [], vertical_key: 'barberia' }, error: null }]
    await expect(requireModule(makeCtx(), 'agenda')).resolves.toBeUndefined()
  })

  it('lanza ModuleNotActiveError (409) si la cuenta no tiene el módulo', async () => {
    h.results = [{ data: { modules: ['agenda'], vertical_key: null }, error: null }]
    const err = await requireModule(makeCtx(), 'ventas').catch((e) => e)
    expect(err).toBeInstanceOf(ModuleNotActiveError)
    expect(err.status).toBe(409)
    expect(err.moduleKey).toBe('ventas')
    expect(err.message).toBe('El módulo Ventas no está activo para esta cuenta.')
  })

  it('lanza si la cuenta no existe o no se puede leer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.results = [{ data: null, error: null }]
    await expect(requireModule(makeCtx(), 'agenda')).rejects.toBeInstanceOf(
      ModuleNotActiveError,
    )
    h.results = [{ data: null, error: { code: '57014', message: 'timeout' } }]
    await expect(requireModule(makeCtx(), 'agenda')).rejects.toBeInstanceOf(
      ModuleNotActiveError,
    )
    consoleError.mockRestore()
  })

  it('antes de la migración 053 (sin columna modules) usa vertical_key', async () => {
    h.results = [
      { data: null, error: { code: '42703', message: 'column modules does not exist' } },
      { data: { vertical_key: 'agenda' }, error: null },
    ]
    await expect(requireModule(makeCtx(), 'agenda')).resolves.toBeUndefined()
    expect(h.selects).toEqual(['modules, vertical_key', 'vertical_key'])

    h.results = [
      { data: null, error: { code: '42703', message: 'x' } },
      { data: { vertical_key: null }, error: null },
    ]
    await expect(requireModule(makeCtx(), 'agenda')).rejects.toBeInstanceOf(
      ModuleNotActiveError,
    )
  })
})

describe('toModuleErrorResponse', () => {
  it('traduce ModuleNotActiveError a 409 con el mensaje en español', () => {
    const res = toModuleErrorResponse(
      new ModuleNotActiveError('agenda'),
    ) as unknown as { body: { error: string }; status: number }
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('El módulo Agenda no está activo para esta cuenta.')
  })

  it('delega todo lo demás a toErrorResponse', () => {
    const boom = new Error('boom')
    const res = toModuleErrorResponse(boom) as unknown as {
      status: number
      err: unknown
    }
    expect(res.status).toBe(500)
    expect(res.err).toBe(boom)
  })
})

describe('moduleNotActiveMessage', () => {
  it('usa el nombre del manifest', () => {
    expect(moduleNotActiveMessage('ventas')).toBe(
      'El módulo Ventas no está activo para esta cuenta.',
    )
  })
})
