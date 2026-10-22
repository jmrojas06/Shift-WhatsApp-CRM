// ============================================================
// Punto de partida: Consultorio / salud. Precios y horario de ejemplo:
// el dueño los ajusta en Configuración.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'especialista',
  profesionales: 'especialistas',
  servicio: 'consulta',
  servicios: 'consultas',
  cita: 'cita',
  citas: 'citas',
}

export const SALUD_PRESET: AgendaPreset = {
  key: 'salud',
  name: 'Consultorio / salud',
  description: 'Odontología, fisioterapia, psicología, estética, medicina general.',
  labels,
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente del consultorio. ¿Qué consulta quieres agendar?',
  aiPrompt: genericAiPrompt(labels),
  seed: {
    services: [
      { name: 'Consulta general', description: 'Valoración inicial.', durationMinutes: 30, price: 80000, position: 0 },
      { name: 'Control', description: 'Seguimiento de tratamiento.', durationMinutes: 20, price: 50000, position: 1 },
      { name: 'Procedimiento', description: 'Según valoración previa.', durationMinutes: 60, price: 150000, position: 2 },
    ],
    staff: [{ name: 'Especialista 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5], [['08:00', '12:00'], ['14:00', '18:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [{ label: '¿Cuál es el motivo de la consulta?', kind: 'texto', required: false, options: [] }],
}
