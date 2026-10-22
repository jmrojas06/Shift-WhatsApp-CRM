import { describe, expect, it } from 'vitest'

import {
  MAX_QUESTIONS,
  QUESTION_LABEL_MAX,
  readQuestion,
  validateAnswer,
  validateQuestionCreate,
} from './questions'

describe('validateQuestionCreate', () => {
  it('acepta una pregunta de texto', () => {
    expect(validateQuestionCreate({ label: 'Placa del carro', kind: 'texto' })).toEqual({
      ok: true,
      value: { label: 'Placa del carro', kind: 'texto', required: true, options: [] },
    })
  })

  it('recorta la etiqueta, respeta required=false e ignora opciones en tipos sin opciones', () => {
    expect(
      validateQuestionCreate({ label: '  Dirección  ', kind: 'direccion', required: false, options: ['a', 'b'] }),
    ).toEqual({
      ok: true,
      value: { label: 'Dirección', kind: 'direccion', required: false, options: [] },
    })
  })

  it('opción exige entre 2 y 10 opciones cortas', () => {
    expect(validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['Norte'] }).ok).toBe(false)
    expect(
      validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['Norte', 'Sur'] }).ok,
    ).toBe(true)
    expect(
      validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['x'.repeat(25), 'Sur'] }).ok,
    ).toBe(false)
    const eleven = Array.from({ length: 11 }, (_, i) => `Op ${i}`)
    expect(validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: eleven }).ok).toBe(false)
    expect(validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: eleven.slice(0, 10) }).ok).toBe(true)
    expect(validateQuestionCreate({ label: 'Sede', kind: 'opcion' }).ok).toBe(false)
  })

  it('las opciones vacías no cuentan', () => {
    expect(
      validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['Norte', '  ', ''] }).ok,
    ).toBe(false)
  })

  it('rechaza opciones que no son texto', () => {
    expect(
      validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['Norte', 3, 'Sur'] }).ok,
    ).toBe(false)
  })

  it('rechaza tipos desconocidos y etiquetas vacías', () => {
    expect(validateQuestionCreate({ label: 'X', kind: 'foto' }).ok).toBe(false)
    expect(validateQuestionCreate({ label: '  ', kind: 'texto' }).ok).toBe(false)
    expect(validateQuestionCreate({ kind: 'texto' }).ok).toBe(false)
    expect(validateQuestionCreate(null).ok).toBe(false)
    expect(validateQuestionCreate([]).ok).toBe(false)
  })

  it('etiqueta de hasta 80 se acepta, de 81 no; required debe ser booleano', () => {
    expect(validateQuestionCreate({ label: 'x'.repeat(QUESTION_LABEL_MAX), kind: 'texto' }).ok).toBe(true)
    expect(validateQuestionCreate({ label: 'x'.repeat(QUESTION_LABEL_MAX + 1), kind: 'texto' }).ok).toBe(false)
    expect(validateQuestionCreate({ label: 'X', kind: 'texto', required: 'si' }).ok).toBe(false)
  })

  it('rechaza caracteres de control o de formato en etiqueta y opciones', () => {
    const label = validateQuestionCreate({ label: 'Pla​ca', kind: 'texto' })
    expect(label).toEqual({ ok: false, message: 'La pregunta tiene caracteres no permitidos.' })
    expect(validateQuestionCreate({ label: 'Pla\nca', kind: 'texto' }).ok).toBe(false)

    const option = validateQuestionCreate({ label: 'Sede', kind: 'opcion', options: ['No​rte', 'Sur'] })
    expect(option).toEqual({ ok: false, message: 'Las opciones tienen caracteres no permitidos.' })
  })

  it('MAX_QUESTIONS es 5', () => {
    expect(MAX_QUESTIONS).toBe(5)
  })
})

describe('readQuestion', () => {
  const row = {
    id: 'q1',
    label: 'Placa',
    kind: 'texto',
    required: true,
    options: [],
    position: 0,
  }

  it('lee una fila válida', () => {
    expect(readQuestion(row)).toEqual({ id: 'q1', label: 'Placa', kind: 'texto', required: true, options: [] })
  })

  it('required solo es false si es false; las opciones se ignoran fuera de "opcion"', () => {
    expect(readQuestion({ ...row, required: false, options: ['a', 'b'] })).toMatchObject({
      required: false,
      options: [],
    })
    expect(readQuestion({ ...row, required: null })).toMatchObject({ required: true })
  })

  it('devuelve null para lo que no es una fila', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}]) expect(readQuestion(bad)).toBeNull()
  })

  it('devuelve null con tipo malo, etiqueta vacía o id ausente', () => {
    expect(readQuestion({ ...row, kind: 'foto' })).toBeNull()
    expect(readQuestion({ ...row, kind: undefined })).toBeNull()
    expect(readQuestion({ ...row, label: '   ' })).toBeNull()
    expect(readQuestion({ ...row, label: 42 })).toBeNull()
    expect(readQuestion({ ...row, id: undefined })).toBeNull()
  })

  it('recorta la etiqueta y la limita a 80', () => {
    expect(readQuestion({ ...row, label: '  Placa  ' })?.label).toBe('Placa')
    expect(readQuestion({ ...row, label: 'x'.repeat(120) })?.label).toBe('x'.repeat(QUESTION_LABEL_MAX))
  })

  it('opcion: 2 a 10 opciones; recorta a 24 y limpia vacías', () => {
    const base = { ...row, kind: 'opcion' }
    expect(readQuestion({ ...base, options: ['Norte'] })).toBeNull()
    expect(readQuestion({ ...base, options: [] })).toBeNull()
    expect(readQuestion({ ...base, options: null })).toBeNull()
    expect(readQuestion({ ...base, options: [' Norte ', ' Sur ', ''] })?.options).toEqual(['Norte', 'Sur'])
    expect(readQuestion({ ...base, options: ['x'.repeat(40), 'Sur'] })?.options).toEqual(['x'.repeat(24), 'Sur'])
    const eleven = Array.from({ length: 11 }, (_, i) => `Op ${i}`)
    expect(readQuestion({ ...base, options: eleven })).toBeNull()
  })

  it('opcion: una opción que no es texto descarta la fila', () => {
    expect(readQuestion({ ...row, kind: 'opcion', options: ['Norte', 3] })).toBeNull()
    expect(readQuestion({ ...row, kind: 'opcion', options: ['Norte', null] })).toBeNull()
  })

  it('descarta la fila si etiqueta u opciones traen caracteres de control o formato', () => {
    expect(readQuestion({ ...row, label: 'Pla​ca' })).toBeNull()
    expect(readQuestion({ ...row, label: 'Pla\u0007ca' })).toBeNull()
    expect(readQuestion({ ...row, kind: 'opcion', options: ['No‮rte', 'Sur'] })).toBeNull()
  })

  it('nunca lanza con objetos raros', () => {
    const hostile = {
      get id(): string {
        return 'q1'
      },
      label: 'ok',
      kind: 'opcion',
      options: { length: 2 },
    }
    expect(() => readQuestion(hostile)).not.toThrow()
    expect(readQuestion(hostile)).toBeNull()
  })
})

describe('validateAnswer', () => {
  const numero = { id: 'q1', label: 'Personas', kind: 'numero' as const, required: true, options: [] }
  const texto = { id: 'q2', label: 'Motivo', kind: 'texto' as const, required: false, options: [] }

  it('número: solo dígitos', () => {
    expect(validateAnswer(numero, ' 4 ')).toEqual({ ok: true, value: '4' })
    expect(validateAnswer(numero, 'cuatro')).toEqual({ ok: false, reason: 'number' })
  })

  it('texto opcional vacío se acepta; obligatorio no', () => {
    expect(validateAnswer(texto, '')).toEqual({ ok: true, value: '' })
    expect(validateAnswer({ ...texto, required: true }, '')).toEqual({ ok: false, reason: 'required' })
  })

  it('respuestas largas se rechazan', () => {
    expect(validateAnswer(texto, 'x'.repeat(201))).toEqual({ ok: false, reason: 'too_long' })
  })
})
