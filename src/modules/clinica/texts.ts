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

/**
 * Nombre de la sede que se crea sola, y el que se usa cuando una cita no tiene
 * sede. Va sin la palabra "sede": el recordatorio ya dice "sede {nombre}", y
 * "Sede principal" saldría como "sede Sede principal".
 */
export const DEFAULT_LOCATION_NAME = 'Principal'

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
  'doliendo',
  'dolio',
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
  'calentura',
  'golpe',
  'golpee',
  'fractura',
  'fracture',
  'fracturo',
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

/**
 * Piso fijo de la detección de urgencias, en código y no en `clinic_settings`:
 * lo que SIEMPRE abre los signos de alarma, aunque la clínica deje su lista
 * vacía o se le olvide una forma de decirlo. Se suma a la lista de la clínica,
 * no la reemplaza. Sin tildes: se comparan contra el texto normalizado.
 *
 * Las raíces valen al inicio de una palabra ("hinch" es "hinchada", "hinchando"
 * y "hinchazón"; "inch" es "inchado", sin la h). Las palabras valen enteras:
 * "rota" no es "rotación", y "dolor" no es "Dolores", que es un nombre.
 *
 * Incluye las palabras de siempre (dolor, duele, urgente...): una clínica que
 * deja su lista vacía, o que la reemplaza por otra, sigue detectando "me duele una
 * muela", "no puedo tragar" y "es urgente".
 */
export const URGENCY_FLOOR_STEMS: readonly string[] = [
  'inch',
  'hinch',
  'hemorrag',
  'flemon',
  'infeccion',
  'ahog',
  'golpe',
  'sangr',
  'respir',
]

export const URGENCY_FLOOR_WORDS: readonly string[] = [
  'dolor',
  'duele',
  'duelen',
  'urgencia',
  'urgente',
  'emergencia',
  'tragar',
  'tragando',
  'rota',
  'rotas',
  'roto',
  'rotos',
  'partio',
  'partieron',
  'quebro',
  'quebraron',
  'rompio',
  'rompieron',
  // Dicho de otra persona ("a mi hijo se le partió un diente").
  'se le cayo',
  'se le cayeron',
  'se le inflamo',
  // Un diente o una muela que se cae, en primera persona o sin decir de quién.
  'se me cayo',
  'se cayo',
  'se me cayeron',
  'se cayeron',
]

/**
 * Temas que en esta versión atiende una persona (spec §5, etapa 2): quejas,
 * pagos y documentos. Sin tildes: se comparan contra el texto normalizado. Un
 * mensaje que trae una y no es una duda pasa a una persona, sin pedir antes la
 * autorización.
 */
export const CLINIC_HUMAN_WORDS: readonly string[] = [
  'queja',
  'reclamo',
  'pqr',
  'pqrs',
  'factura',
  'pago',
  'pagar',
  'abono',
  'saldo',
  'certificado',
  'incapacidad',
  'historia clinica',
  'radiografia',
  'receta',
  'documento',
  'documentos',
  // Pasado y plurales: "ya pagué", "necesito mis radiografías".
  'pague',
  'quejas',
  'reclamos',
  'pagos',
  'facturas',
  'abonos',
  'certificados',
  'radiografias',
  'recetas',
]

/** Nota: una lista admite títulos de hasta 24 caracteres y un botón, 20. */
export function buildClinicTexts(l: AgendaLabels) {
  return {
    consentAccept: 'Sí, acepto',
    consentDecline: 'No acepto',
    consentDeclined: 'Entendido. Una persona de la clínica te atiende por este chat. 🙌',
    consentDeclinedNote: 'Paciente: no aceptó la autorización de datos (bot en pausa).',
    consentRevokedNote: 'Paciente: revocó la autorización de datos (bot en pausa).',
    consentRevokedUnsavedNote:
      'Paciente: tocó "No acepto" para revocar la autorización de datos, pero no se pudo registrar. Regístralo a mano (bot en pausa).',
    /**
     * Aviso al equipo cuando alguien toca "No acepto" en un hilo que lleva una
     * persona y la revocación no se pudo registrar: el bot no le escribe al
     * paciente ni toma el hilo, así que lo tiene que registrar quien lo lleva.
     */
    consentRevokeFailedTitle: 'No se pudo registrar una revocación',
    consentRevokeFailedBody: (who: string) =>
      `${who} tocó "No acepto" para revocar la autorización de datos, pero no se pudo registrar. Regístralo a mano.`,
    /**
     * Revocó escribiendo y además pidió que borren sus datos: el bot no borra nada,
     * hay que atenderlo a mano. Es la nota del hilo (y, en el hilo de una persona, el aviso).
     */
    consentRevokedDeleteNote:
      'Paciente: revocó la autorización de datos y pidió que borren sus datos (bot en pausa). Hay que atenderlo a mano.',
    consentRevokedDeleteUnsavedNote:
      'Paciente: pidió que borren sus datos y revocó la autorización, pero la revocación no se pudo registrar. Regístrala a mano y atiéndelo a mano (bot en pausa).',
    consentDeletionRequestTitle: 'Un paciente pidió borrar sus datos',
    consentDeletionRequestBody: (who: string) =>
      `${who} revocó su autorización y pidió que borren sus datos. El bot no borra nada: hay que atenderlo a mano.`,
    consentError: 'No pude guardar tu respuesta en este momento 😅. Intenta de nuevo, por favor.',
    /** Pase a una persona porque la autorización no se respondió con los botones, o no se pudo guardar. */
    consentUnansweredNote:
      'Paciente: la autorización de datos quedó sin responder (bot en pausa).',

    /** La configuración de la clínica falta o no se pudo leer: el bot no atiende y pasa a una persona. */
    aiOffNote:
      'Paciente: escribió una duda y la IA no está activa para responderla (bot en pausa).',
    humanTopicNote:
      'Paciente: escribió sobre una queja, un pago o un documento, que atiende una persona (bot en pausa).',
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
    /** Una foto, un audio o un sticker: el bot no los lee, y no se queda callado. */
    nonTextNotice: 'Aún no puedo oír audios ni ver fotos. Escríbeme o elige una opción.',
    /** Un botón de un menú que ya no está activo. */
    optionExpired: 'Esa opción venció.',

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
    urgencyGoEr: 'Por favor ve a urgencias ahora, sin esperar respuesta. También avisé a la clínica.',
    urgencyOffHours: (onCallPhone: string | null) =>
      onCallPhone
        ? `Hoy no tengo cupo en la agenda. Llama al ${onCallPhone}, que es el teléfono de turno. Si aparece alguno de los signos de alarma, ve a urgencias ahora, sin esperar respuesta.`
        : 'Hoy no tengo cupo en la agenda. Ya avisé a la clínica para que te escriban a primera hora. Si aparece alguno de los signos de alarma, ve a urgencias ahora, sin esperar respuesta.',
    /**
     * Dos respuestas que no se entendieron (o pidió una persona) mientras se
     * preguntaban los signos: ya dijo que le duele y no se sabe si es grave.
     * Repite los signos, que son los de la clínica, y no dice nada más.
     */
    urgencyPending: (alarmText: string) =>
      `${alarmText}\n\nYa avisé a la clínica para que se comuniquen contigo. Si tienes alguno de esos signos, ve a urgencias ahora, sin esperar respuesta.`,
    urgencyNote: 'Paciente: reportó signos de alarma (bot en pausa).',
    urgencyOffHoursNote: 'Paciente: urgencia sin cupo en la agenda de hoy (bot en pausa).',
    /** Una urgencia sin signos de alarma que pidió una persona o no logró agendar. */
    urgencyBookingNote:
      'Paciente: escribió una posible urgencia, sin signos de alarma, y pidió una persona o no logró agendar (bot en pausa). Comunícate con esa persona ya.',
    urgencyPendingNote:
      'Paciente: escribió una posible urgencia y no confirmó si tiene signos de alarma (bot en pausa). Comunícate con esa persona ya.',
    /** Rechazó o dejó sin responder la autorización que se le pidió para agendar la urgencia. */
    urgencyConsentDeclinedNote:
      'Paciente: escribió una posible urgencia y no aceptó la autorización de datos (bot en pausa). Comunícate con esa persona ya.',
    urgencyConsentUnansweredNote:
      'Paciente: escribió una posible urgencia y dejó la autorización de datos sin responder (bot en pausa). Comunícate con esa persona ya.',
    /**
     * El primer aviso: la persona abrió los signos de alarma (escribió algo que puede ser
     * una urgencia o tocó "Tengo una urgencia") y todavía no ha contestado. Sale ya, sin
     * esperar; el de abajo es el de confirmación, que dice algo más grave.
     */
    urgencyOpenedNotificationTitle: '⚠️ Revisa este chat: posible urgencia',
    urgencyOpenedNotificationBody: (who: string) =>
      `${who} escribió algo que puede ser una urgencia y el bot le está mostrando los signos de alarma. Mira el chat ya.`,
    urgencyNotificationTitle: '🚨 Posible urgencia',
    urgencyNotificationBody: (who: string) =>
      `${who} reportó una posible urgencia por WhatsApp. Comunícate con esa persona ya.`,

    /**
     * La IA no contesta nada de salud y pasa el chat a una persona. Sin esto el
     * paciente se queda sin respuesta y nadie se entera: un texto fijo (nada de
     * diagnóstico) con los signos de alarma de la clínica, y un aviso en la app.
     */
    aiHandoffNotice: (alarmText: string) =>
      `Esto lo debe revisar una persona de la clínica. Ya le avisé y te escribe por este chat. Si aparece uno de estos signos, ve a urgencias sin esperar respuesta:\n\n${alarmText}`,
    aiHandoffNotificationTitle: 'Un paciente necesita a una persona',
    aiHandoffNotificationBody: (who: string) =>
      `${who} escribió algo sobre su salud que el asistente no contesta. Respóndele por este chat.`,

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
    /**
     * La respuesta a tocar Confirmar en un recordatorio. El teléfono puede ser
     * compartido: nombra al paciente, al profesional, la fecha y la hora, y nunca
     * el procedimiento (por eso no recibe el servicio). Sin el nombre del
     * paciente omite esa línea.
     */
    reminderConfirmed: (a: {
      patient: string | null
      staff: string
      date: string
      time: string
    }) =>
      [
        '¡Listo! Queda confirmado:',
        '',
        ...(a.patient ? [`🙋 Paciente: ${a.patient}`] : []),
        `👤 ${a.staff}`,
        `📅 ${a.date}`,
        `🕐 ${a.time}`,
        '',
        '¡Te esperamos! 🙌',
      ].join('\n'),

    /**
     * Mapa e instrucciones previas tras confirmar; null si no hay nada que decir. Lo
     * que solo tiene espacios no cuenta: no se manda un mensaje vacío.
     */
    prepInfo: (a: { prep: string | null; address: string | null; mapUrl: string | null }) => {
      const prep = a.prep?.trim()
      const address = a.address?.trim()
      const mapUrl = a.mapUrl?.trim()
      const lines: string[] = []
      if (prep) lines.push(`Para tu ${l.cita}:\n${prep}`)
      if (address) lines.push(`📍 ${address}`)
      if (mapUrl) lines.push(mapUrl)
      return lines.length ? lines.join('\n\n') : null
    },

    // ------------------------------------------------------------
    // Después de la cita (Fase 3, §7). El teléfono puede ser compartido y el
    // texto pasa por Meta: se nombra al paciente y al negocio, nunca el
    // procedimiento. Los cuidados (que sí vienen del servicio) solo salen con
    // la ventana de 24 h abierta; la plantilla solo invita a verlos.
    // Los cuerpos "...TemplateBody" son los de las plantillas aprobadas en
    // Meta (variables {{1}} negocio y {{2}} paciente, en el orden en que salen
    // en el texto): el mismo texto se guarda en la bandeja cuando sale la
    // plantilla. Si cambias el orden de las frases, cambia también el de
    // `buildFollowupTemplateParams`: Meta exige las variables en orden numérico.
    // ------------------------------------------------------------
    followupCareBody: (a: { patient: string; business: string; instructions: string }) =>
      `¡Hola! 👋 Gracias por venir a ${a.business}. Estos son los cuidados para ${a.patient} después de su ${l.cita}:\n\n${a.instructions.trim()}`,
    followupCareTemplateBody: (a: { patient: string; business: string }) =>
      `¡Hola! 👋 Gracias por venir a ${a.business}. Tenemos unas recomendaciones de cuidado para ${a.patient} después de su visita. Toca el botón para verlas.`,
    followupCareButton: 'Ver recomendaciones',

    followupHowBody: (a: { patient: string; business: string }) =>
      `¡Hola! 👋 Te escribimos de ${a.business}. ¿Cómo sigue ${a.patient} después de su visita?`,
    followupHowGood: 'Bien',
    followupHowTrouble: 'Tengo molestias',
    followupHowHelp: 'Necesito ayuda',

    followupRatingBody: (a: { patient: string; business: string }) =>
      `¡Hola! 👋 En ${a.business} queremos saber cómo le fue a ${a.patient} en su visita. ¿Cómo la calificas?`,
    followupRatingGood: 'Bien',
    followupRatingRegular: 'Regular',
    followupRatingBad: 'Mal',

    // ------------------------------------------------------------
    // Respuestas del bot a esos botones (§7.4). Son mensajes libres: el paciente
    // acaba de escribir, así que la ventana de 24 h está abierta.
    // ------------------------------------------------------------
    /** "Ver recomendaciones": las instrucciones del servicio de esa visita. */
    followupCareReply: (instructions: string) =>
      `Estas son las recomendaciones de cuidado después de tu ${l.cita}:\n\n${instructions.trim()}`,
    /** El servicio ya no tiene instrucciones (se borraron después de enviar el botón). */
    followupCareNone: 'Por ahora no tengo recomendaciones para esa visita. Si tienes dudas, escríbenos por aquí.',
    followupWellReply: '¡Qué bueno! Cualquier cosa, escríbenos por aquí.',
    /** Molestias o ayuda: se avisa al equipo y se repiten los signos de alarma de la clínica. */
    followupTroubleReply: (alarmText: string) =>
      `Le avisamos al equipo para que te contacten pronto.\n\n${alarmText}`,
    followupTroubleNote:
      'Paciente: respondió que tiene molestias o necesita ayuda después de su visita (bot en pausa). Comunícate con esa persona ya.',
    followupTroubleNotificationTitle: '⚠️ Un paciente tiene molestias después de su visita',
    followupTroubleNotificationBody: (who: string) =>
      `${who} respondió que tiene molestias o necesita ayuda después de su visita. Comunícate con esa persona ya.`,
    /** Va a todos los que califican; el enlace de Google solo si la sede lo tiene. */
    followupRatingThanks: (reviewUrl: string | null) =>
      reviewUrl
        ? `¡Gracias por contarnos! Si quieres, déjanos tu opinión en Google: ${reviewUrl}`
        : '¡Gracias por contarnos!',
    /** Regular o Mal: el dueño recibe el aviso para que alguien llame. */
    followupLowRatingNotificationTitle: (value: 'regular' | 'mal') =>
      `Calificación ${value === 'mal' ? 'Mal' : 'Regular'}: llama al paciente`,
    followupLowRatingNotificationBody: (who: string, value: 'regular' | 'mal') =>
      `${who} calificó su visita como ${value === 'mal' ? 'Mal' : 'Regular'}. Que alguien lo llame para saber qué pasó.`,

    /** Cierre del día: aviso al dueño de las citas de hoy que nadie marcó como atendidas o no vino. */
    dayCloseTitle: 'Cierre del día pendiente',
    dayCloseBody: (count: number) =>
      `Tienes ${count} ${count === 1 ? l.cita : l.citas} de hoy sin marcar. En la agenda, en "Sin marcar", elige Atendió o No vino.`,
  }
}

export type ClinicTexts = ReturnType<typeof buildClinicTexts>
