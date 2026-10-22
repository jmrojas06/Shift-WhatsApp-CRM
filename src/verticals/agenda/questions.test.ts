import { describe, expect, it } from 'vitest'

import {
  ANSWERS_MAX_BYTES,
  clampAnswers,
  readAnswerMap,
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
    // Meta mide en UTF-16: un emoji vale 2.
    expect(opcion(four('😀'.repeat(12))).ok).toBe(true)
    expect(opcion(four('😀'.repeat(13))).ok).toBe(false)
    expect(opcion(['😀'.repeat(10), 'b']).ok).toBe(true)
    expect(opcion(['😀'.repeat(11), 'b']).ok).toBe(false)
  })

  it('rechaza opciones que solo se distinguen por puntuación', () => {
    const dup = { ok: false, message: 'Las opciones no se pueden repetir.' }
    expect(opcion(['A+', 'A-'])).toEqual(dup)
    expect(opcion(['Sí.', 'Si'])).toEqual(dup)
    expect(opcion(['Sede - Norte', 'sede norte'])).toEqual(dup)
    // Sin letras ni números no hay con qué comparar: se admiten.
    expect(opcion(['👍', '👎']).ok).toBe(true)
    expect(opcion(['👍', '👎', 'Tal vez']).ok).toBe(true)
    expect(opcion(['👍', '👍🏽']).ok).toBe(true)
  })

  it('el bot lee "1." y "2)" como números del menú', () => {
    const msg = { ok: false, message: 'Las opciones no pueden ser solo números.' }
    expect(opcion(['1.', 'Sur'])).toEqual(msg)
    expect(opcion(['Norte', '2)'])).toEqual(msg)
    expect(opcion(['1.5', 'Sur']).ok).toBe(true)
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

  it('recorta por unidades UTF-16 sin partir un emoji (botones 20, lista 24)', () => {
    // 12 emojis = 24 unidades: con botones se recorta a 10 emojis (20 unidades).
    expect(readQuestion({ ...base, options: ['😀'.repeat(12), 'b'] })?.options).toEqual([
      '😀'.repeat(10),
      'b',
    ])
    expect(readQuestion({ ...base, options: ['😀'.repeat(13), 'b', 'c', 'd'] })?.options).toEqual([
      '😀'.repeat(12),
      'b',
      'c',
      'd',
    ])
    const read = readQuestion({ ...base, options: ['ab'.repeat(15), 'x'] })
    expect(read?.options.every((o) => o.length <= 20)).toBe(true)
  })

  it('descarta la fila si dos opciones solo difieren en puntuación', () => {
    expect(readQuestion({ ...base, options: ['A+', 'A-'] })).toBeNull()
    expect(readQuestion({ ...base, options: ['👍', '👎'] })).not.toBeNull()
  })

  it('descarta la fila si una opción es solo número tras recortar o con punto', () => {
    expect(readQuestion({ ...base, options: ['1'.repeat(20) + 'abc', 'Sur'] })).toBeNull()
    expect(readQuestion({ ...base, options: ['1.', 'Sur'] })).toBeNull()
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

  it('quita sustitutos sueltos y conserva los emojis', () => {
    expect(validateAnswer(texto, 'ho\uD800la')).toEqual({ ok: true, value: 'hola' })
    expect(validateAnswer(texto, 'ho\uDC00la')).toEqual({ ok: true, value: 'hola' })
    expect(validateAnswer(texto, 'hola 😀')).toEqual({ ok: true, value: 'hola 😀' })
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

  it('número: acepta separadores de miles y un único entero dentro de una frase', () => {
    expect(validateAnswer(numero, '1.234.567')).toEqual({ ok: true, value: '1234567' })
    expect(validateAnswer(numero, '1,234')).toEqual({ ok: true, value: '1234' })
    expect(validateAnswer(numero, '1 234 567')).toEqual({ ok: true, value: '1234567' })
    expect(validateAnswer(numero, 'somos 4')).toEqual({ ok: true, value: '4' })
    expect(validateAnswer(numero, 'Somos 4 personas.')).toEqual({ ok: true, value: '4' })
    expect(validateAnswer(numero, 'son 1.500 pesos')).toEqual({ ok: true, value: '1500' })
    expect(validateAnswer(numero, '4 y 2')).toEqual({ ok: false, reason: 'number' })
    expect(validateAnswer(numero, 'somos 4 o 5')).toEqual({ ok: false, reason: 'number' })
    expect(validateAnswer(numero, '1.5')).toEqual({ ok: false, reason: 'number' })
    expect(validateAnswer(numero, 'cuatro')).toEqual({ ok: false, reason: 'number' })
  })

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

describe('readAnswerMap', () => {
  it('lee el formato nuevo { etiqueta, valor }', () => {
    expect(readAnswerMap({ q1: { label: 'Motivo', value: 'Control' } })).toEqual({
      q1: { label: 'Motivo', value: 'Control' },
    })
  })

  it('lee también el formato viejo de texto plano (sin etiqueta)', () => {
    expect(readAnswerMap({ q1: 'Control' })).toEqual({ q1: { label: '', value: 'Control' } })
    expect(readAnswerMap({ q1: 'Control', q2: { label: 'Sede', value: 'Sur' } })).toEqual({
      q1: { label: '', value: 'Control' },
      q2: { label: 'Sede', value: 'Sur' },
    })
  })

  it('descarta lo que no sirve y las respuestas vacías (salvo keepEmpty)', () => {
    const raw = { a: 3, b: null, c: { value: 7 }, d: { label: 'L', value: '' }, e: '', f: ['x'], g: { label: 'ok', value: 'v' } }
    expect(readAnswerMap(raw)).toEqual({ g: { label: 'ok', value: 'v' } })
    expect(readAnswerMap(raw, { keepEmpty: true })).toEqual({
      d: { label: 'L', value: '' },
      e: { label: '', value: '' },
      g: { label: 'ok', value: 'v' },
    })
    for (const bad of [null, undefined, 'x', 3, ['a']]) expect(readAnswerMap(bad)).toEqual({})
  })

  it('una etiqueta que no es texto queda vacía y una larga se recorta a 80', () => {
    expect(readAnswerMap({ q: { label: 5, value: 'v' } })).toEqual({ q: { label: '', value: 'v' } })
    const out = readAnswerMap({ q: { label: 'x'.repeat(200), value: 'v' } })
    expect([...out.q.label]).toHaveLength(QUESTION_LABEL_MAX)
  })

  it('una clave __proto__ no toca el prototipo', () => {
    const raw = JSON.parse('{"__proto__": {"label": "L", "value": "v"}}')
    const out = readAnswerMap(raw)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__'])
  })
})

describe('clampAnswers', () => {
  const entry = (value: string, label = 'Etiqueta') => ({ label, value })
  const bytes = (answers: object) => new TextEncoder().encode(JSON.stringify(answers)).length

  it('5 respuestas de 200 caracteres con etiqueta de 80 no se tocan', () => {
    const answers = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `11111111-1111-4111-8111-11111111111${i}`,
        entry('\u{1F600}'.repeat(200), 'e'.repeat(80)),
      ]),
    )
    expect(bytes(answers)).toBeLessThan(ANSWERS_MAX_BYTES)
    expect(clampAnswers(answers)).toEqual(answers)
  })

  it('quita las respuestas vacías y lo que no es texto', () => {
    expect(clampAnswers({ a: entry('x'), b: entry(''), c: 3 as never })).toEqual({ a: entry('x') })
    expect(clampAnswers(undefined)).toEqual({})
    expect(clampAnswers(null)).toEqual({})
  })

  it('acepta el formato viejo de texto plano', () => {
    expect(clampAnswers({ a: 'x' })).toEqual({ a: { label: '', value: 'x' } })
  })

  it('si el JSON pasa del tope acorta los valores más largos hasta que quepa', () => {
    const answers = { a: entry('x'.repeat(6000)), b: entry('y'.repeat(6000)), c: entry('corta') }
    const out = clampAnswers(answers)
    expect(bytes(out)).toBeLessThanOrEqual(ANSWERS_MAX_BYTES)
    expect(out.c.value).toBe('corta')
    expect(out.a.value.length).toBeGreaterThan(0)
    expect(out.b.value.length).toBeGreaterThan(0)
    expect(out.a.value.startsWith('x')).toBe(true)
    expect(out.a.label).toBe('Etiqueta')
  })

  it('las etiquetas también cuentan en el tope', () => {
    const answers = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`q${i}`, entry('v'.repeat(900), 'L'.repeat(80))]),
    )
    const out = clampAnswers(answers, 3000)
    expect(bytes(out)).toBeLessThanOrEqual(3000)
    expect(Object.values(out).every((e) => e.label === 'L'.repeat(80))).toBe(true)
  })

  it('cuenta bytes UTF-8 y no parte un emoji', () => {
    const out = clampAnswers({ a: entry('\u{1F600}'.repeat(5000)) }, 1000)
    expect(bytes(out)).toBeLessThanOrEqual(1000)
    expect([...out.a.value].every((ch) => ch === '\u{1F600}')).toBe(true)
  })

  it('termina aunque el tope sea imposible', () => {
    expect(clampAnswers({ a: entry('x'.repeat(50)) }, 3)).toEqual({})
  })
})
