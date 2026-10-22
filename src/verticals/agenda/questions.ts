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

/**
 * Recorta a `max` unidades UTF-16 (`.length`, como las cuenta Meta) sin partir
 * un par sustituto y SIN puntos suspensivos: el título que se guarda en la
 * respuesta tiene que ser el mismo que el cliente ve y que el bot compara.
 */
function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ''
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out.trim()
}

/** Con este número de opciones o menos el bot las manda como botones. */
const BUTTON_OPTIONS_MAX_COUNT = 3
/** Título de botón de WhatsApp (el controller del bot corta ahí). */
const BUTTON_TITLE_MAX = 20

/** El bot lee "2", "2." y "2)" como la posición en el menú, no como el texto de una opción. */
const ONLY_DIGITS = /^\d+[.)]?$/

/** Para comparar: sin mayúsculas, sin tildes y con los espacios juntos. */
const normalizeOption = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()

/**
 * Como `normalizeOption` pero además sin puntuación ni símbolos: lo que el bot
 * compara al leer una respuesta escrita. 'A+' y 'A-' quedan ambas en 'a'.
 */
const squashOption = (text: string): string =>
  normalizeOption(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim()

const hasDuplicates = (options: string[]): boolean => {
  if (new Set(options.map(normalizeOption)).size !== options.length) return true
  // Las que no tienen letras ni números (solo emojis) no se comparan por esta vía.
  const squashed = options.map(squashOption).filter(Boolean)
  return new Set(squashed).size !== squashed.length
}

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
    // Meta mide los títulos en UTF-16 (un emoji vale 2): es más estricto que el
    // `char_length` de la base y coincide con lo que el bot manda.
    if (options.length <= BUTTON_OPTIONS_MAX_COUNT) {
      if (options.some((o) => o.length > BUTTON_TITLE_MAX)) {
        return {
          ok: false,
          message: `Con ${BUTTON_OPTIONS_MAX_COUNT} opciones o menos, cada una puede tener hasta ${BUTTON_TITLE_MAX} caracteres.`,
        }
      }
    } else if (options.some((o) => o.length > OPTION_MAX)) {
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
    options = cleaned.map((o) => truncateUtf16(o, max))
    // Recortar puede dejar una opción vacía, en solo números (la leería como
    // posición) o chocar con otra: el cliente no podría distinguirlas.
    if (options.some((o) => !o || ONLY_DIGITS.test(o))) return null
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
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!value) return question.required ? { ok: false, reason: 'required' } : { ok: true, value: '' }
  if (codePointLength(value) > ANSWER_MAX) return { ok: false, reason: 'too_long' }
  if (question.kind === 'numero') {
    const number = parseNumber(value)
    return number === null ? { ok: false, reason: 'number' } : { ok: true, value: number }
  }
  return { ok: true, value }
}

/** "1.234" o "1,234" o "1 234" con puntos/comas/espacios como miles. */
const THOUSANDS = /^\d{1,3}(?:[.,\s]\d{3})+$/
const NUMBER_TOKEN = /\d{1,3}(?:[.,\s]\d{3})+|\d+/gu

/**
 * El número que escribió el cliente, solo dígitos: "4", "1.234.567" o un único
 * entero dentro de una frase ("somos 4"). Con dos números ("4 y 2") o ninguno, null.
 */
function parseNumber(value: string): string | null {
  if (/^\d+$/.test(value)) return value
  if (THOUSANDS.test(value)) return value.replace(/[.,\s]/g, '')
  const tokens = value.match(NUMBER_TOKEN) ?? []
  return tokens.length === 1 ? tokens[0].replace(/[.,\s]/g, '') : null
}

/**
 * Una respuesta guardada con la pregunta tal como se la hicieron al cliente:
 * si el dueño edita la etiqueta después, la respuesta vieja no cambia de sentido.
 */
export interface AnswerEntry {
  label: string
  value: string
}

/** Respuestas por id de pregunta (jsonb de la cita y estado de la sesión). */
export type AnswerMap = Record<string, AnswerEntry>

/**
 * Lee respuestas de un jsonb. Acepta el formato nuevo `{ label, value }` y el
 * viejo de texto plano (`"id": "valor"`, sin etiqueta); descarta lo demás.
 * `keepEmpty` conserva las vacías (en la sesión marcan "opcional sin responder").
 * Nunca lanza.
 */
export function readAnswerMap(raw: unknown, opts: { keepEmpty?: boolean } = {}): AnswerMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries: [string, AnswerEntry][] = []
  for (const [id, item] of Object.entries(raw as Record<string, unknown>)) {
    let label = ''
    let value: string
    if (typeof item === 'string') {
      value = item
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      if (typeof record.value !== 'string') continue
      value = record.value
      if (typeof record.label === 'string') label = truncate(record.label.trim(), QUESTION_LABEL_MAX)
    } else {
      continue
    }
    if (!value && !opts.keepEmpty) continue
    entries.push([id, { label, value }])
  }
  // fromEntries define propiedades propias: una clave "__proto__" no toca el prototipo.
  return Object.fromEntries(entries)
}

/**
 * Tope de bytes del JSON de respuestas de una cita. La base lo limita a 8192
 * (`pg_column_size`, CHECK de 051); se deja margen porque el jsonb binario no
 * pesa igual que el texto.
 */
export const ANSWERS_MAX_BYTES = 8000

const encoder = new TextEncoder()

/**
 * Deja solo las respuestas con texto y, si aun así el JSON (etiquetas incluidas)
 * pasa de `maxBytes`, acorta los valores (siempre el más largo, a la mitad) hasta
 * que quepa. Con 5 preguntas de 80 caracteres y respuestas de 200 nunca debería
 * hacer falta; es una red para que una fila rara jamás haga fallar el insert.
 */
export function clampAnswers(answers: unknown, maxBytes: number = ANSWERS_MAX_BYTES): AnswerMap {
  const map = new Map(Object.entries(readAnswerMap(answers)))
  const size = () => encoder.encode(JSON.stringify(Object.fromEntries(map))).length
  while (size() > maxBytes) {
    let longest: string | null = null
    for (const [id, entry] of map) {
      if (longest === null || entry.value.length > (map.get(longest)?.value.length ?? 0)) longest = id
    }
    if (longest === null) break
    const entry = map.get(longest)!
    const half = [...entry.value].slice(0, Math.floor([...entry.value].length / 2)).join('')
    if (half) map.set(longest, { ...entry, value: half })
    else map.delete(longest)
  }
  return Object.fromEntries(map)
}
