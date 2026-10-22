// ============================================================
// Ayudas puras del panel de la agenda (páginas /agenda y
// /agenda/configuracion). Viven aquí, sin React, para probarlas
// con vitest: las páginas solo las llaman.
// ============================================================

import {
  DEFAULT_LABELS,
  LABEL_KEYS,
  LABEL_MAX,
  resolveLabels,
  sanitizeLabels,
  type AgendaLabelKey,
  type AgendaLabels,
} from './labels'
import { AGENDA_PRESETS, getPreset, isPresetKey, type PresetKey } from './presets'
import {
  MAX_QUESTIONS,
  readAnswerMap,
  type AgendaQuestion,
  type QuestionKind,
} from './questions'
import { AGENDA_TEXTS as T } from './texts'

// ------------------------------------------------------------
// Palabras del negocio (pestaña "Tipo de negocio")
// ------------------------------------------------------------

/** Lo que el dueño ve en cada campo: texto libre, vacío = palabra por defecto. */
export type LabelDrafts = Record<AgendaLabelKey, string>

/**
 * Borrador inicial del formulario. Una palabra igual a la de por defecto se
 * muestra vacía (el valor por defecto va de placeholder): así "vacío" y
 * "la de siempre" son lo mismo.
 */
export function labelDrafts(labels: AgendaLabels, defaults: AgendaLabels): LabelDrafts {
  const out = {} as LabelDrafts
  for (const key of LABEL_KEYS) out[key] = labels[key] === defaults[key] ? '' : labels[key]
  return out
}

const normalizeWord = (text: string): string => text.trim().replace(/\s+/g, ' ')

/**
 * Cuerpo de PATCH /config para las palabras: SIEMPRE las seis. Una palabra en
 * blanco viaja como '' y el servidor la devuelve a su valor por defecto.
 */
export function buildLabelsPayload(drafts: LabelDrafts): Record<AgendaLabelKey, string> {
  const out = {} as Record<AgendaLabelKey, string>
  for (const key of LABEL_KEYS) out[key] = normalizeWord(drafts[key] ?? '')
  return out
}

export type LabelDraftCheck =
  | { ok: true }
  | { ok: false; key: AgendaLabelKey; reason: 'too_long' | 'invalid' }

/** Misma regla que el servidor (sanitizeLabels), palabra por palabra, para avisar antes de enviar. */
export function checkLabelDrafts(drafts: LabelDrafts): LabelDraftCheck {
  for (const key of LABEL_KEYS) {
    const word = normalizeWord(drafts[key] ?? '')
    if (!word) continue
    if (sanitizeLabels({ [key]: word }).ok) continue
    return { ok: false, key, reason: [...word].length > LABEL_MAX ? 'too_long' : 'invalid' }
  }
  return { ok: true }
}

/**
 * Borrador tal como quedó guardado: las palabras normalizadas (sin espacios
 * de más) y las iguales a la de por defecto otra vez vacías.
 */
export function savedLabelDrafts(drafts: LabelDrafts): LabelDrafts {
  return labelDrafts(resolveLabels(buildLabelsPayload(drafts)), DEFAULT_LABELS)
}

/** Mensaje en es-CO para un fallo de `checkLabelDrafts`. */
export function labelDraftMessage(check: Extract<LabelDraftCheck, { ok: false }>): string {
  const word = T.config.type.words[check.key]
  return check.reason === 'too_long' ? T.config.type.wordTooLong(word) : T.config.type.wordInvalid(word)
}

// ------------------------------------------------------------
// Cambio de tipo de negocio
// ------------------------------------------------------------

export interface PresetConfirmCopy {
  /** 'same' = el tipo que ya usa la cuenta; 'switch' = cambiar a otro. */
  kind: 'same' | 'switch'
  title: string
  body: string
  confirmLabel: string
}

/**
 * Texto del diálogo al tocar una tarjeta. Cambiar de tipo aplica palabras y
 * piezas de presentación y AGREGA lo que falte (nunca borra); volver a aplicar
 * el actual solo rellena etiquetas, pipeline, respuestas rápidas y documentos.
 */
export function presetConfirmCopy(
  currentKey: string | null,
  targetKey: PresetKey,
  labels: AgendaLabels = DEFAULT_LABELS,
): PresetConfirmCopy {
  const name = AGENDA_PRESETS[targetKey].name
  if (currentKey === targetKey) {
    return {
      kind: 'same',
      title: T.config.type.sameTitle(name),
      body: T.config.type.sameBody,
      confirmLabel: T.config.type.reapply,
    }
  }
  return {
    kind: 'switch',
    title: T.config.type.confirmTitle(name),
    body: T.config.type.confirmBody(labels),
    confirmLabel: T.config.type.apply,
  }
}

// ------------------------------------------------------------
// Instalación (asistente y reinstalar)
// ------------------------------------------------------------

/**
 * ¿La cuenta ya tiene su plantilla? Hay servicios o equipo, o se acaba de
 * instalar (reporte en pantalla), o eligió "En blanco", que no crea ninguno.
 */
export function isAgendaInstalled(input: {
  servicesCount: number
  staffCount: number
  hasReport: boolean
  presetKey: string | null
}): boolean {
  return (
    input.servicesCount > 0 ||
    input.staffCount > 0 ||
    input.hasReport ||
    input.presetKey === 'blanco'
  )
}

/**
 * Prompt sugerido del reporte de instalación. Solo cuando la cuenta aún no
 * tiene configuración de IA y el punto de partida del reporte existe; con una
 * clave desconocida no hay bloque (nunca se rompe la página).
 */
export function suggestedAiPrompt(report: { aiPrompt: string; presetKey: unknown }): string | null {
  if (report.aiPrompt !== 'no_config') return null
  if (!isPresetKey(report.presetKey)) return null
  return getPreset(report.presetKey).aiPrompt
}

/** Error de PostgREST/Postgres por una columna o tabla de la migración 051 que aún no existe. */
export function isMissingMigrationError(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code
  return code === '42703' || code === '42P01' || code === 'PGRST204' || code === 'PGRST205'
}

// ------------------------------------------------------------
// Preguntas extra (pestaña "Preguntas")
// ------------------------------------------------------------

export interface QuestionDraft {
  /** null = pregunta nueva. */
  id: string | null
  label: string
  kind: QuestionKind
  required: boolean
  /** Una opción por línea. */
  optionsText: string
}

export const EMPTY_QUESTION_DRAFT: QuestionDraft = {
  id: null,
  label: '',
  kind: 'texto',
  required: true,
  optionsText: '',
}

export const draftFromQuestion = (q: AgendaQuestion): QuestionDraft => ({
  id: q.id,
  label: q.label,
  kind: q.kind,
  required: q.required,
  optionsText: q.options.join('\n'),
})

/** Opciones escritas una por línea → lista (sin líneas en blanco). */
export function parseOptionsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Cuerpo COMPLETO de POST/PATCH de una pregunta (el PATCH reemplaza toda la
 * definición). Solo las preguntas de tipo "opcion" llevan opciones.
 */
export function buildQuestionBody(draft: QuestionDraft): {
  label: string
  kind: QuestionKind
  required: boolean
  options: string[]
} {
  return {
    label: draft.label.trim(),
    kind: draft.kind,
    required: draft.required,
    options: draft.kind === 'opcion' ? parseOptionsText(draft.optionsText) : [],
  }
}

/** Cuántas preguntas más caben. Nunca negativo. */
export const questionsRemaining = (activeCount: number): number =>
  Math.max(0, MAX_QUESTIONS - activeCount)

/** Largo de la pregunta como lo mide el servidor (puntos de código). */
export const questionLabelLength = (label: string): number => [...label.trim()].length


// ------------------------------------------------------------
// Respuestas en la agenda del día
// ------------------------------------------------------------

/** ¿El jsonb de respuestas trae algo? `{}`, null o una lista no necesitan buscar las preguntas. */
export function hasAnswerEntries(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0
}

/** Una respuesta lista para mostrar: "Motivo: Control" o "¿Motivo? Control". */
export function formatAnswerLine(label: string, value: string): string {
  const text = label.trim()
  if (!text) return value
  return `${text}${text.endsWith('?') ? ' ' : ': '}${value}`
}

export interface QuestionLookup {
  id: string
  label: string
  position: number
}

/**
 * Líneas de respuestas de una cita. Acepta el formato nuevo (`{ label, value }`)
 * y el viejo (texto plano por id). Si la etiqueta guardada viene vacía se usa la
 * de la pregunta actual (incluidas las desactivadas). Se ordenan como las
 * preguntas; las de preguntas que ya no existen van al final.
 */
export function appointmentAnswerLines(raw: unknown, questions: QuestionLookup[]): string[] {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const entries = Object.entries(readAnswerMap(raw)).map(([id, entry], index) => ({
    id,
    index,
    label: entry.label || byId.get(id)?.label || '',
    value: entry.value,
    position: byId.get(id)?.position ?? Number.POSITIVE_INFINITY,
  }))
  entries.sort((a, b) =>
    a.position === b.position ? a.index - b.index : a.position < b.position ? -1 : 1,
  )
  return entries.map((e) => formatAnswerLine(e.label, e.value))
}
