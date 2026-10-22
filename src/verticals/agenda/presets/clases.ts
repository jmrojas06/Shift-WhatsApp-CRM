// ============================================================
// Punto de partida: Clases. La "cita" se llama sesión y el "servicio",
// clase. Precios y horario de ejemplo: el dueño los ajusta en
// Configuración.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'profesor',
  profesionales: 'profesores',
  servicio: 'clase',
  servicios: 'clases',
  cita: 'sesión',
  citas: 'sesiones',
}

export const CLASES_PRESET: AgendaPreset = {
  key: 'clases',
  name: 'Clases',
  description: 'Academias, tutorías, entrenamiento personal y talleres.',
  labels,
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente de las clases. ¿Qué clase quieres agendar?',
  aiPrompt: genericAiPrompt(labels),
  seed: {
    services: [
      { name: 'Clase individual', description: 'Clase personalizada con tu profesor.', durationMinutes: 60, price: 50000, position: 0 },
      { name: 'Clase de prueba', description: 'Para conocer el método antes de empezar.', durationMinutes: 30, price: 20000, position: 1 },
    ],
    staff: [{ name: 'Profesor 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5, 6], [['07:00', '20:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [],
}
