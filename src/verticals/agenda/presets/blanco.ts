// ============================================================
// Punto de partida: En blanco. No trae servicios, equipo, horario ni
// preguntas: el dueño lo arma todo. Sí trae las etiquetas y el pipeline
// base, porque el bot los busca por nombre para marcar las citas.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt } from './shared'

const labels: AgendaLabels = {
  profesional: 'profesional',
  profesionales: 'profesionales',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
}

export const BLANCO_PRESET: AgendaPreset = {
  key: 'blanco',
  name: 'En blanco',
  description: 'Empieza vacío y arma tu agenda a tu manera.',
  labels,
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente virtual. ¿Qué servicio quieres agendar?',
  aiPrompt: genericAiPrompt(labels),
  seed: {
    services: [],
    staff: [],
    weeklySchedule: [],
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [],
}
