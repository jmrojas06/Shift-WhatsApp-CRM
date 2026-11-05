// ============================================================
// Guion del robot de voz (diseño §6.2 y §6.3), en español de Colombia.
//
// Cada frase es una función pura que devuelve el texto; quien arma la
// llamada lo mete en un `<Say>`. Reglas del guion:
//
//   - Se tutea y se dice "marca 1", como se habla en Colombia.
//   - Nada que la voz sintética lea mal: ni "a. m." ni "p. m.", ni
//     abreviaturas ("Dra.", "Cra."), ni emoji, ni formato de WhatsApp.
//     Las horas se dicen "a las 3 y media de la tarde".
//   - NUNCA se nombra el procedimiento: el teléfono puede ser compartido.
//     Por eso ninguna función recibe el servicio.
//   - El nombre del negocio, del paciente y del profesional salen de la base
//     y pasan por `speakable` antes de decirse.
// ============================================================

import { formatOfficeHours, spokenAtTime, spokenClockTime, type OfficeHours } from '@/lib/voice/hours'
import { formatLongDate } from '@/verticals/agenda/agent/format'
import { addDaysToKey, zonedParts } from '@/verticals/agenda/agent/time'

// ------------------------------------------------------------
// Texto que se puede decir
// ------------------------------------------------------------

/** Caracteres de control, de ancho cero y separadores de línea raros. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\uFEFF]/g
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bDra\.?(?=\s)/g, 'doctora'],
  [/\bDr\.?(?=\s)/g, 'doctor'],
  [/\bSrta\.(?=\s)/g, 'señorita'],
  [/\bSra\.(?=\s)/g, 'señora'],
  [/\bSr\.(?=\s)/g, 'señor'],
  [/\bAv\.(?=\s)/g, 'avenida'],
  [/\bCra\.(?=\s)/g, 'carrera'],
  [/\bCll?\.(?=\s)/g, 'calle'],
  [/\bDg\.(?=\s)/g, 'diagonal'],
  [/\bTv\.(?=\s)/g, 'transversal'],
]

/** "8 a. m.", "6:30 pm", "1pm" → "8 de la mañana", "6 y media de la tarde", "1 de la tarde". */
function expandClockTimes(text: string): string {
  return text
    .replace(
      /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?(?![\p{L}\d])/giu,
      (match, h: string, mm: string | undefined, ap: string) => {
        const hour = Number(h)
        const minute = mm ? Number(mm) : 0
        if (hour < 1 || hour > 12 || minute > 59) return match
        const isMorning = ap.toLowerCase() === 'a'
        const hour24 = isMorning ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12
        return spokenClockTime(hour24, minute)
      },
    )
    .replace(/\b12\s*m\.(?![\p{L}\d])/gu, '12 del día')
}

/** Recorta en un límite de palabra, nunca a media palabra. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  if (/\s/.test(text[max])) return slice.trim()
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim()
}

/**
 * Deja un texto de la base listo para leerlo en voz alta: sin emoji, formato
 * de WhatsApp ni enlaces; con las horas y las abreviaturas dichas completas;
 * y con las líneas unidas como frases. `max` recorta en un límite de palabra.
 */
export function speakable(text: string | null | undefined, max = 600): string {
  let out = String(text ?? '')
    .replace(/\r\n?|\u2028|\u2029/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(EMOJI, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[*_~`]/g, '')
  out = expandClockTimes(out)
  for (const [pattern, spoken] of ABBREVIATIONS) out = out.replace(pattern, spoken)
  out = out.replace(/\s*#\s*/g, ' número ')

  const lines = out
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*[•▪◦‣∙●○■□►▶–—-]\s+/u, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line !== '')

  let joined = ''
  lines.forEach((line, index) => {
    if (index > 0) joined += /[.!?…:;,]$/.test(lines[index - 1]) ? ' ' : '. '
    joined += line
  })
  return cutAtWord(joined.replace(/\s+/g, ' ').trim(), max)
}

/** Un nombre propio dicho en voz alta: una línea, sin punto final suelto. */
function spokenName(text: string | null | undefined): string {
  return speakable(text, 80).replace(/[.,;:\s]+$/, '')
}

/** "Dr. Juan Pérez" → "el doctor Juan Pérez"; "Laura" → "Laura". Vacío si no queda nada. */
export function spokenStaff(name: string | null | undefined): string {
  const spoken = spokenName(name)
  if (/^doctora\b/i.test(spoken)) return `la ${spoken}`
  if (/^doctor\b/i.test(spoken)) return `el ${spoken}`
  return spoken
}

/** Termina el texto en punto si no trae signo final. */
function sentence(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

// ------------------------------------------------------------
// Fechas y horas dichas
// ------------------------------------------------------------

/**
 * "el martes 10 de noviembre" (el día 1 es "primero"). Con `todayKey`, la
 * fecha de hoy y la de mañana se dicen "hoy" y "mañana".
 */
export function spokenDay(dateKey: string, todayKey?: string): string {
  if (todayKey) {
    if (dateKey === todayKey) return 'hoy'
    if (dateKey === addDaysToKey(todayKey, 1)) return 'mañana'
  }
  const withoutYear = formatLongDate(dateKey).replace(/ de \d{4}$/, '')
  return `el ${withoutYear.replace(/^(\S+) 1 de /, '$1 primero de ')}`
}

/**
 * Día y hora dichos de una cita, en hora de Bogotá:
 * `{ day: 'el martes 10 de noviembre', time: 'a las 3 y media de la tarde' }`.
 * Si se da `now`, la cita de hoy o de mañana lo dice así.
 */
export function spokenWhen(startsAt: Date, now?: Date): { day: string; time: string } {
  const local = zonedParts(startsAt)
  return {
    day: spokenDay(local.dateKey, now ? zonedParts(now).dateKey : undefined),
    time: spokenAtTime(local.hour, local.minute),
  }
}

// ------------------------------------------------------------
// Llamadas salientes (§6.2)
// ------------------------------------------------------------

export interface AppointmentSpeech {
  /** De `spokenWhen`: "el martes 10 de noviembre". */
  day: string
  /** De `spokenWhen`: "a las 3 y media de la tarde". */
  time: string
  /** Profesional que atiende, o null. */
  staff: string | null
}

const assistantIntro = (business: string): string => {
  const name = spokenName(business)
  return name ? `soy el asistente virtual de ${name}` : 'soy el asistente virtual'
}

const withStaff = (staff: string | null): string => {
  const spoken = spokenStaff(staff)
  return spoken ? `, con ${spoken}` : ''
}

const MENU_APPOINTMENT_KEYS = 'Para confirmarla, marca 1. Para cancelarla, marca 2.'

/**
 * El saludo de la llamada de confirmación. Nunca lleva el procedimiento.
 * Sin paciente dice "tu cita"; sin profesional, no lo menciona.
 */
export function outboundMenu(args: AppointmentSpeech & { business: string; patient: string | null }): string {
  const patient = spokenName(args.patient)
  const appointment = patient ? `la cita de ${patient}` : 'tu cita'
  return (
    `Hola, ${assistantIntro(args.business)}. ` +
    `Te llamamos para recordarte ${appointment} para ${args.day} ${args.time}${withStaff(args.staff)}. ` +
    `${MENU_APPOINTMENT_KEYS} Para hablar con alguien del equipo, marca 3.`
  )
}

/** La segunda vuelta del menú, más corta. */
export function outboundReprompt(): string {
  return 'Para confirmar tu cita, marca 1. Para cancelarla, marca 2. Para hablar con alguien del equipo, marca 3.'
}

export function appointmentConfirmed(): string {
  return 'Listo, tu cita quedó confirmada. Te esperamos. Hasta luego.'
}

export function cancelConfirmAsk(): string {
  return '¿Seguro que quieres cancelarla? Marca 1 para sí o 2 para no.'
}

export function appointmentCancelled(): string {
  return 'Tu cita quedó cancelada. Te escribimos por WhatsApp para agendar otra.'
}

/** Pidió hablar con alguien y no hay asesor al que pasar la llamada. */
export function humanFollowUp(): string {
  return 'Listo, alguien del equipo te va a contactar pronto. Hasta luego.'
}

export function advisorConnecting(): string {
  return 'Te comunico con un asesor.'
}

export function noResponse(): string {
  return 'No recibimos respuesta. Hasta luego.'
}

export function notUnderstood(): string {
  return 'No entendí.'
}

/** La cita se canceló o pasó antes de que contestaran. */
export function appointmentInactive(): string {
  return 'Esta cita ya no está activa. Hasta luego.'
}

export function goodbye(): string {
  return 'Hasta luego.'
}

/** Antes del guion de ejemplo de "Probar llamada": deja claro que no toca citas. */
export function testCallIntro(): string {
  return 'Esta es una llamada de prueba. No se va a cambiar ninguna cita.'
}

// ------------------------------------------------------------
// Llamadas entrantes (§6.3)
// ------------------------------------------------------------

export function numberUnavailable(): string {
  return 'Este número no está disponible.'
}

export function thanksGoodbye(): string {
  return 'Gracias por llamar. Hasta luego.'
}

export function inboundGreeting(args: { business: string }): string {
  const name = spokenName(args.business)
  return name
    ? `Hola, gracias por llamar a ${name}. Soy el asistente virtual.`
    : 'Hola, gracias por llamar. Soy el asistente virtual.'
}

/** Las opciones del menú; las clínicas ofrecen primero la urgencia (9). */
export function inboundMenu(args: { clinic: boolean }): string {
  return (
    (args.clinic ? 'Si es una urgencia, marca 9. ' : '') +
    'Para agendar una cita, marca 1. ' +
    'Para confirmar o cancelar una cita que ya tienes, marca 2. ' +
    'Para conocer el horario y la dirección, marca 3. ' +
    'Para hablar con un asesor, marca 0.'
  )
}

/** Lee los signos de alarma de la clínica y manda a urgencias. */
export function urgencyAlarm(args: { alarmText: string | null | undefined }): string {
  const signs = speakable(args.alarmText, 500)
  if (signs === '') return 'Si tienes una urgencia, ve a urgencias ahora.'
  return `${sentence(signs)} Si tienes alguno de estos signos, ve a urgencias ahora.`
}

/** Fuera de horario, la llamada de urgencia pasa al teléfono de turno de la sede. */
export function urgencyOnCall(): string {
  return 'Te comunico con el profesional de turno.'
}

export function urgencyNoOne(): string {
  return 'Le avisamos al equipo y te escribirán a primera hora.'
}

export function bookingLinkSent(): string {
  return 'Te enviamos un WhatsApp a este número para que agendes en un minuto.'
}

export function bookingLinkFailed(): string {
  return 'No pudimos enviarte el WhatsApp. Escríbenos por WhatsApp para agendar.'
}

/** La próxima cita del número que llama, con las teclas para confirmarla o cancelarla. */
export function myAppointment(args: AppointmentSpeech & { patient: string | null }): string {
  const patient = spokenName(args.patient)
  const when = `${args.day} ${args.time}${withStaff(args.staff)}`
  const lead = patient
    ? `La próxima cita registrada con este número es la de ${patient}, para ${when}.`
    : `Tu próxima cita es para ${when}.`
  return `${lead} ${MENU_APPOINTMENT_KEYS} Para volver al menú, marca 0.`
}

export function noAppointments(): string {
  return 'No encontramos citas con este número. Para agendar, marca 1.'
}

/** Las teclas del submenú de la cita cuando se repite (sin volver a leer los datos). */
export function inboundApptReprompt(): string {
  return 'Para confirmar tu cita, marca 1. Para cancelarla, marca 2. Para volver al menú, marca 0.'
}

/**
 * Algo falló por dentro en una llamada entrante. A diferencia de `humanFollowUp`
 * no promete que alguien llamará: puede que la llamada ni siquiera tenga registro.
 */
export function temporaryFailure(): string {
  return 'En este momento no podemos atender tu llamada. Escríbenos por WhatsApp. Hasta luego.'
}

/** Opción 3: el texto de horario y dirección del negocio o, si no hay, el horario de atención. */
export function officeInfo(args: { infoText: string | null | undefined; officeHours: OfficeHours }): string {
  const info = speakable(args.infoText)
  if (info !== '') return sentence(info)
  const hours = formatOfficeHours(args.officeHours, { spoken: true })
  if (hours !== '') return `Atendemos ${hours}.`
  return 'Por ahora no tenemos el horario disponible por teléfono. Escríbenos por WhatsApp.'
}

export function advisorMissed(): string {
  return 'En este momento no hay asesores disponibles. Le avisamos al equipo para que te llame.'
}

/** Pidió un asesor fuera del horario de atención. */
export function outOfHours(args: { officeHours: OfficeHours }): string {
  const hours = formatOfficeHours(args.officeHours, { spoken: true })
  if (hours === '') {
    return 'En este momento no tenemos asesores disponibles. Para agendar por WhatsApp, marca 1.'
  }
  return (
    'En este momento estamos fuera del horario de atención. ' +
    `Atendemos ${hours}. ` +
    'Si deseas hablar con un asesor, llama en ese horario y marca 0. Para agendar por WhatsApp, marca 1.'
  )
}
