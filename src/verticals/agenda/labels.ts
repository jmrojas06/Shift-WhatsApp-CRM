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

export const DEFAULT_LABELS: AgendaLabels = {
  profesional: 'profesional',
  profesionales: 'profesionales',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
}

/** Tope por palabra: entra en un botón de WhatsApp junto a "Ver ". */
export const LABEL_MAX = 24

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
    const text = raw.trim()
    if (!text) continue
    if (text.length > LABEL_MAX) {
      return { ok: false, message: `"${key}" no puede pasar de ${LABEL_MAX} caracteres.` }
    }
    out[key] = text
  }
  return { ok: true, value: out }
}

export function resolveLabels(
  partial: Partial<AgendaLabels> | null | undefined,
): AgendaLabels {
  return { ...DEFAULT_LABELS, ...(partial ?? {}) }
}

export function capitalize(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word
}
