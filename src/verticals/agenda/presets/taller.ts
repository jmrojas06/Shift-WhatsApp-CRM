// ============================================================
// Punto de partida: Taller. El cliente no elige técnico (se asigna a
// quien esté libre) y el bot pide la placa del vehículo. Precios y
// horario de ejemplo: el dueño los ajusta en Configuración.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'técnico',
  profesionales: 'técnicos',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
}

export const TALLER_PRESET: AgendaPreset = {
  key: 'taller',
  name: 'Taller',
  description: 'Talleres de carros y motos, lavaderos y servicio técnico.',
  labels,
  toggles: { ...DEFAULT_TOGGLES, chooseStaff: false },
  welcome: '¡Hola! 👋 Soy el asistente del taller. ¿Qué servicio quieres agendar para tu vehículo?',
  aiPrompt: genericAiPrompt(labels),
  seed: {
    services: [
      { name: 'Diagnóstico', description: 'Revisión general para detectar fallas.', durationMinutes: 60, price: 60000, position: 0 },
      { name: 'Mantenimiento', description: 'Mantenimiento preventivo según el vehículo.', durationMinutes: 120, price: 180000, position: 1 },
      { name: 'Lavado', description: 'Lavado exterior e interior.', durationMinutes: 45, price: 35000, position: 2 },
    ],
    staff: [{ name: 'Técnico 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5, 6], [['08:00', '17:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [{ label: 'Placa del vehículo', kind: 'texto', required: true, options: [] }],
}
