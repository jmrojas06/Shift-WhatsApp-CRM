// ============================================================
// Punto de partida: Salón de belleza. Precios y horario de ejemplo:
// el dueño los ajusta en Configuración.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'estilista',
  profesionales: 'estilistas',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
}

export const SALON_PRESET: AgendaPreset = {
  key: 'salon',
  name: 'Salón de belleza',
  description: 'Peluquería, uñas, estética y spa.',
  labels,
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente del salón. ¿Qué servicio quieres agendar?',
  aiPrompt: genericAiPrompt(labels),
  seed: {
    services: [
      { name: 'Corte y peinado', description: 'Corte, lavado y peinado.', durationMinutes: 60, price: 45000, position: 0 },
      { name: 'Manicure', description: 'Limpieza, forma y esmaltado de uñas de las manos.', durationMinutes: 45, price: 30000, position: 1 },
      { name: 'Pedicure', description: 'Limpieza, forma y esmaltado de uñas de los pies.', durationMinutes: 60, price: 35000, position: 2 },
    ],
    staff: [{ name: 'Estilista 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5, 6], [['09:00', '19:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [],
}
