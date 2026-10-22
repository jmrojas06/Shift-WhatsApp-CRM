// ============================================================
// Piezas que comparten todos los puntos de partida.
// ============================================================

import type { AgendaLabels } from '../labels'
import type { AgendaSeedHour, AgendaSeedTag } from '../seed'

/**
 * Las mismas etiquetas del seed de barbería: el controlador las busca
 * por nombre (no cambiar los nombres).
 */
export const BASE_TAGS: AgendaSeedTag[] = [
  { name: 'cita-pendiente', color: '#f59e0b' },
  { name: 'cita-confirmada', color: '#10b981' },
  { name: 'cita-reprogramada', color: '#6366f1' },
  { name: 'cita-cancelada', color: '#ef4444' },
  { name: 'quiere-humano', color: '#8b5cf6' },
  { name: 'atendido', color: '#3b82f6' },
]

/** Mismas etapas que barbería: el bot mueve el negocio a "Cita agendada". */
export const BASE_PIPELINE = {
  name: 'Agenda',
  stages: [
    { name: 'Nuevo', color: '#3b82f6' },
    { name: 'Cita agendada', color: '#f59e0b' },
    { name: 'Atendida', color: '#10b981' },
    { name: 'No asistió', color: '#ef4444' },
    { name: 'Perdido', color: '#6b7280' },
  ],
}

/** Horario semanal: mismos bloques para cada día ('HH:MM' → 'HH:MM:00'). */
export function weekdays(days: number[], blocks: [string, string][]): AgendaSeedHour[] {
  return days.flatMap((weekday) =>
    blocks.map(([start, end]) => ({ weekday, startTime: `${start}:00`, endTime: `${end}:00` })),
  )
}

/**
 * Prompt del agente de IA para los puntos de partida que no son la
 * barbería. Solo trae reglas de comportamiento y las palabras del negocio:
 * ningún dato (precios, horario, pagos) que no hayamos recibido del dueño.
 */
export function genericAiPrompt(labels: AgendaLabels): string {
  return [
    `Eres el asistente de WhatsApp de un negocio en Colombia que atiende con ${labels.citas}. Respondes dudas de los clientes y les ayudas a conseguir su ${labels.cita}.`,
    '',
    'Cómo responder:',
    '- Escribe en español colombiano, cercano y respetuoso. Mensajes cortos, como se escribe en WhatsApp.',
    '- Usa solo la información de este mensaje y de los documentos del negocio. Si algo no está definido (precios, horarios, promociones, disponibilidad exacta), no lo inventes: di que un asesor lo confirmará.',
    `- Nunca prometas una ${labels.cita}, un horario o un precio que no puedas verificar.`,
    '- Si el cliente pide hablar con una persona, o el tema se sale de lo que sabes, pasa la conversación a un asesor.',
    '',
    `Completa aquí los datos de tu negocio (${labels.servicios}, horario, formas de pago, ubicación) y actualiza este texto cuando cambien.`,
  ].join('\n')
}
