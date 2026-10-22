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
    // Con 3 opciones o menos van como botones (20); con más, como lista (24).
    expect(readQuestion({ ...base, options: ['x'.repeat(40), 'Sur'] })?.options).toEqual(['x'.repeat(20), 'Sur'])
    expect(readQuestion({ ...base, options: ['x'.repeat(40), 'b', 'c', 'd'] })?.options).toEqual([
      'x'.repeat(24),
      'b',
      'c',
      'd',
    ])
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

describe('validateQuestionCreate: opciones estrictas', () => {
  const opcion = (options: unknown[]) => validateQuestionCreate({ label: 'Sede', kind: 'opcion', options })
  const four = (first: string) => [first, 'b', 'c', 'd']

  it('con 3 opciones o menos (botones) cada una admite hasta 20', () => {
    expect(opcion(['x'.repeat(20), 'Sur']).ok).toBe(true)
    expect(opcion(['x'.repeat(21), 'Sur'])).toEqual({
      ok: false,
      message: 'Con 3 opciones o menos, cada una puede tener hasta 20 caracteres.',
    })
    expect(opcion(['a', 'b', 'x'.repeat(21)]).ok).toBe(false)
  })

  it('con más de 3 opciones (lista) admite hasta 24', () => {
    expect(opcion(four('x'.repeat(24))).ok).toBe(true)
    expect(opcion(four('x'.repeat(25))).ok).toBe(false)
    expect(opcion(four('😀'.repeat(24))).ok).toBe(true)
    expect(opcion(['😀'.repeat(20), 'b']).ok).toBe(true)
    expect(opcion(['😀'.repeat(21), 'b']).ok).toBe(false)
  })

  it('rechaza opciones repetidas tras normalizar mayúsculas, tildes y espacios', () => {
    const dup = { ok: false, message: 'Las opciones no se pueden repetir.' }
    expect(opcion(['Norte', 'norte'])).toEqual(dup)
    expect(opcion(['Médico', 'medico'])).toEqual(dup)
    expect(opcion(['Sede  Norte', ' sede norte '])).toEqual(dup)
    expect(opcion(['Norte', 'Sur', 'NORTE'])).toEqual(dup)
    expect(opcion(['Norte', 'Sur']).ok).toBe(true)
  })

  it('rechaza opciones que son solo números', () => {
    const msg = { ok: false, message: 'Las opciones no pueden ser solo números.' }
    expect(opcion(['1', 'Sur'])).toEqual(msg)
    expect(opcion(['Norte', ' 2 '])).toEqual(msg)
    expect(opcion(['Sede 1', 'Sede 2']).ok).toBe(true)
  })

  it('rechaza surrogates sueltos y deja pasar VS16 y modificadores de tono de piel', () => {
    expect(validateQuestionCreate({ label: 'a\uD800b', kind: 'texto' }).ok).toBe(false)
    expect(validateQuestionCreate({ label: '', kind: 'texto' }).ok).toBe(false)
    expect(opcion(['No\uD800rte', 'Sur']).ok).toBe(false)
    expect(opcion(['', 'Sur']).ok).toBe(false)
    expect(validateQuestionCreate({ label: '¿Te gusta ❤️?', kind: 'texto' }).ok).toBe(true)
    expect(validateQuestionCreate({ label: 'Mano 👍🏽', kind: 'texto' }).ok).toBe(true)
    expect(opcion(['❤️ Sí', '👍🏽 No']).ok).toBe(true)
  })

  it('conserva el espacio interno de una opción y recorta los bordes', () => {
    expect(opcion(['  Sede Norte  ', 'Sede Sur'])).toMatchObject({
      ok: true,
      value: { options: ['Sede Norte', 'Sede Sur'] },
    })
  })

  it('el largo de la etiqueta se cuenta en puntos de código', () => {
    expect(validateQuestionCreate({ label: 'x'.repeat(79) + '😀', kind: 'texto' }).ok).toBe(true)
    expect(validateQuestionCreate({ label: '😀'.repeat(81), kind: 'texto' }).ok).toBe(false)
    expect(validateQuestionCreate({ label: '😀'.repeat(80), kind: 'texto' }).ok).toBe(true)
  })

  it('ignora campos que no son de la pregunta (id, account_id, position, is_active)', () => {
    expect(
      validateQuestionCreate({
        label: 'Placa',
        kind: 'texto',
        id: 'evil',
        account_id: 'acc-2',
        position: 99,
        is_active: false,
      }),
    ).toEqual({ ok: true, value: { label: 'Placa', kind: 'texto', required: true, options: [] } })
  })
})

describe('readQuestion: opciones estrictas', () => {
  const base = { id: 'q1', label: 'Sede', kind: 'opcion', required: true }

  it('descarta la fila si dos opciones chocan tras recortar a 20', () => {
    expect(readQuestion({ ...base, options: ['x'.repeat(30), 'x'.repeat(25)] })).toBeNull()
    expect(readQuestion({ ...base, options: ['x'.repeat(30) + 'a', 'x'.repeat(30) + 'b'] })).toBeNull()
  })

  it('descarta la fila si alguna opción es solo números', () => {
    expect(readQuestion({ ...base, options: ['1', 'Sur'] })).toBeNull()
    expect(readQuestion({ ...base, options: ['Norte', ' 2 ', 'Sur', 'Este'] })).toBeNull()
    expect(readQuestion({ ...base, options: ['Sede 1', 'Sede 2'] })).not.toBeNull()
  })

  it('descarta la fila con opciones repetidas por mayúsculas o tildes', () => {
    expect(readQuestion({ ...base, options: ['Médico', 'MEDICO'] })).toBeNull()
  })

  it('no descarta si con más de 3 opciones solo chocarían a 20 (recorta a 24)', () => {
    const options = ['x'.repeat(22) + 'a', 'x'.repeat(22) + 'b', 'c', 'd']
    expect(readQuestion({ ...base, options })?.options).toEqual(options)
  })
})

describe('validateAnswer: limpieza', () => {
  const texto = { id: 'q', label: 'Motivo', kind: 'texto' as const, required: true, options: [] }
  const numero = { ...texto, kind: 'numero' as const }

  it('junta los espacios y saltos de línea en un solo espacio', () => {
    expect(validateAnswer(texto, 'a\nb')).toEqual({ ok: true, value: 'a b' })
    expect(validateAnswer(texto, '  a \t\r\n  b  ')).toEqual({ ok: true, value: 'a b' })
  })

  it('quita caracteres de control y de formato (RLO, zero-width)', () => {
    expect(validateAnswer(texto, 'ho‮la')).toEqual({ ok: true, value: 'hola' })
    expect(validateAnswer(texto, 'ho​la')).toEqual({ ok: true, value: 'hola' })
    expect(validateAnswer(texto, 'ho\u0007la')).toEqual({ ok: true, value: 'hola' })
    expect(validateAnswer(texto, 'a ​ b')).toEqual({ ok: true, value: 'a b' })
  })

  it('aplica las reglas sobre el valor ya limpio', () => {
    expect(validateAnswer(texto, '​ \n')).toEqual({ ok: false, reason: 'required' })
    expect(validateAnswer({ ...texto, required: false }, '​')).toEqual({ ok: true, value: '' })
    expect(validateAnswer(numero, '4​2')).toEqual({ ok: true, value: '42' })
    expect(validateAnswer(numero, '4 2')).toEqual({ ok: false, reason: 'number' })
  })

  it('el tope de 200 cuenta puntos de código', () => {
    expect(validateAnswer(texto, '😀'.repeat(200))).toMatchObject({ ok: true })
    expect(validateAnswer(texto, '😀'.repeat(201))).toEqual({ ok: false, reason: 'too_long' })
    expect(validateAnswer(texto, 'x'.repeat(200))).toMatchObject({ ok: true })
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
