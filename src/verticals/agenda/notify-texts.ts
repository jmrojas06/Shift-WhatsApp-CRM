// ============================================================
// Textos de los avisos al paciente (T5) — español colombiano.
//
// Una sola fuente para tres cosas, para que no se separen:
//   - el mensaje libre (ventana de 24 h abierta),
//   - el cuerpo de cada plantilla de Meta (ventana cerrada), con sus
//     variables en el orden aprobado, y
//   - el texto que queda en `messages` cuando sale la plantilla.
// `docs/clinica-montaje.md` cita estas plantillas: su cuerpo se obtiene con
// `renderNotifyTemplate(nombre, ['{{1}}', '{{2}}', …])`.
//
// Junto a las palabras del negocio (cita, turno, sesión…) no hay artículos ni
// adjetivos, porque el género cambia. Las plantillas de una clínica nunca
// nombran el procedimiento: el teléfono puede ser compartido y el texto pasa
// por Meta.
// ============================================================

import { BOOK_AGAIN_ID } from './agent/state'
import type { AgendaLabels } from './labels'

export interface NotifyButton {
  id: string
  title: string
}

/** Botón del aviso de cancelación: abre el flujo de reservas del bot. */
export const BOOK_AGAIN_BUTTON: NotifyButton = { id: BOOK_AGAIN_ID, title: 'Agendar otra' }

/** Botón del enlace que se manda tras una llamada. Mismo id: abre el mismo flujo. */
export const BOOKING_LINK_BUTTON: NotifyButton = { id: BOOK_AGAIN_ID, title: 'Agendar' }

export type NotifyTemplateName =
  | 'cita_agendada'
  | 'cita_cancelada'
  | 'cita_agendada_clinica'
  | 'cita_cancelada_clinica'
  | 'agendar_por_llamada'

export interface NotifyTemplate {
  name: NotifyTemplateName
  language: 'es'
  /**
   * Variables del cuerpo, en el orden aprobado en Meta ({{1}}, {{2}}…). Los
   * nombres son los de `NotifyVars`.
   */
  variables: readonly string[]
  /** La plantilla lleva un botón de respuesta rápida con el payload `book:again`. */
  button?: NotifyButton
}

export const NOTIFY_TEMPLATES: Readonly<Record<NotifyTemplateName, NotifyTemplate>> = {
  cita_agendada: {
    name: 'cita_agendada',
    language: 'es',
    variables: ['business', 'service', 'staff', 'date', 'time'],
  },
  cita_cancelada: {
    name: 'cita_cancelada',
    language: 'es',
    variables: ['business', 'date', 'time'],
    button: BOOK_AGAIN_BUTTON,
  },
  cita_agendada_clinica: {
    name: 'cita_agendada_clinica',
    language: 'es',
    variables: ['patient', 'business', 'location', 'doctor', 'date', 'time'],
  },
  cita_cancelada_clinica: {
    name: 'cita_cancelada_clinica',
    language: 'es',
    variables: ['patient', 'business', 'date', 'time'],
    button: BOOK_AGAIN_BUTTON,
  },
  agendar_por_llamada: {
    name: 'agendar_por_llamada',
    language: 'es',
    variables: ['business'],
    button: BOOKING_LINK_BUTTON,
  },
}

/** Valores de las variables, por nombre. */
export type NotifyVars = Readonly<Record<string, string>>

type BodyBuilder = (l: AgendaLabels, v: NotifyVars) => string

const BODIES: Record<NotifyTemplateName, BodyBuilder> = {
  cita_agendada: (l, v) =>
    `¡Hola! 👋 Te confirmamos tu ${l.cita} en ${v.business}:\n\n📌 ${v.service}\n👤 ${v.staff}\n📅 ${v.date}\n🕐 ${v.time}\n\n¡Te esperamos! 🙌`,
  cita_cancelada: (l, v) =>
    `Hola 👋 Cancelamos tu ${l.cita} en ${v.business} del ${v.date} a las ${v.time}.\n\nSi quieres volver a agendar, toca el botón.`,
  cita_agendada_clinica: (l, v) =>
    `¡Hola! 👋 Te confirmamos que ${v.patient} tiene ${l.cita} en ${v.business}, sede ${v.location}:\n\n👤 ${v.doctor}\n📅 ${v.date}\n🕐 ${v.time}\n\n¡Te esperamos! 🙌`,
  cita_cancelada_clinica: (_l, v) =>
    `Hola 👋 Cancelamos lo agendado para ${v.patient} en ${v.business} el ${v.date} a las ${v.time}.\n\nSi quieres volver a agendar, toca el botón.`,
  agendar_por_llamada: (l, v) =>
    `¡Hola! 👋 Gracias por llamar a ${v.business}. Para agendar tu ${l.cita} en un minuto, toca el botón.`,
}

/** Une cada valor con el nombre de la variable que ocupa esa posición. */
function varsOf(name: NotifyTemplateName, values: readonly string[]): NotifyVars {
  const vars: Record<string, string> = {}
  NOTIFY_TEMPLATES[name].variables.forEach((key, index) => {
    vars[key] = values[index] ?? ''
  })
  return vars
}

/**
 * El cuerpo de una plantilla con sus valores, en el orden de
 * `NOTIFY_TEMPLATES[nombre].variables`. Es el texto que se guarda en la
 * conversación al enviarla y, con `{{1}}`, `{{2}}`…, el que se aprueba en Meta.
 */
export function renderNotifyTemplate(
  name: NotifyTemplateName,
  values: readonly string[],
  labels: AgendaLabels,
): string {
  return BODIES[name](labels, varsOf(name, values))
}

/**
 * Mover una cita: la plantilla es la misma que al agendar (con la nueva hora),
 * pero con la ventana abierta se puede decir que la hora cambió. `values` son
 * los de `cita_agendada` o `cita_agendada_clinica`, según `clinic`.
 */
export function renderMovedText(
  clinic: boolean,
  values: readonly string[],
  labels: AgendaLabels,
): string {
  const v = varsOf(clinic ? 'cita_agendada_clinica' : 'cita_agendada', values)
  return clinic
    ? `¡Hola! 👋 Cambiamos la hora. Ahora ${v.patient} tiene ${labels.cita} en ${v.business}, sede ${v.location}:\n\n👤 ${v.doctor}\n📅 ${v.date}\n🕐 ${v.time}\n\n¡Te esperamos! 🙌`
    : `¡Hola! 👋 Cambiamos la hora de tu ${labels.cita} en ${v.business}. Queda así:\n\n📌 ${v.service}\n👤 ${v.staff}\n📅 ${v.date}\n🕐 ${v.time}\n\n¡Te esperamos! 🙌`
}

/** Lo que se muestra en el panel cuando el aviso no salió. */
export const NOTIFY_TEXTS = {
  failed: 'No se pudo enviar el aviso por WhatsApp.',
  failedWithCode: (code: string) => `No se pudo enviar el aviso por WhatsApp (código ${code}).`,
  appointmentMissing: 'No se encontró la cita.',
  accountMissing: 'No se encontró la cuenta.',
  contactMissing: 'No se encontró el contacto del paciente.',
  noWhatsApp: 'El contacto no tiene un número de WhatsApp.',
  noConversation: 'El paciente no tiene una conversación de WhatsApp.',
  unreadable: 'No se pudieron leer los datos de la cita.',
  connection: 'No se pudo leer la conexión de WhatsApp de esta cuenta.',
  templateMissing: (name: string) =>
    `La plantilla "${name}" no existe o no está aprobada en WhatsApp Manager.`,
  templateMismatch: (name: string) =>
    `Los datos enviados no coinciden con la plantilla "${name}" aprobada en WhatsApp Manager.`,
  notAllowed: 'El número no está en la lista de números de prueba de WhatsApp.',
  undeliverable: 'WhatsApp no pudo entregar el mensaje: el número no parece tener WhatsApp.',
  windowClosed:
    'Pasaron más de 24 horas desde el último mensaje del paciente y WhatsApp pide una plantilla.',
} as const
