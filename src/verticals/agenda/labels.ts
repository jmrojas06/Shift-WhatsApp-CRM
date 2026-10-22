// ============================================================
// Palabras de la agenda — cómo llama cada negocio a sus cosas
// ("barbero", "doctor", "técnico"; "cita", "turno", "sesión").
// Puro. Se guardan en booking_settings.labels (051); lo que falte
// toma DEFAULT_LABELS.
// ============================================================

import type { Valid } from './config'

export interface AgendaLabels {
  profesional: string
  profesionales: string
  servicio: string
  servicios: string
  cita: string
  citas: string
}

export type AgendaLabelKey = keyof AgendaLabels

export const LABEL_KEYS: readonly AgendaLabelKey[] = [
  'profesional',
  'profesionales',
  'servicio',
  'servicios',
  'cita',
  'citas',
]

export const DEFAULT_LABELS: Readonly<AgendaLabels> = Object.freeze({
  profesional: 'profesional',
  profesionales: 'profesionales',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
})

/**
 * Tope por palabra, en puntos de código (un emoji vale 1).
 * 24 es el límite del título de una fila de lista de WhatsApp. Los
 * títulos de botón se recortan a 20 donde se arman (copy del bot).
 */
export const LABEL_MAX = 24

/**
 * Caracteres de control, formato (zero-width space, ZWJ), sustitutos sueltos
 * y de uso privado. Rechazar el ZWJ descarta a propósito los emoji compuestos
 * (por ejemplo el médico: persona + ZWJ + símbolo): se prefiere un emoji simple.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u
/** Marcas de formato de WhatsApp: se rompería el texto del bot. */
const WHATSAPP_MARKUP = /[*_~`]/

const isLabelKey = (key: string): key is AgendaLabelKey =>
  (LABEL_KEYS as readonly string[]).includes(key)

export function sanitizeLabels(input: unknown): Valid<Partial<AgendaLabels>> {
  if (input === null || input === undefined) return { ok: true, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Las palabras deben ser un objeto de clave a texto.' }
  }
  const out: Partial<AgendaLabels> = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isLabelKey(key)) continue
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${key}" debe ser texto.` }
    }
    const text = raw.trim().replace(/\s+/g, ' ')
    if (!text) continue
    // Cada punto de código ocupa 1 o 2 unidades UTF-16: más del doble del tope ya no cabe.
    if (text.length > LABEL_MAX * 2) {
      return { ok: false, message: `"${key}" no puede pasar de ${LABEL_MAX} caracteres.` }
    }
    if (CONTROL_OR_FORMAT.test(text) || WHATSAPP_MARKUP.test(text)) {
      return { ok: false, message: `"${key}" tiene caracteres no permitidos.` }
    }
    if ([...text].length > LABEL_MAX) {
      return { ok: false, message: `"${key}" no puede pasar de ${LABEL_MAX} caracteres.` }
    }
    out[key] = text
  }
  return { ok: true, value: out }
}

/**
 * Mezcla con los defaults. Ignora valores que no son texto o están en blanco.
 * Solo con datos ya saneados; para filas de la base usa `readLabels`.
 */
export function resolveLabels(partial: unknown): AgendaLabels {
  const out: AgendaLabels = { ...DEFAULT_LABELS }
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) return out
  for (const key of LABEL_KEYS) {
    const value = (partial as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return out
}

/** Lectura desde la base: nunca falla; una palabra inválida vuelve al valor por defecto. */
export function readLabels(raw: unknown): AgendaLabels {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return resolveLabels(null)
  const kept: Partial<AgendaLabels> = {}
  for (const key of LABEL_KEYS) {
    const res = sanitizeLabels({ [key]: (raw as Record<string, unknown>)[key] })
    if (res.ok && res.value[key] !== undefined) kept[key] = res.value[key]
  }
  return resolveLabels(kept)
}

export function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word
}
