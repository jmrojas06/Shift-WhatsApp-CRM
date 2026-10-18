// ============================================================
// Textos de la superficie de barbería — español colombiano.
//
// Por decisión de producto, el vertical NO entra a los catálogos
// i18n del CRM (messages/*.json): su superficie es solo es-CO y su
// copy vive aquí, junto al manifest y las semillas.
// ============================================================

export const BARBERIA_TEXTS = {
  title: 'Barbería',
  subtitle: 'Tu plantilla de barbería: servicios, barberos y horarios.',
  loading: 'Cargando…',
  notEnabledTitle: 'Módulo no habilitado',
  notEnabledBody:
    'El módulo de barbería no está activo para esta cuenta. Pídele a tu asesor de Shift Digital que lo active.',
  loadError:
    'No se pudo cargar la información. Recarga la página e inténtalo de nuevo.',

  statusTitle: 'Estado de la plantilla',
  statusInstalled: 'Instalada',
  statusNotInstalled: 'Sin instalar',
  statusInstalledBody:
    'La plantilla está instalada. Reinstalar es seguro: no duplica ni sobrescribe lo que ya editaste.',
  statusNotInstalledBody:
    'Instala la plantilla para crear servicios de ejemplo, un barbero con horario, etiquetas, pipeline, respuestas rápidas y documentos para tu agente de IA.',
  installButton: 'Instalar plantilla de barbería',
  reinstallButton: 'Reinstalar plantilla',
  installing: 'Instalando…',
  gateReason: 'instalar la plantilla',
  installFailed: 'No se pudo completar la instalación. Inténtalo de nuevo.',

  reportTitle: 'Resultado de la instalación',
  createdLabel: 'creados',
  skippedLabel: 'ya existían',
  pipelineCreated: (stages: number) =>
    `Pipeline "Barbería" creado con ${stages} etapas`,
  pipelineSkipped: 'El pipeline "Barbería" ya existía',
  aiPromptWritten: 'Prompt creado (estaba vacío)',
  aiPromptAlreadySet: 'Prompt ya configurado; no se modificó',
  aiPromptNoConfig: 'Aún sin configurar',
  promptSuggestionTitle: 'Prompt sugerido para tu agente de IA',
  promptSuggestionHint:
    'Cópialo en Agentes de IA cuando conectes tu proveedor; no sobrescribimos nada.',

  servicesTitle: 'Servicios',
  servicesEmpty: 'Aún no hay servicios. Instala la plantilla o créalos a tu medida.',
  staffTitle: 'Barberos',
  staffEmpty: 'Aún no hay barberos en el equipo.',
  inactiveLabel: 'Inactivo',
  servicesCount: (n: number) => (n === 1 ? '1 servicio' : `${n} servicios`),
  staffCount: (n: number) => (n === 1 ? '1 barbero' : `${n} barberos`),
  minutes: (n: number) => `${n} min`,

  // ----------------------------------------------------------
  // Agenda del día
  // ----------------------------------------------------------
  agendaTitle: 'Agenda de hoy',
  agendaEmpty: 'No hay citas para hoy.',
  agendaServiceGone: 'Servicio eliminado',
  agendaStaffGone: 'Sin barbero',
  agendaContactFallback: 'Sin nombre',
  agendaStatusPending: 'Pendiente',
  agendaStatusConfirmed: 'Confirmada',
  agendaStatusCompleted: 'Completada',
  agendaStatusNoShow: 'No asistió',
  agendaStatusCancelled: 'Cancelada',
  agendaActionComplete: 'Completada',
  agendaActionNoShow: 'No asistió',
  agendaActionCancel: 'Cancelar',
  agendaChangeFailed:
    'No se pudo actualizar la cita. Recarga la agenda e inténtalo de nuevo.',
  agendaPastTitle: 'La cita ya pasó',
  agendaPastBody: (date: string, time: string) =>
    `La cita del ${date} a las ${time} ya pasó. ¿Seguro que quieres cambiar su estado?`,
  agendaPastConfirm: 'Sí, cambiar',
  agendaPastBack: 'Volver',
  viewerGate: 'acciones sobre las citas',

  // ----------------------------------------------------------
  // Recordatorios (Fase 3)
  // ----------------------------------------------------------
  remindersTitle: 'Recordatorios',
  remindersHint:
    'Cada cita recibe un recordatorio 24 horas antes; la segunda señal (2 horas antes) se activa por cuenta.',
  remindersWindowNote:
    'Con la conversación abierta (el cliente escribió en las últimas 24 h) se envía un mensaje con botones; si no, la plantilla aprobada de Meta.',
  remindersTwoHourOn: '2 h activado',
  remindersTwoHourOff: '2 h desactivado',
  remindersPendingTitle: 'Por enviar',
  remindersSentTitle: 'Enviados',
  remindersEmpty: 'No hay recordatorios pendientes ni enviados en este momento.',
  remindersPending24h: 'Pendiente 24 h',
  remindersPending2h: 'Pendiente 2 h',
  remindersSent24h: 'Enviado 24 h',
  remindersSent2h: 'Enviado 2 h',
  remindersSentAt: (date: string, time: string) => `enviado el ${date} a las ${time}`,
  remindersLoadFailed:
    'No se pudieron cargar los recordatorios. Recarga la página e inténtalo de nuevo.',

  sections: {
    services: 'Servicios',
    staff: 'Barberos',
    staffServices: 'Barbero–servicios',
    workingHours: 'Bloques de horario',
    tags: 'Etiquetas',
    customFields: 'Campos personalizados',
    quickReplies: 'Respuestas rápidas',
    knowledge: 'Documentos de conocimiento',
    aiAgent: 'Agente de IA',
    pipeline: 'Pipeline',
  },
} as const

// ============================================================
// Copy del agente de reservas por WhatsApp (controlador).
//
// Todo el diálogo del bot vive aquí: menús, resumen, confirmación,
// errores y handoff. El controlador nunca redacta texto en línea;
// así el copy se revisa en un solo archivo.
//
// Las plantillas que reciben datos lo hacen como funciones con
// argumentos con nombre — nada de concatenaciones en el llamador.
// ============================================================

/** Datos de una cita usados en resumen y confirmaciones. */
export interface BarberiaAppointmentSummary {
  service: string
  staff: string
  /** 'martes 20 de octubre de 2026' (formatLongDate). */
  date: string
  /** '3:00 p. m.' (formatTimeLabel). */
  time: string
  /** '$25.000'. */
  price: string
}

export const BARBERIA_AGENT_TEXTS = {
  // ----------------------------------------------------------
  // Arranque: menú de servicios
  // ----------------------------------------------------------
  serviceMenuBody:
    '¡Hola! 👋 Soy el asistente de la barbería. ¿Qué servicio quieres agendar?',
  serviceMenuButton: 'Ver servicios',
  /** Se agrega al pie cuando la lista se recortó a los primeros 10. */
  optionsTruncated: 'Te muestro las primeras opciones.',

  // ----------------------------------------------------------
  // Menú de barberos
  // ----------------------------------------------------------
  staffMenuBody: '¿Con cuál barbero quieres tu cita?',
  staffMenuButton: 'Ver barberos',
  staffAnyTitle: 'Cualquiera',
  staffAnyDescription: 'Te asignamos al barbero que esté disponible',

  // ----------------------------------------------------------
  // Días
  // ----------------------------------------------------------
  dayMenuBody: '¿Qué día te queda bien?',
  dayMenuButton: 'Ver días',
  dayToday: 'Hoy',
  dayTomorrow: 'Mañana',

  // ----------------------------------------------------------
  // Horas
  // ----------------------------------------------------------
  slotMenuBody: (day: string) => `Horarios disponibles para ${day}:`,
  slotMenuButton: 'Ver horarios',

  // ----------------------------------------------------------
  // Resumen y confirmación
  // ----------------------------------------------------------
  summaryBody: (a: BarberiaAppointmentSummary) =>
    `Así queda tu cita:\n\n💈 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n💵 ${a.price}\n\n¿La confirmamos?`,
  summaryConfirm: 'Confirmar ✅',
  summaryReschedule: 'Reprogramar',
  summaryCancel: 'Cancelar',
  confirmed: (a: BarberiaAppointmentSummary) =>
    `¡Listo! Tu cita quedó agendada.\n\n💈 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\nTe esperamos ✂️. Si necesitas cambiarla, escríbeme "cita".`,

  // ----------------------------------------------------------
  // Errores y recuperación
  // ----------------------------------------------------------
  retry: 'No entendí 😅. Por favor elige una de las opciones.',
  slotTaken:
    'Uy, ese horario se ocupó mientras elegías 😅. Te muestro otras opciones:',
  dayTaken: 'Ese día se llenó mientras elegías 😅. Mira los días disponibles:',
  noDaysAvailable:
    'Por ahora no tengo horarios disponibles. Escríbeme "asesor" y un humano te ayuda a cuadrar tu cita.',
  noServices:
    'Aún no hay servicios configurados en la barbería. Escríbeme "asesor" y te ayudamos.',
  noStaffForService:
    'Por ahora no hay barberos disponibles para ese servicio. Elige otro, por favor:',
  confirmError:
    'Uy, no pude agendar tu cita en este momento 😅. Intenta de nuevo o escríbeme "asesor".',

  // ----------------------------------------------------------
  // Gestión de una cita existente
  // ----------------------------------------------------------
  manageMenuBody: (a: { service: string; date: string; time: string }) =>
    `Vi que tienes una cita:\n\n💈 ${a.service}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Qué quieres hacer?`,
  manageNew: 'Nueva cita',
  manageReschedule: 'Reprogramar',
  manageCancel: 'Cancelar cita',
  rescheduleStart: 'Listo, elige el nuevo día para tu cita:',
  cancelConfirmBody: (a: { date: string; time: string }) =>
    `¿Seguro que quieres cancelar tu cita del ${a.date} a las ${a.time}?`,
  cancelYes: 'Sí, cancelar',
  cancelNo: 'No, volver',
  cancelDone:
    'Listo, tu cita quedó cancelada. Cuando quieras agendar otra, escríbeme "cita". 🙌',
  cancelDeclined: 'Perfecto, dejo tu cita como está. ¡Te esperamos! ✂️',
  rescheduleDone: (a: BarberiaAppointmentSummary) =>
    `¡Listo! Tu cita quedó reprogramada.\n\n💈 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¡Te esperamos! ✂️`,
  /** La cita gestionada ya no existe o ya no está activa. */
  managedAppointmentGone:
    'Veo que esa cita ya no está activa. Escríbeme "cita" para agendar una nueva.',
  /** Se abandonó un borrador de cita nueva desde el resumen. */
  draftCancelled:
    'Listo, no agendé nada. Cuando quieras agendar, escríbeme "cita". 🙌',
  /** Catálogo cambiado: el servicio de la cita ya no existe. */
  serviceFallback: 'tu servicio',

  // ----------------------------------------------------------
  // Recordatorios (Fase 3)
  //
  // El mismo contenido se envía como mensaje libre (ventana de 24 h
  // abierta) o como plantilla de Meta (ventana cerrada). Los botones
  // son Confirmar / Reprogramar / Cancelar con ids estáticos rem:*.
  // ----------------------------------------------------------
  reminderBody: (a: {
    business: string
    service: string
    staff: string
    date: string
    time: string
  }) =>
    `¡Hola! 👋 Te recordamos tu cita en ${a.business}:\n\n💈 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Nos confirmas?`,
  reminderConfirm: 'Confirmar',
  reminderReschedule: 'Reprogramar',
  reminderCancel: 'Cancelar',
  reminderConfirmed: (a: {
    service: string
    staff: string
    date: string
    time: string
  }) =>
    `¡Listo! Tu cita queda confirmada:\n\n💈 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¡Te esperamos! ✂️`,

  // ----------------------------------------------------------
  // Handoff a un humano
  // ----------------------------------------------------------
  handoff:
    'Entiendo. Dejo tu conversación con un asesor humano para que te ayude. En breve te contactan. 🙌',
  handoffNote:
    'El cliente pidió hablar con una persona desde el flujo de citas (agente de barbería en pausa).',
  handoffNotificationTitle: 'Cliente pide un asesor (Barbería)',
  handoffNotificationBody: (name: string) =>
    `${name} pidió hablar con una persona desde el flujo de citas.`,
} as const
