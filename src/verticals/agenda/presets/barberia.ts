// ============================================================
// Punto de partida: Barbería. Es el seed que la plantilla traía antes
// de los puntos de partida (mismos servicios, horario, respuestas
// rápidas y documentos), ahora con el pipeline "Agenda".
// ============================================================

import { DEFAULT_TOGGLES } from '../toggles'
import { AGENDA_AI_PROMPT } from '../seed'
import type { AgendaPreset } from './index'
import { BASE_PIPELINE, BASE_TAGS, weekdays } from './shared'

export const BARBERIA_PRESET: AgendaPreset = {
  key: 'barberia',
  name: 'Barbería',
  description: 'Barberías y peluquerías de hombre: cortes, barba y perfilado.',
  labels: {
    profesional: 'barbero',
    profesionales: 'barberos',
    servicio: 'servicio',
    servicios: 'servicios',
    cita: 'cita',
    citas: 'citas',
  },
  toggles: { ...DEFAULT_TOGGLES },
  welcome: '¡Hola! 👋 Soy el asistente de la barbería. ¿Qué servicio quieres agendar?',
  aiPrompt: AGENDA_AI_PROMPT,
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
        title: 'Lista de precios',
        content:
          'Corte clásico: $25.000\nCorte + barba: $40.000\nPerfilado de barba: $15.000\n¿Cuál te gustaría agendar?',
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
          'Atendemos de lunes a sábado, de 9:00 a.m. a 1:00 p.m. y de 2:00 p.m. a 7:00 p.m. Los domingos y festivos permanecemos cerrados.\n\n' +
          'Puedes agendar tu cita por WhatsApp en cualquier momento. El equipo responde dentro del horario de atención.\n\n' +
          'Si necesitas una cita fuera del horario habitual, escríbenos y revisamos la disponibilidad.',
      },
      {
        title: 'Servicios y precios',
        content:
          'Servicios disponibles: corte clásico (30 minutos) por $25.000; corte + barba (45 minutos) por $40.000; perfilado de barba (20 minutos) por $15.000.\n\n' +
          'El precio final puede variar según el largo y el estado del cabello. El barbero confirma el valor antes de empezar.\n\n' +
          'También atendemos a niños, siempre que vengan acompañados por un adulto.',
      },
      {
        title: 'Política de citas y cancelaciones',
        content:
          'Puedes cancelar o reprogramar tu cita por este mismo WhatsApp. Te pedimos hacerlo con al menos 2 horas de anticipación para dejar el cupo disponible.\n\n' +
          'Si llegas más de 10 minutos tarde, puede que debamos atender a otro cliente o reprogramar tu cita.\n\n' +
          'Si no puedes asistir, avísanos: así liberamos el espacio para alguien más.',
      },
      {
        title: 'Métodos de pago',
        content:
          'Recibimos efectivo, Nequi, Daviplata y tarjetas débito y crédito.\n\n' +
          'Al pagar con tarjeta o por transferencia te entregamos el comprobante al finalizar el servicio.\n\n' +
          'Si necesitas factura electrónica, pídesela al barbero antes de pagar.',
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
