// ============================================================
// Copy del bot clínico — español colombiano.
//
// Como el resto del vertical, vive en código y no en messages/*.json.
// El texto de autorización y los signos de alarma son valores por
// defecto: el abogado y el director de la clínica los revisan antes de
// ir a producción, y cada cuenta guarda los suyos en clinic_settings.
// ============================================================

import type { AgendaLabels } from '@/verticals/agenda/labels'

export const DEFAULT_CONSENT_TEXT = [
  'Antes de seguir: para atenderte guardamos tu nombre, tu número y los datos de tus citas.',
  'Algunos pueden ser datos de salud, que son sensibles. No tienes la obligación de autorizarlos y te atendemos igual si no aceptas.',
  'Los usamos para atenderte: tus citas, tus recordatorios y el seguimiento después de cada visita.',
  '¿Autorizas el tratamiento de tus datos?',
].join('\n\n')

export const DEFAULT_URGENCY_ALARM_TEXT =
  'Ve a urgencias ahora si tienes dificultad para respirar o tragar, hinchazón que crece en la cara o el cuello, sangrado que no para, fiebre alta o un golpe fuerte en la cara.'

/** Sin tildes: se comparan contra el texto normalizado. */
export const DEFAULT_URGENCY_WORDS: readonly string[] = [
  'urgencia',
  'urgente',
  'emergencia',
  'dolor',
  'duele',
  'duelen',
  'sangrado',
  'sangra',
  'sangran',
  'sangrando',
  'sangrar',
  'sangro',
  'sangre',
  'hinchazon',
  'hinchado',
  'hinchada',
  'hincho',
  'inflamado',
  'inflamada',
  'inflamo',
  'absceso',
  'pus',
  'fiebre',
  'golpe',
  'fractura',
  'fracture',
  'se partio',
  'se me partio',
  'se quebro',
  'se me quebro',
  'se rompio',
  'se me rompio',
  'se me cayo',
  'respirar',
  'tragar',
  'me falta el aire',
]

/** Nota: una lista admite títulos de hasta 24 caracteres y un botón, 20. */
export function buildClinicTexts(l: AgendaLabels) {
  return {
    consentAccept: 'Sí, acepto',
    consentDecline: 'No acepto',
    consentDeclined: 'Entendido. Una persona de la clínica te atiende por este chat. 🙌',
    consentDeclinedNote: 'Paciente: no aceptó la autorización de datos (bot en pausa).',
    consentError: 'No pude guardar tu respuesta en este momento 😅. Intenta de nuevo, por favor.',

    /** La configuración de la clínica falta o no se pudo leer: el bot no atiende y pasa a una persona. */
    clinicUnavailableNote:
      'Paciente: el bot no lo atendió porque la configuración de la clínica no está disponible (bot en pausa). Revisa la configuración de la clínica.',
    clinicUnavailableUrgentNote:
      'Paciente: escribió una posible urgencia y la configuración de la clínica no está disponible (bot en pausa). Comunícate con esa persona ya.',

    menuBody: '¡Hola! 👋 Soy el asistente de la clínica. ¿En qué te ayudo?',
    menuButton: 'Ver opciones',
    menuBook: `Agendar ${l.cita}`,
    menuMine: `Mis ${l.citas}`,
    menuFaq: 'Precios y dudas',
    menuUrgent: 'Tengo una urgencia',
    menuHuman: 'Hablar con una persona',
    faqPrompt: 'Cuéntame tu duda y te respondo. 🙌',

    noUpcoming: `Por ahora no hay ${l.citas} a tu nombre. ¿Quieres agendar?`,
    pickAppointmentBody: `¿Sobre cuál ${l.cita}?`,
    pickAppointmentButton: `Ver ${l.citas}`,

    patientMenuBody: '¿Quién va a asistir?',
    patientMenuButton: 'Ver personas',
    patientOther: 'Otra persona',
    patientNamePrompt: 'Escríbeme el nombre y los apellidos de quien va a asistir.',
    patientNameRetry: 'Necesito nombre y apellidos, sin números. Escríbelos de nuevo, por favor.',
    patientSaveError: `No pude registrar a esa persona en este momento 😅. Intenta de nuevo o escríbeme "asesor".`,

    urgencyBody: (alarmText: string) => `${alarmText}\n\n¿Tienes alguno de estos signos?`,
    urgencyYes: 'Sí, tengo alguno',
    urgencyNo: 'No, ninguno',
    urgencyGoEr: 'Por favor ve a urgencias ahora. Ya avisé a la clínica para que se comuniquen contigo.',
    urgencyOffHours: (onCallPhone: string | null) =>
      onCallPhone
        ? `Hoy no tengo cupo en la agenda. Llama al ${onCallPhone}, que es el teléfono de turno. Si aparece alguno de los signos de alarma, ve a urgencias.`
        : 'Hoy no tengo cupo en la agenda. Ya avisé a la clínica para que te escriban a primera hora. Si aparece alguno de los signos de alarma, ve a urgencias.',
    urgencyNote: 'Paciente: reportó signos de alarma (bot en pausa).',
    urgencyOffHoursNote: 'Paciente: urgencia sin cupo en la agenda de hoy (bot en pausa).',
    urgencyNotificationTitle: '🚨 Posible urgencia',
    urgencyNotificationBody: (who: string) =>
      `${who} reportó una posible urgencia por WhatsApp. Comunícate con esa persona ya.`,

    moreDays: 'Ver más días',

    marketingBody: '¿Quieres que te avisemos cuando te toque tu próximo control o limpieza?',
    marketingYes: 'Sí, avísame',
    marketingNo: 'No, gracias',
    marketingThanksYes: 'Listo, te avisaremos. 🙌',
    marketingThanksNo: 'Perfecto, no te escribiremos por eso. 🙌',

    reminderBody: (a: {
      patient: string
      business: string
      location: string
      staff: string
      date: string
      time: string
    }) =>
      `¡Hola! 👋 Te recordamos que ${a.patient} tiene ${l.cita} en ${a.business}, sede ${a.location}:\n\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Nos confirmas?`,
    reminderStaffFallback: 'el equipo de la clínica',

    /** Mapa e instrucciones previas tras confirmar; null si no hay nada que decir. */
    prepInfo: (a: { prep: string | null; address: string | null; mapUrl: string | null }) => {
      const lines: string[] = []
      if (a.prep) lines.push(`Para tu ${l.cita}:\n${a.prep}`)
      if (a.address) lines.push(`📍 ${a.address}`)
      if (a.mapUrl) lines.push(a.mapUrl)
      return lines.length ? lines.join('\n\n') : null
    },
  }
}

export type ClinicTexts = ReturnType<typeof buildClinicTexts>
