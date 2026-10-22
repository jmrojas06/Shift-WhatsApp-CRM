// ============================================================
// Punto de partida: Barbería. Es el seed que la plantilla traía antes
// de los puntos de partida (mismos servicios, horario, respuestas
// rápidas y documentos), ahora con el pipeline "Agenda".
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import type { AgendaLabels } from '../labels'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, genericAiPrompt, weekdays } from './shared'

const labels: AgendaLabels = {
  profesional: 'barbero',
  profesionales: 'barberos',
  servicio: 'servicio',
  servicios: 'servicios',
  cita: 'cita',
  citas: 'citas',
}

export const BARBERIA_PRESET: AgendaPreset = {
  key: 'barberia',
  name: 'Barbería',
  description: 'Barberías y peluquerías de hombre: cortes, barba y perfilado.',
  labels,
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente de la barbería. ¿Qué servicio quieres agendar?',
  aiPrompt: genericAiPrompt(labels),
  questions: [],
  seed: {
    services: [
      {
        name: 'Corte clásico',
        description: 'Máquina, tijera y lavado. El favorito para el día a día.',
        durationMinutes: 30,
        price: 25000,
        position: 0,
      },
      {
        name: 'Corte + barba',
        description: 'Corte completo y arreglo de barba con navaja y toalla caliente.',
        durationMinutes: 45,
        price: 40000,
        position: 1,
      },
      {
        name: 'Perfilado de barba',
        description: 'Diseño y perfilado de barba con máquina y navaja.',
        durationMinutes: 20,
        price: 15000,
        position: 2,
      },
    ],

    staff: [
      {
        name: 'Andrés',
        bio: 'Barbero principal. Atiende de lunes a sábado.',
        position: 0,
      },
    ],

    // Lunes a sábado, jornada partida (mediodía libre). Editable por el dueño.
    weeklySchedule: weekdays([1, 2, 3, 4, 5, 6], [['09:00', '13:00'], ['14:00', '19:00']]),

    tags: BASE_TAGS,

    // El CRM solo ofrece campos personalizados de texto por ahora.
    customFields: ['barbero_preferido', 'ultima_visita'],

    pipeline: BASE_PIPELINE,

    quickReplies: [
      {
        title: 'Saludo',
        content: '¡Hola! 👋 Gracias por escribirnos. ¿Quieres agendar una cita o tienes alguna pregunta?',
      },
      {
        title: 'Horario de atención',
        content:
          'Atendemos de lunes a sábado, de 9:00 a.m. a 1:00 p.m. y de 2:00 p.m. a 7:00 p.m. ¿Te agendo tu cita?',
      },
      {
        title: 'Ubicación',
        content: '📍 Estamos en [escribe tu dirección]. Te esperamos de lunes a sábado.',
      },
    ],

    knowledgeDocs: [
      {
        title: 'Horarios de atención',
        content:
          'Atendemos de lunes a sábado, de 9:00 a.m. a 1:00 p.m. y de 2:00 p.m. a 7:00 p.m.\n\n' +
          '[Escribe aquí si abres domingos o festivos y cómo atiendes fuera de horario.]',
      },
      {
        title: 'Servicios y precios',
        content:
          'Servicios disponibles: corte clásico (30 minutos) por $25.000; corte + barba (45 minutos) por $40.000; perfilado de barba (20 minutos) por $15.000.\n\n' +
          '[Escribe aquí si el precio puede variar, si atiendes niños y otras condiciones de tus servicios.]',
      },
      {
        title: 'Política de citas y cancelaciones',
        content:
          '[Escribe aquí tu política: con cuánta anticipación se puede cancelar o reprogramar una cita y qué pasa si el cliente llega tarde.]',
      },
      {
        title: 'Métodos de pago',
        content:
          '[Escribe aquí los métodos de pago que recibes (efectivo, transferencias, tarjetas...) y si entregas factura.]',
      },
      {
        title: 'Ubicación y contacto',
        content:
          'Estamos ubicados en [escribe aquí tu dirección exacta y puntos de referencia para llegar].\n\n' +
          'Puedes escribirnos por este mismo WhatsApp para pedir indicaciones o resolver cualquier duda antes de tu visita.',
      },
    ],
  },
}
