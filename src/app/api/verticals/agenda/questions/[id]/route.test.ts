import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../../_lib/route-testing'

// ============================================================
// PATCH / DELETE /api/verticals/agenda/questions/[id] — editar y
// desactivar contra el fake de PostgREST: permisos, validación,
// aislamiento por cuenta y "desactivar, no borrar".
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    role: 'owner' as 'owner' | 'admin' | 'agent' | 'viewer',
    db: null as unknown,
  },
}))

vi.mock('next/server', async () => {
  const { nextServerMock } = await import(
    '@/app/api/verticals/agenda/_lib/route-testing'
  )
  return nextServerMock()
})

vi.mock('@/lib/auth/account', async () => {
  const { authMockModule } = await import(
    '@/app/api/verticals/agenda/_lib/route-testing'
  )
  return authMockModule(h.state)
})

import { DELETE, PATCH } from './route'

function baseSeed(): Record<string, Row[]> {
  return {
    booking_questions: [
      {
        id: 'q-1',
        account_id: TEST_ACCOUNT,
        label: 'Placa',
        kind: 'texto',
        required: true,
        options: [],
        position: 0,
        is_active: true,
      },
      {
        id: 'q-off',
        account_id: TEST_ACCOUNT,
        label: 'Vieja',
        kind: 'texto',
        required: true,
        options: [],
        position: 1,
        is_active: false,
      },
      {
        id: 'q-other',
        account_id: 'acc-2',
        label: 'Ajena',
        kind: 'texto',
        required: true,
        options: [],
        position: 0,
        is_active: true,
      },
    ],
  }
}

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const row = (db: { _tables: Record<string, Row[]> }, id: string) =>
  db._tables.booking_questions.find((r) => r.id === id)

async function patch(id: string, body: unknown) {
  return (await PATCH(jsonRequest(body), ctx(id))) as unknown as TestResponse
}
async function del(id: string) {
  return (await DELETE(jsonRequest(null), ctx(id))) as unknown as TestResponse
}

beforeEach(() => {
  h.state.role = 'owner'
})

describe('PATCH /api/verticals/agenda/questions/[id]', () => {
  it('reemplaza la definición de una pregunta propia', async () => {
    const db = boot()

    const res = await patch('q-1', {
      label: 'Sede',
      kind: 'opcion',
      required: false,
      options: ['Norte', 'Sur'],
    })

    expect(res.status).toBe(200)
    expect(res.body.question).toEqual({
      id: 'q-1',
      label: 'Sede',
      kind: 'opcion',
      required: false,
      options: ['Norte', 'Sur'],
    })
    expect(row(db, 'q-1')).toMatchObject({ label: 'Sede', kind: 'opcion', position: 0, is_active: true })
  })

  it('ignora id, account_id, position e is_active que mande el cuerpo', async () => {
    const db = boot()

    const res = await patch('q-1', {
      label: 'Nueva',
      kind: 'texto',
      id: 'evil',
      account_id: 'acc-2',
      position: 99,
      is_active: false,
    })

    expect(res.status).toBe(200)
    expect(res.body.question).toMatchObject({ id: 'q-1', label: 'Nueva' })
    expect(row(db, 'q-1')).toMatchObject({
      id: 'q-1',
      account_id: TEST_ACCOUNT,
      position: 0,
      is_active: true,
      label: 'Nueva',
    })
    expect(row(db, 'evil')).toBeUndefined()
  })

  it('un id de otra cuenta responde 404 y no toca la fila ajena', async () => {
    const db = boot()

    const res = await patch('q-other', { label: 'Hackeada', kind: 'texto' })

    expect(res.status).toBe(404)
    expect(res.body.code).toBe('not_found')
    expect(row(db, 'q-other')?.label).toBe('Ajena')
  })

  it('una pregunta desactivada o inexistente responde 404', async () => {
    const db = boot()

    expect((await patch('q-off', { label: 'Revivida', kind: 'texto' })).status).toBe(404)
    expect((await patch('nope', { label: 'X', kind: 'texto' })).status).toBe(404)
    expect(row(db, 'q-off')).toMatchObject({ label: 'Vieja', is_active: false })
  })

  it('400 si el cuerpo no es válido y no escribe nada', async () => {
    const db = boot()

    const res = await patch('q-1', { label: '', kind: 'texto' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Escribe la pregunta.')
    expect(row(db, 'q-1')?.label).toBe('Placa')
  })

  it('agent y viewer reciben 403', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      expect((await patch('q-1', { label: 'Otra', kind: 'texto' })).status).toBe(403)
    }
    expect(row(db, 'q-1')?.label).toBe('Placa')
  })
})

describe('DELETE /api/verticals/agenda/questions/[id]', () => {
  it('desactiva la pregunta (no la borra)', async () => {
    const db = boot()

    const res = await del('q-1')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(row(db, 'q-1')?.is_active).toBe(false)
    expect(db._tables.booking_questions).toHaveLength(3)
  })

  it('admin también puede', async () => {
    const db = boot()
    h.state.role = 'admin'

    expect((await del('q-1')).status).toBe(200)
    expect(row(db, 'q-1')?.is_active).toBe(false)
  })

  it('agent y viewer reciben 403 y la pregunta sigue activa', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      expect((await del('q-1')).status).toBe(403)
    }
    expect(row(db, 'q-1')?.is_active).toBe(true)
  })

  it('un id de otra cuenta responde 404 y la fila ajena sigue activa', async () => {
    const db = boot()

    const res = await del('q-other')

    expect(res.status).toBe(404)
    expect(row(db, 'q-other')?.is_active).toBe(true)
  })

  it('desactivar dos veces responde 404 la segunda', async () => {
    boot()
    expect((await del('q-1')).status).toBe(200)
    expect((await del('q-1')).status).toBe(404)
  })
})
