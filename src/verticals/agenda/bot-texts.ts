// ============================================================
// Textos del bot editables — límites, saneo y merge (Fase 4).
//
// El dueño puede sobreescribir un conjunto ACOTADO de mensajes del
// controlador desde /agenda/configuracion. Los overrides viven en
// `booking_settings.bot_texts` (jsonb); este módulo es puro:
//
//   - sanitizeBotTexts: valida el jsonb tal como llega (API o DB):
//     claves desconocidas se descartan (forward-compat), valores
//     deben ser texto, se recortan, vacío = volver al default y hay
//     un tope de longitud por texto.
//   - mergeBotTexts: construye el set completo de copy del
//     controlador con los overrides aplicados.
//
// Los textos con datos de la cita (resumen, confirmación,
// recordatorio) NO son editables en esta fase: tienen placeholders y
// espejo en la plantilla de Meta, así que se quedan en código.
// ============================================================

import { AGENDA_AGENT_TEXTS, AGENDA_TEXTS, type EditableBotTextKey } from './texts'

/** Todo el copy del controlador (constantes literales). */
export type AgendaAgentTexts = typeof AGENDA_AGENT_TEXTS

/** Orden canónico para la UI y para los mensajes de error. */
export const EDITABLE_BOT_TEXT_KEYS: readonly EditableBotTextKey[] = [
  'welcome',
  'retry',
  'noServices',
  'noDaysAvailable',
  'handoff',
]

/**
 * Campo de `AGENDA_AGENT_TEXTS` que cada clave editable reemplaza.
 * `welcome` es la bienvenida = el cuerpo del menú de servicios.
 */
const BASE_FIELD: Record<
  EditableBotTextKey,
  'serviceMenuBody' | 'retry' | 'noServices' | 'noDaysAvailable' | 'handoff'
> = {
  welcome: 'serviceMenuBody',
  retry: 'retry',
  noServices: 'noServices',
  noDaysAvailable: 'noDaysAvailable',
  handoff: 'handoff',
}

/** Tope de longitud de un texto editado (WhatsApp corta por su cuenta). */
export const BOT_TEXT_MAX_LENGTH = 320

export type BotTextOverrides = Partial<Record<EditableBotTextKey, string>>

export function isEditableBotTextKey(value: unknown): value is EditableBotTextKey {
  return (
    typeof value === 'string' &&
    (EDITABLE_BOT_TEXT_KEYS as readonly string[]).includes(value)
  )
}

/** Texto por defecto de una clave (para la UI y los tests). */
export function botTextDefault(key: EditableBotTextKey): string {
  return AGENDA_AGENT_TEXTS[BASE_FIELD[key]]
}

export type SanitizeBotTextsResult =
  | { ok: true; value: BotTextOverrides }
  | { ok: false; message: string }

/**
 * Normaliza un jsonb de overrides. Tolera `null`/`undefined` (fila o
 * columna ausente) y devuelve `{}`; el resto de errores se reportan
 * con mensaje en es-CO listo para la UI.
 */
export function sanitizeBotTexts(input: unknown): SanitizeBotTextsResult {
  if (input === null || input === undefined) return { ok: true, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      message: 'Los textos del bot deben ser un objeto de clave a texto.',
    }
  }

  const out: BotTextOverrides = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    // Clave desconocida (p. ej. escrita por una versión más nueva):
    // se descarta sin romper el flujo.
    if (!isEditableBotTextKey(key)) continue
    if (raw === null || raw === undefined) continue

    const label = AGENDA_TEXTS.config.bot.labels[key]
    if (typeof raw !== 'string') {
      return { ok: false, message: `"${label}" debe ser texto.` }
    }
    const text = raw.trim()
    if (!text) continue // vacío = usar el texto por defecto
    if (text.length > BOT_TEXT_MAX_LENGTH) {
      return {
        ok: false,
        message: `"${label}" no puede pasar de ${BOT_TEXT_MAX_LENGTH} caracteres.`,
      }
    }
    out[key] = text
  }
  return { ok: true, value: out }
}

/**
 * Set completo de copy del controlador con los overrides aplicados.
 * Las cinco claves editables se ensanchan a `string`; el resto
 * conserva su tipo literal.
 */
export type AgendaAgentTextsMerged = Omit<
  AgendaAgentTexts,
  'serviceMenuBody' | 'retry' | 'noServices' | 'noDaysAvailable' | 'handoff'
> & {
  serviceMenuBody: string
  retry: string
  noServices: string
  noDaysAvailable: string
  handoff: string
}

export function mergeBotTexts(
  overrides: BotTextOverrides,
): AgendaAgentTextsMerged {
  return {
    ...AGENDA_AGENT_TEXTS,
    serviceMenuBody: overrides.welcome ?? AGENDA_AGENT_TEXTS.serviceMenuBody,
    retry: overrides.retry ?? AGENDA_AGENT_TEXTS.retry,
    noServices: overrides.noServices ?? AGENDA_AGENT_TEXTS.noServices,
    noDaysAvailable:
      overrides.noDaysAvailable ?? AGENDA_AGENT_TEXTS.noDaysAvailable,
    handoff: overrides.handoff ?? AGENDA_AGENT_TEXTS.handoff,
  }
}
