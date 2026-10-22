// ============================================================
// Puntos de partida de la agenda. Aplicar uno SOLO LLENA: agrega lo
// que falte (servicios, equipo, horario, preguntas) y fija palabras,
// piezas y bienvenida. Después todo se edita en Configuración.
// ============================================================

import type { AgendaLabels } from '../labels'
import type { AgendaToggles } from '../toggles'
import type { QuestionInput } from '../questions'
import type { AgendaSeed } from '../seed'

import { BARBERIA_PRESET } from './barberia'
import { BLANCO_PRESET } from './blanco'
import { CLASES_PRESET } from './clases'
import { SALON_PRESET } from './salon'
import { SALUD_PRESET } from './salud'
import { TALLER_PRESET } from './taller'

export const PRESET_KEYS = ['barberia', 'salon', 'salud', 'taller', 'clases', 'blanco'] as const
export type PresetKey = (typeof PRESET_KEYS)[number]

export interface AgendaPreset {
  key: PresetKey
  /** Nombre en la tarjeta del asistente. */
  name: string
  /** Una línea: para quién es. */
  description: string
  labels: AgendaLabels
  toggles: AgendaToggles
  /** Override de la bienvenida (bot_texts.welcome). */
  welcome: string
  seed: AgendaSeed
  questions: QuestionInput[]
  /** Prompt sugerido del agente de IA (solo se escribe si el de la cuenta está vacío). */
  aiPrompt: string
}

export const AGENDA_PRESETS: Record<PresetKey, AgendaPreset> = {
  barberia: BARBERIA_PRESET,
  salon: SALON_PRESET,
  salud: SALUD_PRESET,
  taller: TALLER_PRESET,
  clases: CLASES_PRESET,
  blanco: BLANCO_PRESET,
}

export const isPresetKey = (value: unknown): value is PresetKey =>
  typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value)

export const getPreset = (key: PresetKey): AgendaPreset => AGENDA_PRESETS[key]
