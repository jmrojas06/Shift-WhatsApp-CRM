import { describe, expect, it } from 'vitest'

import { ACCOUNT_SELECTS, selectAccountWithFallback } from './account-select'

type Result = { data: unknown; error: { code?: string; message?: string } | null }

/** Cliente falso: cada lectura toma la siguiente respuesta y anota el select. */
function fakeClient(results: Result[]) {
  const selects: string[] = []
  const eqs: [string, unknown][] = []
  const client = {
    from: (table: string) => {
      expect(table).toBe('accounts')
      const chain = {
        select: (cols: string) => {
          selects.push(cols)
          return chain
        },
        eq: (col: string, value: unknown) => {
          eqs.push([col, value])
          return chain
        },
        maybeSingle: async () => results.shift() ?? { data: null, error: null },
      }
      return chain
    },
  }
  return { client: client as never, selects, eqs }
}

const missing = (message: string): Result => ({
  data: null,
  error: { code: '42703', message },
})

describe('selectAccountWithFallback', () => {
  it('con el esquema nuevo (053) lee todo en una sola consulta', async () => {
    const row = { id: 'a', name: 'A', modules: ['agenda'] }
    const { client, selects, eqs } = fakeClient([{ data: row, error: null }])
    const res = await selectAccountWithFallback(client, 'a')
    expect(res).toEqual({ data: row, error: null })
    expect(selects).toEqual([ACCOUNT_SELECTS[0]])
    expect(selects[0]).toContain('modules')
    expect(eqs).toEqual([['id', 'a']])
  })

  it('antes de 053 (sin modules) repite sin esa columna', async () => {
    const row = { id: 'a', name: 'A', vertical_key: 'agenda' }
    const { client, selects } = fakeClient([
      missing('column accounts.modules does not exist'),
      { data: row, error: null },
    ])
    const res = await selectAccountWithFallback(client, 'a')
    expect(res.data).toEqual(row)
    expect(selects).toEqual([ACCOUNT_SELECTS[0], ACCOUNT_SELECTS[1]])
    expect(selects[1]).toContain('vertical_key')
    expect(selects[1]).not.toContain('modules')
  })

  it('antes de 047 (sin vertical_key) cae a la lista mínima', async () => {
    const row = { id: 'a', name: 'A', default_currency: 'USD' }
    const { client, selects } = fakeClient([
      missing('modules'),
      missing('vertical_key'),
      { data: row, error: null },
    ])
    const res = await selectAccountWithFallback(client, 'a')
    expect(res.data).toEqual(row)
    expect(selects).toEqual([...ACCOUNT_SELECTS])
    expect(selects[2]).not.toContain('vertical_key')
  })

  it('PGRST204 también cuenta como columna ausente', async () => {
    const { client, selects } = fakeClient([
      { data: null, error: { code: 'PGRST204', message: 'x' } },
      { data: { id: 'a', name: 'A' }, error: null },
    ])
    await selectAccountWithFallback(client, 'a')
    expect(selects).toHaveLength(2)
  })

  it('un error que no es de columna ausente no reintenta y se devuelve', async () => {
    const error = { code: '57014', message: 'timeout' }
    const { client, selects } = fakeClient([{ data: null, error }])
    const res = await selectAccountWithFallback(client, 'a')
    expect(res.error).toEqual(error)
    expect(selects).toHaveLength(1)
  })

  it('si la lista mínima también falla, devuelve ese último error', async () => {
    const { client } = fakeClient([
      missing('a'),
      missing('b'),
      missing('c'),
    ])
    const res = await selectAccountWithFallback(client, 'a')
    expect(res.error?.message).toBe('c')
  })
})
