import { describe, expect, it } from 'vitest'

import { ConfigError } from './config'
import { createQuestion, deleteQuestion, listQuestions, updateQuestion } from './config-repo'
import { asClient, makeFakeDb, type Row } from './agent/testing/fake-db'

// ============================================================
// Repositorio de preguntas extra — fake de PostgREST.
// ============================================================

const ACCOUNT = 'acc-1'
const OTHER = 'acc-2'

const q = (id: string, position: number, extra: Row = {}): Row => ({
  id,
  account_id: ACCOUNT,
  label: `Pregunta ${id}`,
  kind: 'texto',
  required: true,
  options: [],
  position,
  is_active: true,
  ...extra,
})

describe('listQuestions', () => {
  it('ordena por posición y luego por id, solo activas de la cuenta', async () => {
    const db = makeFakeDb({
      booking_questions: [
        q('c', 1),
        q('b', 0),
        q('a', 0),
        q('off', 0, { is_active: false }),
        q('x', 0, { account_id: OTHER }),
      ],
    })

    const list = await listQuestions(asClient(db), ACCOUNT)

    expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('salta las filas inválidas', async () => {
    const db = makeFakeDb({
      booking_questions: [
        q('ok', 0),
        q('bad-kind', 1, { kind: 'foto' }),
        q('bad-opts', 2, { kind: 'opcion', options: ['solo'] }),
        q('bad-label', 3, { label: 'a​b' }),
        q('ok2', 4),
      ],
    })

    const list = await listQuestions(asClient(db), ACCOUNT)

    expect(list.map((r) => r.id)).toEqual(['ok', 'ok2'])
  })

  it('nunca devuelve más de 5 aunque haya más filas', async () => {
    const db = makeFakeDb({
      booking_questions: Array.from({ length: 8 }, (_, i) => q(`q${i}`, i)),
    })

    const list = await listQuestions(asClient(db), ACCOUNT)

    expect(list.map((r) => r.id)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4'])
  })

  it('una lectura fallida lanza (no se confunde con "sin preguntas")', async () => {
    const db = makeFakeDb({ booking_questions: [q('a', 0)] })
    db._failNext('select', 'booking_questions', { message: 'boom' })

    await expect(listQuestions(asClient(db), ACCOUNT)).rejects.toMatchObject({ message: 'boom' })
  })
})

describe('createQuestion', () => {
  const input = { label: 'Otra', kind: 'texto' as const, required: true, options: [] }

  it('con 5 activas lanza ConfigError limit_reached', async () => {
    const db = makeFakeDb({
      booking_questions: Array.from({ length: 5 }, (_, i) => q(`q${i}`, i)),
    })

    const err = await createQuestion(asClient(db), ACCOUNT, input).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).code).toBe('limit_reached')
  })

  it('una escritura fallida lanza y no deja nada', async () => {
    const db = makeFakeDb({ booking_questions: [] })
    db._failNext('insert', 'booking_questions', { message: 'check violation', code: '23514' })

    await expect(createQuestion(asClient(db), ACCOUNT, input)).rejects.toMatchObject({ code: '23514' })
    expect(db._tables.booking_questions).toHaveLength(0)
  })
})

describe('updateQuestion / deleteQuestion', () => {
  const input = { label: 'Nueva', kind: 'texto' as const, required: false, options: [] }

  it('solo tocan filas activas de la cuenta', async () => {
    const db = makeFakeDb({
      booking_questions: [q('a', 0), q('off', 1, { is_active: false }), q('x', 0, { account_id: OTHER })],
    })
    const client = asClient(db)

    await expect(updateQuestion(client, ACCOUNT, 'x', input)).rejects.toBeInstanceOf(ConfigError)
    await expect(updateQuestion(client, ACCOUNT, 'off', input)).rejects.toBeInstanceOf(ConfigError)
    await expect(deleteQuestion(client, ACCOUNT, 'x')).rejects.toBeInstanceOf(ConfigError)
    await expect(deleteQuestion(client, ACCOUNT, 'off')).rejects.toBeInstanceOf(ConfigError)

    expect(db._tables.booking_questions.find((r) => r.id === 'x')).toMatchObject({
      label: 'Pregunta x',
      is_active: true,
    })
    expect(db._tables.booking_questions.find((r) => r.id === 'off')?.label).toBe('Pregunta off')
  })

  it('un id que no es uuid (22P02 de Postgres) se trata como inexistente, no como error 500', async () => {
    const invalidUuid = { message: 'invalid input syntax for type uuid: "abc"', code: '22P02' }
    const db = makeFakeDb({ booking_questions: [q('a', 0)] })
    const client = asClient(db)

    db._failNext('update', 'booking_questions', invalidUuid)
    await expect(updateQuestion(client, ACCOUNT, 'abc', input)).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'not_found',
    })

    db._failNext('update', 'booking_questions', invalidUuid)
    await expect(deleteQuestion(client, ACCOUNT, 'abc')).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'not_found',
    })

    // Otros errores de la base siguen subiendo tal cual.
    db._failNext('update', 'booking_questions', { message: 'boom' })
    await expect(updateQuestion(client, ACCOUNT, 'a', input)).rejects.toMatchObject({ message: 'boom' })
  })

  it('actualizar devuelve la pregunta y desactivar la saca de la lista', async () => {
    const db = makeFakeDb({ booking_questions: [q('a', 0), q('b', 1)] })
    const client = asClient(db)

    expect(await updateQuestion(client, ACCOUNT, 'a', input)).toEqual({ id: 'a', ...input })
    await deleteQuestion(client, ACCOUNT, 'a')

    expect((await listQuestions(client, ACCOUNT)).map((r) => r.id)).toEqual(['b'])
    expect(db._tables.booking_questions).toHaveLength(2)
  })
})
