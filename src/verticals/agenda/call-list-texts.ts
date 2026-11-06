// ============================================================
// Textos de las secciones "Para llamar" y "Sin marcar" de /agenda: español de
// Colombia, en palabras simples. La pantalla los muestra tal cual.
//
// Donde nombran lo que se agenda usan las palabras del negocio
// (AgendaLabels) sin artículo delante, porque el género cambia ("la cita",
// "el turno"). Sin rayas largas.
//
// También viven aquí las funciones puras que escriben el último resultado de
// una llamada y el teléfono, para poder probarlas sin pantalla.
// ============================================================

import { formatDayLabel } from './agent/format'
import { addDaysToKey, zonedDateKey } from './agent/time'
import type { CallListLastCall, CallListReason } from './call-list'
import type { AgendaLabels } from './labels'

export const CALL_LIST_TEXTS = {
  // Para llamar
  title: 'Para llamar',
  description: (count: number, l: AgendaLabels) =>
    `${count === 1 ? `1 ${l.cita}` : `${count} ${l.citas}`} de las próximas 48 horas sin confirmar.`,
  descriptionHint: 'No salen quienes pidieron que no se les llame.',
  loading: 'Buscando a quién llamar…',
  loadError: 'No se pudo cargar la lista para llamar. Revisa tu conexión e inténtalo de nuevo.',
  retry: 'Reintentar',
  more: 'Más',
  showMore: (n: number) => (n === 1 ? 'Ver la que falta' : `Ver las ${n} que faltan`),
  showLess: 'Ver menos',
  callPhone: (phone: string) => `Llamar al ${phone}`,
  noPhone: 'Sin teléfono',
  noName: 'Sin nombre',
  patientContact: (name: string) => `Habla con ${name}`,
  gateReason: 'anotar llamadas',

  reason: {
    reminder_unanswered: 'Sin confirmar',
    robot_human: 'Pidió hablar con alguien',
    robot_advisor_missed: 'Asesor sin respuesta',
    robot_no_response: 'Sin respuesta al robot',
    robot_failed: 'Llamada fallida',
  } satisfies Record<CallListReason, string>,

  attempts: {
    robot: (n: number) => (n === 1 ? 'Robot: 1 intento' : `Robot: ${n} intentos`),
    manual: (n: number) => (n === 1 ? 'Equipo: 1 intento' : `Equipo: ${n} intentos`),
  },
  lastResult: (result: string, ago: string) => `Última: ${result}${ago ? `, ${ago}` : ''}`,

  result: {
    human: 'pidió hablar con alguien',
    advisorMissed: 'pidió un asesor y nadie contestó',
    advisorConnected: 'habló con un asesor',
    wrongNumber: 'número equivocado',
    noAnswer: 'no contestó',
    busy: 'estaba ocupado',
    noKey: 'contestó, pero no marcó nada',
    failed: 'la llamada no salió',
    calling: 'llamando ahora',
    other: 'sin resultado',
  },

  // Acciones
  confirmed: 'Confirmó',
  cancelled: 'Canceló',
  noResponse: 'No contestó',
  wrongNumber: 'Número equivocado',
  robotNow: 'Llamar con el robot ahora',
  robotCalling: 'El robot está llamando',
  robotNoAttempts: 'El robot ya hizo los 3 intentos',
  moreActions: 'Más acciones',
  actionAria: (action: string, who: string) => `${action}: ${who}`,

  // Avisos al terminar una acción
  done: {
    confirmed: 'Anotado: el paciente confirmó',
    cancelled: (l: AgendaLabels) => `${capitalizeFirst(l.cita)} cancelada`,
    no_response: 'Anotado: no contestó',
    wrong_number: 'Anotado: número equivocado',
    robot: 'El robot está llamando',
  },
  cancelledNotNotified: (l: AgendaLabels) => `${capitalizeFirst(l.cita)} cancelada, pero no se pudo avisar por WhatsApp`,
  notRecorded: 'La llamada no quedó en el historial',
  actionFailed: 'No se pudo completar la acción. Revisa tu conexión e inténtalo de nuevo.',

  // Confirmar la cancelación
  cancelDialog: {
    title: (l: AgendaLabels) => `Cancelar ${l.cita}`,
    // `summary` termina en "a. m." o "p. m.": ya trae su punto.
    description: (summary: string) => `Se cancelará: ${summary} Esto no se puede deshacer.`,
    notify: 'Avisar por WhatsApp',
    notifyHint: 'Le enviamos un mensaje diciendo que se canceló, con un botón para agendar otra.',
    back: 'Volver',
    confirm: (l: AgendaLabels) => `Sí, cancelar ${l.cita}`,
    saving: 'Cancelando…',
  },

  // Sin marcar
  unmarked: {
    title: 'Sin marcar',
    description: 'Ya empezaron hoy. Falta decir si vinieron.',
    attended: 'Atendió',
    noShow: 'No vino',
    attendedAria: (who: string) => `Atendió: ${who}`,
    noShowAria: (who: string) => `No vino: ${who}`,
    failed: 'No se pudo marcar. Revisa tu conexión e inténtalo de nuevo.',
  },
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ------------------------------------------------------------
// Funciones puras
// ------------------------------------------------------------

/** "hace 5 min", "hace 2 h", "hace 3 días". Una fecha rota da texto vacío. */
export function formatAgo(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor((now.getTime() - then) / 60_000)
  if (minutes < 1) return 'ahora mismo'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'hace 1 día' : `hace ${days} días`
}

/** "Hoy", "Mañana" o "jue 5 nov", según el día de la cita en hora de Bogotá. */
export function relativeDayLabel(startsAt: Date, now: Date): string {
  const dateKey = zonedDateKey(startsAt)
  const today = zonedDateKey(now)
  if (dateKey === today) return 'Hoy'
  if (dateKey === addDaysToKey(today, 1)) return 'Mañana'
  return formatDayLabel(dateKey)
}

const digitsOf = (raw: string): string => raw.replace(/\D/g, '')

/** "573001112233" → "+57 300 111 2233"; otro país, "+" y los dígitos. */
export function formatPhoneDisplay(raw: string): string {
  const digits = digitsOf(raw)
  if (digits.startsWith('57') && digits.length === 12) {
    return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
  }
  return `+${digits}`
}

/** `tel:+57…` para el enlace de llamar; null si no hay dígitos. */
export function telHref(raw: string): string | null {
  const digits = digitsOf(raw)
  return digits === '' ? null : `tel:+${digits}`
}

/** Lo que pasó en la última llamada del robot, en palabras simples. */
export function describeRobotResult(last: Pick<CallListLastCall, 'outcome' | 'status'>): string {
  const R = CALL_LIST_TEXTS.result
  if (last.status === 'failed') return R.failed
  switch (last.outcome) {
    case 'human':
      return R.human
    case 'advisor_missed':
      return R.advisorMissed
    case 'advisor_connected':
      return R.advisorConnected
    case 'wrong_number':
      return R.wrongNumber
    case 'no_response':
    case null:
      if (last.status === 'busy') return R.busy
      if (last.status === 'no_answer' || last.status === 'canceled') return R.noAnswer
      if (last.status === 'completed') return R.noKey
      return last.outcome === null && ['queued', 'calling', 'in_progress'].includes(last.status) ? R.calling : R.other
    default:
      return R.other
  }
}

/** Lo que la recepción anotó de una llamada a mano. */
export function describeManualResult(last: Pick<CallListLastCall, 'outcome' | 'status'>): string {
  const R = CALL_LIST_TEXTS.result
  if (last.outcome === 'wrong_number') return R.wrongNumber
  if (last.outcome === 'no_response') return R.noAnswer
  return R.other
}
