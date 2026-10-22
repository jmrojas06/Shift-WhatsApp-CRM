import { describe, expect, it } from 'vitest'

import { DEFAULT_LABELS, LABEL_KEYS, LABEL_MAX, resolveLabels, sanitizeLabels } from './labels'
import {
  appointmentAnswerLines,
  buildLabelsPayload,
  buildQuestionBody,
  checkLabelDrafts,
  draftFromQuestion,
  EMPTY_QUESTION_DRAFT,
  formatAnswerLine,
  labelDraftMessage,
  labelDrafts,
  parseOptionsText,
  presetConfirmCopy,
  questionsRemaining,
} from './panel'
import { AGENDA_PRESETS } from './presets'
import { MAX_QUESTIONS, validateQuestionCreate } from './questions'

describe('palabras del negocio', () => {
  it('el borrador muestra vacías las palabras que son las de por defecto', () => {
    const labels = resolveLabels({ profesional: 'barbero', profesionales: 'barberos' })
    expect(labelDrafts(labels, DEFAULT_LABELS)).toEqual({
      profesional: 'barbero',
      profesionales: 'barberos',
      servicio: '',
      servicios: '',
      cita: '',
      citas: '',
    })
  })

  it('el cuerpo siempre lleva las seis palabras; las vacías viajan como cadena vacía', () => {
    const payload = buildLabelsPayload({
      profesional: '  doctor ',
      profesionales: '',
      servicio: 'consulta   general',
      servicios: '   ',
      cita: 'turno',
      citas: 'turnos',
    })
    expect(Object.keys(payload).sort()).toEqual([...LABEL_KEYS].sort())
    expect(payload).toEqual({
      profesional: 'doctor',
      profesionales: '',
      servicio: 'consulta general',
      servicios: '',
      cita: 'turno',
      citas: 'turnos',
    })
  })

  it('lo que el cuerpo manda lo acepta el saneador del servidor', () => {
    const payload = buildLabelsPayload({
      ...labelDrafts(DEFAULT_LABELS, DEFAULT_LABELS),
      profesional: 'técnico',
    })
    expect(sanitizeLabels(payload)).toEqual({ ok: true, value: { profesional: 'técnico' } })
  })

  it('avisa cuando una palabra pasa del tope o trae marcas de WhatsApp', () => {
    const empty = labelDrafts(DEFAULT_LABELS, DEFAULT_LABELS)
    expect(checkLabelDrafts(empty)).toEqual({ ok: true })

    const tooLong = checkLabelDrafts({ ...empty, cita: 'x'.repeat(LABEL_MAX + 1) })
    expect(tooLong).toEqual({ ok: false, key: 'cita', reason: 'too_long' })
    if (!tooLong.ok) expect(labelDraftMessage(tooLong)).toContain(`${LABEL_MAX} caracteres`)

    const markup = checkLabelDrafts({ ...empty, servicio: 'corte *vip*' })
    expect(markup).toEqual({ ok: false, key: 'servicio', reason: 'invalid' })
    if (!markup.ok) expect(labelDraftMessage(markup)).toContain('no permitidos')
  })

  it('un emoji vale un carácter, igual que en el servidor', () => {
    const empty = labelDrafts(DEFAULT_LABELS, DEFAULT_LABELS)
    expect(checkLabelDrafts({ ...empty, cita: '💈'.repeat(LABEL_MAX) })).toEqual({ ok: true })
  })
})

describe('presetConfirmCopy', () => {
  it('cambiar de tipo explica qué se aplica, qué se agrega y qué se queda', () => {
    const copy = presetConfirmCopy('barberia', 'salud')
    expect(copy.kind).toBe('switch')
    expect(copy.title).toContain(AGENDA_PRESETS.salud.name)
    expect(copy.body).toContain('Se aplican las palabras')
    expect(copy.body).toContain('se quedan activos')
    expect(copy.body).toContain('La bienvenida solo cambia si no la personalizaste.')
  })

  it('el tipo actual avisa que no toca servicios ni equipo', () => {
    const copy = presetConfirmCopy('salud', 'salud')
    expect(copy.kind).toBe('same')
    expect(copy.body).toContain('Ya usas este tipo de negocio.')
    expect(copy.body).toContain('no cambia tus servicios ni tu equipo')
  })

  it('una cuenta sin tipo elegido trata cualquiera como un cambio', () => {
    expect(presetConfirmCopy(null, 'blanco').kind).toBe('switch')
  })
})

describe('preguntas extra', () => {
  it('arma el cuerpo completo; solo las de opción llevan opciones', () => {
    expect(
      buildQuestionBody({ ...EMPTY_QUESTION_DRAFT, label: '  Placa  ', optionsText: 'a\nb' }),
    ).toEqual({ label: 'Placa', kind: 'texto', required: true, options: [] })

    expect(
      buildQuestionBody({
        ...EMPTY_QUESTION_DRAFT,
        label: 'Sede',
        kind: 'opcion',
        required: false,
        optionsText: ' Norte \r\n\r\nSur\n',
      }),
    ).toEqual({ label: 'Sede', kind: 'opcion', required: false, options: ['Norte', 'Sur'] })
  })

  it('el cuerpo pasa el validador del servidor', () => {
    const body = buildQuestionBody({
      ...EMPTY_QUESTION_DRAFT,
      label: 'Sede',
      kind: 'opcion',
      optionsText: 'Norte\nSur',
    })
    expect(validateQuestionCreate(body)).toEqual({ ok: true, value: body })
  })

  it('editar carga todos los campos de la pregunta', () => {
    const draft = draftFromQuestion({
      id: 'q1',
      label: 'Sede',
      kind: 'opcion',
      required: false,
      options: ['Norte', 'Sur'],
    })
    expect(draft).toEqual({ id: 'q1', label: 'Sede', kind: 'opcion', required: false, optionsText: 'Norte\nSur' })
    expect(parseOptionsText(draft.optionsText)).toEqual(['Norte', 'Sur'])
  })

  it('cuenta cuántas caben sin pasar de cero', () => {
    expect(questionsRemaining(0)).toBe(MAX_QUESTIONS)
    expect(questionsRemaining(MAX_QUESTIONS)).toBe(0)
    expect(questionsRemaining(MAX_QUESTIONS + 2)).toBe(0)
  })
})

describe('respuestas en la agenda', () => {
  it('formatAnswerLine: dos puntos salvo que la pregunta termine en "?"', () => {
    expect(formatAnswerLine('Motivo', 'Control')).toBe('Motivo: Control')
    expect(formatAnswerLine('¿Motivo?', 'Control')).toBe('¿Motivo? Control')
    expect(formatAnswerLine('', 'Control')).toBe('Control')
    expect(formatAnswerLine('  ', 'Control')).toBe('Control')
  })

  const questions = [
    { id: 'a', label: 'Placa', position: 0 },
    { id: 'b', label: '¿Zona?', position: 1 },
  ]

  it('usa la etiqueta guardada con la respuesta', () => {
    expect(
      appointmentAnswerLines({ a: { label: 'Placa del carro', value: 'ABC123' } }, questions),
    ).toEqual(['Placa del carro: ABC123'])
  })

  it('con etiqueta vacía o formato viejo toma la de la pregunta (aunque esté desactivada)', () => {
    expect(
      appointmentAnswerLines({ a: { label: '', value: 'ABC123' }, b: 'Norte' }, questions),
    ).toEqual(['Placa: ABC123', '¿Zona? Norte'])
  })

  it('ordena como las preguntas y deja al final las de preguntas que ya no existen', () => {
    expect(
      appointmentAnswerLines(
        { zzz: { label: 'Vieja', value: 'x' }, b: 'Norte', a: 'ABC123' },
        questions,
      ),
    ).toEqual(['Placa: ABC123', '¿Zona? Norte', 'Vieja: x'])
  })

  it('una respuesta sin etiqueta conocida se muestra solo con su valor', () => {
    expect(appointmentAnswerLines({ zzz: 'hola' }, questions)).toEqual(['hola'])
  })

  it('basura o respuestas vacías no rompen ni se muestran', () => {
    expect(appointmentAnswerLines(null, questions)).toEqual([])
    expect(appointmentAnswerLines([], questions)).toEqual([])
    expect(appointmentAnswerLines({ a: '', b: 5 }, questions)).toEqual([])
  })
})
