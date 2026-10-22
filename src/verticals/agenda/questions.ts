// ============================================================
// Preguntas extra del bot (051) — puras.
// El bot las hace después de elegir la hora y antes del resumen.
//
// Dos puertas, a propósito distintas:
//   - validateQuestionCreate: ESTRICTA, para lo que escribe el
//     admin por la API. Rechaza con mensaje en es-CO. Sus límites
//     son los CHECK de la migración 051 (etiqueta 1–80, 2–10
//     opciones si el tipo es "opcion", como máximo 10 opciones).
//   - readQuestion: PERMISIVA, para filas que lee el bot. Una fila
//     mala (alguien insertó directo por PostgREST) se descarta con
//     null y nunca tumba la conversación; jamás lanza.
// ============================================================

import type { Valid } from './config'

export const QUESTION_KINDS = ['texto', 'direccion', 'numero', 'opcion'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export const MAX_QUESTIONS = 5
export const QUESTION_LABEL_MAX = 80
/** Título de fila de lista de WhatsApp. */
export const OPTION_MAX = 24
export const MAX_OPTIONS = 10
export const MIN_OPTIONS = 2
export const ANSWER_MAX = 200

export interface QuestionInput {
  label: string
  kind: QuestionKind
  required: boolean
  options: string[]
}

export interface AgendaQuestion extends QuestionInput {
  id: string
}

/**
 * Caracteres de control, formato (zero-width, ZWJ), sustitutos sueltos y de
 * uso privado: mismo criterio que labels.ts. No se ven y rompen el texto del
 * bot o la comparación de la respuesta con la opción.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u

const isKind = (value: unknown): value is QuestionKind =>
  typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value)

/** Largo en puntos de código (un emoji vale 1), como `char_length` de Postgres. */
const codePointLength = (text: string): number => [...text].length

const truncate = (text: string, max: number): string =>
  codePointLength(text) <= max ? text : [...text].slice(0, max).join('').trim()

/** Con este número de opciones o menos el bot las manda como botones. */
const BUTTON_OPTIONS_MAX_COUNT = 3
/** Título de botón de WhatsApp (el controller del bot corta ahí). */
const BUTTON_TITLE_MAX = 20

/** El bot lee un "2" como la posición en el menú, no como el texto de una opción. */
const ONLY_DIGITS = /^\d+$/

/** Para comparar: sin mayúsculas, sin tildes y con los espacios juntos. */
const normalizeOption = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()

const hasDuplicates = (options: string[]): boolean =>
  new Set(options.map(normalizeOption)).size !== options.length

export function validateQuestionCreate(input: unknown): Valid<QuestionInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'La pregunta no es válida.' }
  }
  const record = input as Record<string, unknown>
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  if (!label) return { ok: false, message: 'Escribe la pregunta.' }
  if (codePointLength(label) > QUESTION_LABEL_MAX) {
    return { ok: false, message: `La pregunta no puede pasar de ${QUESTION_LABEL_MAX} caracteres.` }
  }
  if (CONTROL_OR_FORMAT.test(label)) {
    return { ok: false, message: 'La pregunta tiene caracteres no permitidos.' }
  }
  if (!isKind(record.kind)) return { ok: false, message: 'Ese tipo de pregunta no existe.' }
  if (record.required !== undefined && typeof record.required !== 'boolean') {
    return { ok: false, message: '"Obligatoria" debe ser sí o no.' }
  }

  let options: string[] = []
  if (record.kind === 'opcion') {
    if (!Array.isArray(record.options)) {
      return { ok: false, message: 'Agrega las opciones de respuesta.' }
    }
    if (record.options.some((o) => typeof o !== 'string')) {
      return { ok: false, message: 'Las opciones deben ser texto.' }
    }
    options = (record.options as string[]).map((o) => o.trim()).filter(Boolean)
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { ok: false, message: `Pon entre ${MIN_OPTIONS} y ${MAX_OPTIONS} opciones.` }
    }
    if (options.some((o) => CONTROL_OR_FORMAT.test(o))) {
      return { ok: false, message: 'Las opciones tienen caracteres no permitidos.' }
    }
    if (options.some((o) => ONLY_DIGITS.test(o))) {
      return { ok: false, message: 'Las opciones no pueden ser solo números.' }
    }
    if (options.length <= BUTTON_OPTIONS_MAX_COUNT) {
      if (options.some((o) => codePointLength(o) > BUTTON_TITLE_MAX)) {
        return {
          ok: false,
          message: `Con ${BUTTON_OPTIONS_MAX_COUNT} opciones o menos, cada una puede tener hasta ${BUTTON_TITLE_MAX} caracteres.`,
        }
      }
    } else if (options.some((o) => codePointLength(o) > OPTION_MAX)) {
      return { ok: false, message: `Cada opción puede tener hasta ${OPTION_MAX} caracteres.` }
    }
    if (hasDuplicates(options)) {
      return { ok: false, message: 'Las opciones no se pueden repetir.' }
    }
  }

  return {
    ok: true,
    value: { label, kind: record.kind, required: record.required !== false, options },
  }
}

/**
 * Lee una fila de `booking_questions` para el bot. Devuelve null si la fila no
 * sirve (no se debe preguntar algo roto); si solo se pasa de largo, recorta.
 * Nunca lanza.
 */
export function readQuestion(row: unknown): AgendaQuestion | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const record = row as Record<string, unknown>

  if (typeof record.id !== 'string' || !record.id) return null
  if (!isKind(record.kind)) return null
  if (typeof record.label !== 'string') return null
  const rawLabel = record.label.trim()
  if (!rawLabel || CONTROL_OR_FORMAT.test(rawLabel)) return null
  const label = truncate(rawLabel, QUESTION_LABEL_MAX)

  let options: string[] = []
  if (record.kind === 'opcion') {
    if (!Array.isArray(record.options)) return null
    if (record.options.some((o) => typeof o !== 'string')) return null
    const cleaned = (record.options as string[]).map((o) => o.trim()).filter(Boolean)
    if (cleaned.some((o) => CONTROL_OR_FORMAT.test(o))) return null
    // El bot leería un "2" como la posición en el menú, no como el texto de la opción.
    if (cleaned.some((o) => ONLY_DIGITS.test(o))) return null
    if (cleaned.length < MIN_OPTIONS || cleaned.length > MAX_OPTIONS) return null
    // Con pocas opciones el bot las manda como botones (20); con más, como lista (24).
    const max = cleaned.length <= BUTTON_OPTIONS_MAX_COUNT ? BUTTON_TITLE_MAX : OPTION_MAX
    options = cleaned.map((o) => truncate(o, max))
    // Si al recortar dos chocan, el cliente no podría distinguirlas.
    if (hasDuplicates(options)) return null
  }

  return {
    id: record.id,
    label,
    kind: record.kind,
    required: record.required !== false,
    options,
  }
}

export type AnswerCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'required' | 'number' | 'too_long' }

/** Valida una respuesta escrita (las de opción llegan por id de lista). */
export function validateAnswer(question: AgendaQuestion, raw: string): AnswerCheck {
  // Espacios y saltos de línea → un espacio; se quitan control y formato (RLO,
  // zero-width) que se ven raros o disfrazan el texto en el CRM; y se vuelve a juntar.
  const value = raw
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!value) return question.required ? { ok: false, reason: 'required' } : { ok: true, value: '' }
  if (codePointLength(value) > ANSWER_MAX) return { ok: false, reason: 'too_long' }
  if (question.kind === 'numero' && !/^\d+$/.test(value)) return { ok: false, reason: 'number' }
  return { ok: true, value }
}
