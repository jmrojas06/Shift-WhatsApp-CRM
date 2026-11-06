// ============================================================
// Punto de partida: Clínica odontológica. Duraciones y horario de
// ejemplo: Shift los ajusta con la clínica en el montaje. Sin precios:
// el valor de un tratamiento depende de la valoración.
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'doctor(a)',
  profesionales: 'doctores',
  servicio: 'atención',
  servicios: 'atenciones',
  cita: 'cita',
  citas: 'citas',
}

export const ODONTOLOGIA_PRESET: AgendaPreset = {
  key: 'odontologia',
  name: 'Clínica odontológica',
  description: 'Consultorios y clínicas dentales.',
  labels,
  toggles: { ...DEFAULT_TOGGLES, showPrice: false, showDuration: false },
  welcome: '¡Hola! 👋 Soy el asistente de la clínica. ¿Qué atención necesitas?',
  aiPrompt: [
    genericAiPrompt(labels),
    '',
    'Reglas de salud (no se pueden romper):',
    '- Nunca des diagnósticos ni digas qué tratamiento necesita alguien.',
    '- Nunca recomiendes medicamentos ni dosis.',
    '- Si alguien describe dolor fuerte, sangrado, hinchazón o un golpe, dile que escriba "urgencia".',
    '- Para agendar, dile que escriba "cita".',
  ].join('\n'),
  seed: {
    services: [
      { name: 'Valoración', description: 'Primera revisión.', durationMinutes: 30, price: 0, position: 0 },
      { name: 'Limpieza', description: 'Profilaxis.', durationMinutes: 45, price: 0, position: 1 },
      { name: 'Control', description: 'Seguimiento de tratamiento.', durationMinutes: 20, price: 0, position: 2 },
      { name: 'Control de ortodoncia', description: 'Control mensual.', durationMinutes: 20, price: 0, position: 3 },
      { name: 'Urgencia', description: 'Atención prioritaria.', durationMinutes: 30, price: 0, position: 4 },
    ],
    staff: [{ name: 'Doctor(a) 1', bio: 'Edita su nombre y perfil en Configuración.', position: 0 }],
    weeklySchedule: weekdays([1, 2, 3, 4, 5], [['08:00', '12:00'], ['14:00', '18:00']]),
    tags: BASE_TAGS,
    customFields: [],
    pipeline: BASE_PIPELINE,
    quickReplies: [],
    knowledgeDocs: [],
  },
  questions: [],
}
