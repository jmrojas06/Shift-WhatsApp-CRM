import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb, type Row } from '@/verticals/agenda/agent/testing/fake-db'

import { jsonRequest, TEST_ACCOUNT, type TestResponse } from '../_lib/route-testing'

// ============================================================
// POST /api/verticals/agenda/questions — crear una pregunta extra
// contra el fake de PostgREST: permisos, validación, límite de 5
// y cuenta de la sesión.
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

import { POST } from './route'

function baseSeed(): Record<string, Row[]> {
  return { booking_questions: [] }
}

function boot() {
  const db = makeFakeDb(baseSeed())
  h.state.db = db
  return db
}

const question = (id: string, account = TEST_ACCOUNT, active = true): Row => ({
  id,
  account_id: account,
  label: `P ${id}`,
  kind: 'texto',
  required: true,
  options: [],
  position: 0,
  is_active: active,
})

beforeEach(() => {
  h.state.role = 'owner'
})

describe('POST /api/verticals/agenda/questions', () => {
  it('crea la pregunta al final y en la cuenta de la sesión', async () => {
    const db = boot()

    const res = (await POST(
      jsonRequest({ label: 'Placa', kind: 'texto' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.question).toMatchObject({ label: 'Placa', kind: 'texto', required: true, options: [] })
    expect(db._tables.booking_questions).toHaveLength(1)
    expect(db._tables.booking_questions.at(-1)?.account_id).toBe(TEST_ACCOUNT)
  })

  it('una pregunta de opción guarda sus opciones recortadas', async () => {
    const db = boot()

    const res = (await POST(
      jsonRequest({ label: 'Sede', kind: 'opcion', required: false, options: [' Norte ', 'Sur'] }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(res.body.question).toMatchObject({ kind: 'opcion', required: false, options: ['Norte', 'Sur'] })
    expect(db._tables.booking_questions[0].options).toEqual(['Norte', 'Sur'])
  })

  it('la posición va al final aunque se haya desactivado una del medio', async () => {
    const db = boot()
    db._tables.booking_questions.push(
      { ...question('a'), position: 0 },
      { ...question('b', TEST_ACCOUNT, false), position: 1 },
      { ...question('c'), position: 2 },
    )

    const res = (await POST(jsonRequest({ label: 'Nueva', kind: 'texto' }))) as unknown as TestResponse

    expect(res.status).toBe(200)
    expect(db._tables.booking_questions.at(-1)?.position).toBe(3)
  })

  it('admin también puede (límite exacto del rol)', async () => {
    boot()
    h.state.role = 'admin'

    const res = (await POST(
      jsonRequest({ label: 'Placa', kind: 'texto' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
  })

  it('agent y viewer reciben 403 sin crear nada', async () => {
    const db = boot()
    for (const role of ['agent', 'viewer'] as const) {
      h.state.role = role
      const res = (await POST(
        jsonRequest({ label: 'Placa', kind: 'texto' }),
      )) as unknown as TestResponse
      expect(res.status).toBe(403)
    }
    expect(db._tables.booking_questions).toHaveLength(0)
  })

  it('400 con mensaje en es-CO si la pregunta no es válida', async () => {
    const db = boot()
    const cases: [unknown, string][] = [
      [{ kind: 'texto' }, 'Escribe la pregunta.'],
      [{ label: 'X', kind: 'foto' }, 'Ese tipo de pregunta no existe.'],
      [{ label: 'Sede', kind: 'opcion', options: ['Norte'] }, 'Pon entre 2 y 10 opciones.'],
      [null, 'La pregunta no es válida.'],
    ]
    for (const [body, message] of cases) {
      const res = (await POST(jsonRequest(body))) as unknown as TestResponse
      expect(res.status).toBe(400)
      expect(res.body.error).toBe(message)
    }
    expect(db._tables.booking_questions).toHaveLength(0)
  })

  it('no deja pasar de 5 preguntas (409 limit_reached)', async () => {
    const db = boot()
    for (let i = 0; i < 5; i++) {
      db._tables.booking_questions.push({ ...question(`q${i}`), position: i })
    }

    const res = (await POST(
      jsonRequest({ label: 'Otra', kind: 'texto' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('limit_reached')
    expect(db._tables.booking_questions).toHaveLength(5)
  })

  it('las preguntas desactivadas y las de otra cuenta no cuentan para el límite', async () => {
    const db = boot()
    for (let i = 0; i < 4; i++) db._tables.booking_questions.push({ ...question(`q${i}`), position: i })
    db._tables.booking_questions.push(
      question('off', TEST_ACCOUNT, false),
      question('x1', 'acc-2'),
      question('x2', 'acc-2'),
    )

    const res = (await POST(
      jsonRequest({ label: 'Otra', kind: 'texto' }),
    )) as unknown as TestResponse

    expect(res.status).toBe(200)
  })
})
