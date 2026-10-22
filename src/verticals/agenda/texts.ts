// ============================================================
// Textos de la superficie de barbería — español colombiano.
//
// Por decisión de producto, el vertical NO entra a los catálogos
// i18n del CRM (messages/*.json): su superficie es solo es-CO y su
// copy vive aquí, junto al manifest y las semillas.
// ============================================================

/**
 * Claves del copy del bot que el dueño puede sobreescribir desde
 * Configuración (Fase 4). Son mensajes planos (sin datos de la cita):
 * los textos con placeholders se quedan en código para no romper el
 * resumen, la confirmación ni la plantilla de Meta.
 */
export type EditableBotTextKey =
  | 'welcome'
  | 'retry'
  | 'noServices'
  | 'noDaysAvailable'
  | 'handoff'

export const AGENDA_TEXTS = {
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
    'Cada cita recibe un recordatorio 24 horas antes; la segunda señal (2 horas antes) se activa en Configuración.',
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

  // ----------------------------------------------------------
  // Configuración (Fase 4) — /agenda/configuracion
  // ----------------------------------------------------------
  config: {
    title: 'Configuración',
    subtitle:
      'Administra tu negocio, tus servicios, tus barberos y los textos del bot.',
    openConfig: 'Configuración',
    backToAgenda: 'Volver a la agenda',
    loading: 'Cargando la configuración…',
    loadFailed:
      'No se pudo cargar la configuración. Recarga la página e inténtalo de nuevo.',
    retry: 'Reintentar',
    saveFailed:
      'No se pudieron guardar los cambios. Inténtalo de nuevo en un momento.',
    saved: 'Cambios guardados.',
    saving: 'Guardando…',
    viewerGate: 'editar la configuración',

    validation: {
      nameRequired: 'El nombre es obligatorio.',
      priceInvalid:
        'El precio debe estar entre 0 y 99.999.999,99 con máximo 2 decimales.',
      durationInvalid:
        'La duración debe ser un número entero entre 1 y 480 minutos.',
      incompleteHours: 'Completa la hora de inicio y de fin de cada bloque.',
      invalidDateTime: 'Completa la fecha y la hora de cada campo.',
      endBeforeStart: 'La fecha de fin debe ser posterior a la de inicio.',
    },

    actions: {
      edit: 'Editar',
      activate: 'Activar',
      deactivate: 'Desactivar',
      cancel: 'Cancelar',
    },

    tabs: {
      business: 'Negocio',
      services: 'Servicios',
      staff: 'Barberos',
      schedule: 'Horarios',
      timeOff: 'Bloqueos',
      bot: 'Bot y recordatorios',
    },

    business: {
      title: 'Datos del negocio',
      name: 'Nombre del negocio',
      nameHint:
        'Es el nombre que ven tus clientes en WhatsApp y en los recordatorios.',
      address: 'Dirección',
      addressPlaceholder: 'Cra. 7 # 45-12, Bogotá',
      addressHint: 'Dirección del local (opcional).',
      timezone: 'Zona horaria',
      timezoneValue: 'America/Bogota (fija)',
      timezoneHint: 'Todas las citas se agendan y se muestran en hora de Bogotá.',
      currency: 'Moneda',
      currencyHint: 'Se usa para mostrar el precio de los servicios.',
      save: 'Guardar datos del negocio',
    },

    reminders: {
      title: 'Recordatorios de citas',
      alwaysTitle: 'Recordatorio 24 h antes',
      alwaysBody:
        'Siempre activo: cada cita recibe un recordatorio el día anterior.',
      twoHourTitle: 'Segunda señal 2 h antes',
      twoHourBody:
        'Envía un recordatorio adicional dos horas antes de la cita.',
    },

    services: {
      title: 'Servicios',
      empty:
        'Aún no hay servicios. Crea el primero para que el bot pueda ofrecerlo.',
      add: 'Agregar servicio',
      createTitle: 'Nuevo servicio',
      editTitle: 'Editar servicio',
      name: 'Nombre',
      description: 'Descripción',
      descriptionPlaceholder: 'Corte clásico con máquina y tijera',
      duration: 'Duración (minutos)',
      price: 'Precio',
      active: 'Activo',
      inactive: 'Inactivo',
      activeHint:
        'Los servicios inactivos dejan de ofrecerse en nuevas reservas; las citas existentes no se modifican.',
      moveUp: 'Subir',
      moveDown: 'Bajar',
      save: 'Guardar servicio',
    },

    staff: {
      title: 'Barberos',
      empty:
        'Aún no hay barberos. Crea el equipo para asignarles horarios y servicios.',
      add: 'Agregar barbero',
      createTitle: 'Nuevo barbero',
      editTitle: 'Editar barbero',
      name: 'Nombre',
      bio: 'Descripción',
      bioPlaceholder: 'Especialista en fades y barba',
      bioHint: 'Descripción corta (opcional).',
      active: 'Activo',
      inactive: 'Inactivo',
      servicesTitle: 'Servicios que atiende',
      servicesHint:
        'Solo se ofrecerá este barbero para los servicios marcados. La opción "Cualquiera" asigna al que esté disponible.',
      noServicesAvailable:
        'Todavía no hay servicios activos. Créalos en la pestaña Servicios.',
      save: 'Guardar barbero',
    },

    schedule: {
      title: 'Horario semanal',
      subtitle:
        'Define cuándo acepta citas cada barbero. Los cambios aplican de inmediato a nuevas reservas; las citas ya confirmadas no se tocan.',
      pickStaff: 'Barbero',
      pickStaffEmpty: 'Crea primero un barbero para configurar su horario.',
      hint: 'Para el almuerzo, usa dos bloques (por ejemplo 9:00–12:00 y 13:00–18:00).',
      empty: 'Sin bloques este día.',
      addBlock: 'Agregar bloque',
      removeBlock: 'Quitar bloque',
      save: 'Guardar horario',
      weekdays: [
        'Domingo',
        'Lunes',
        'Martes',
        'Miércoles',
        'Jueves',
        'Viernes',
        'Sábado',
      ],
    },

    timeOff: {
      title: 'Bloqueos puntuales',
      subtitle:
        'Vacaciones, citas médicas o días no disponibles. Mientras un bloqueo está activo, el bot no ofrece horas en ese rango.',
      pickStaff: 'Barbero',
      pickStaffEmpty: 'Crea primero un barbero para programar bloqueos.',
      from: 'Desde',
      to: 'Hasta',
      reason: 'Motivo',
      reasonPlaceholder: 'Vacaciones, diligencia personal…',
      add: 'Agregar bloqueo',
      empty: 'No hay bloqueos programados.',
      upcoming: 'Próximos bloqueos',
      delete: 'Eliminar',
      deleteTitle: 'Eliminar bloqueo',
      deleteBody: '¿Seguro que quieres eliminar este bloqueo? El barbero vuelve a estar disponible en ese rango.',
      deleteYes: 'Sí, eliminar',
      deleteNo: 'Cancelar',
      past: 'Pasado',
    },

    bot: {
      title: 'Textos del bot',
      hint: 'Personaliza los mensajes del flujo de reservas. Deja un campo vacío para usar el texto por defecto. Los mensajes con datos de la cita (resumen, confirmación, recordatorio) no se editan aquí.',
      defaultLabel: 'Texto por defecto:',
      useDefault: 'Usar texto por defecto',
      save: 'Guardar textos',
      labels: {
        welcome: 'Bienvenida',
        retry: 'Respuesta no entendida',
        noServices: 'Sin servicios activos',
        noDaysAvailable: 'Sin horarios disponibles',
        handoff: 'Pase a un asesor',
      } satisfies Record<EditableBotTextKey, string>,
      hints: {
        welcome: 'Primer mensaje cuando el cliente escribe "hola" o "cita".',
        retry:
          'Cuando la respuesta no coincide con el menú (se reenvía el menú).',
        noServices: 'Cuando el catálogo no tiene servicios activos.',
        noDaysAvailable:
          'Cuando no hay horarios libres en los próximos días.',
        handoff: 'Cuando el cliente pide hablar con una persona.',
      } satisfies Record<EditableBotTextKey, string>,
    },
  },
} as const

// ============================================================
// Copy del agente de reservas por WhatsApp (controlador).
//
// Todo el diálogo del bot vive aquí: menús, resumen, confirmación,
// errores y handoff. El controlador nunca redacta texto en línea;
// así el copy se revisa en un solo archivo.
//
// El copy es una función de las palabras del negocio (labels):
// "barbero", "doctor", "técnico"; "cita", "turno", "sesión".
// Las plantillas que reciben datos lo hacen como funciones con
// argumentos con nombre — nada de concatenaciones en el llamador.
// ============================================================

import { truncate } from './agent/format'
import { DEFAULT_LABELS, type AgendaLabels } from './labels'

/** Datos de una cita usados en resumen y confirmaciones. */
export interface AgendaAppointmentSummary {
  service: string
  /** Vacío cuando el negocio no pregunta "¿con quién?" y aún no hay asignado. */
  staff: string
  /** 'martes 20 de octubre de 2026' (formatLongDate). */
  date: string
  /** '3:00 p. m.' (formatTimeLabel). */
  time: string
  /** '$25.000', o null si el negocio esconde precios. */
  price: string | null
  /** Respuestas a las preguntas extra, en orden. */
  answers?: { label: string; value: string }[]
}

/**
 * Meta cuenta los títulos de botón y el botón de lista en unidades
 * UTF-16 (un emoji vale 2) y los limita a 20. `truncate` no parte
 * un par sustituto.
 */
const BUTTON_MAX = 20
const btn = (text: string) => truncate(text, BUTTON_MAX)

function summaryLines(a: AgendaAppointmentSummary, opts: { price?: boolean } = {}): string {
  const lines = [`📌 ${a.service}`]
  if (a.staff) lines.push(`👤 ${a.staff}`)
  lines.push(`📅 ${a.date}`, `🕐 ${a.time}`)
  if (opts.price !== false && a.price) lines.push(`💵 ${a.price}`)
  for (const answer of a.answers ?? []) lines.push(`📝 ${answer.label}: ${answer.value}`)
  return lines.join('\n')
}

/**
 * Todo el copy del bot para las palabras de un negocio. El controlador
 * nunca redacta texto en línea: lo toma de aquí (o de los overrides
 * editables, ver bot-texts.ts). Frases neutras en género para que
 * sirvan con "cita", "turno", "sesión" o "reserva".
 */
export function buildAgentTexts(l: AgendaLabels) {
  return {
    // ----------------------------------------------------------
    // Arranque: menú de servicios
    // ----------------------------------------------------------
    serviceMenuBody: `¡Hola! 👋 Soy el asistente virtual. ¿Qué ${l.servicio} quieres agendar?`,
    serviceMenuButton: btn(`Ver ${l.servicios}`),
    /** Se agrega al pie cuando la lista se recortó a los primeros 10. */
    optionsTruncated: 'Te muestro las primeras opciones.',

    // ----------------------------------------------------------
    // Menú de profesionales
    // ----------------------------------------------------------
    staffMenuBody: `¿Con qué ${l.profesional} quieres tu ${l.cita}?`,
    staffMenuButton: btn(`Ver ${l.profesionales}`),
    staffAnyTitle: 'Cualquiera',
    staffAnyDescription: 'Te asignamos a quien esté disponible',

    // ----------------------------------------------------------
    // Días y horas
    // ----------------------------------------------------------
    dayMenuBody: '¿Qué día te queda bien?',
    dayMenuButton: 'Ver días',
    dayToday: 'Hoy',
    dayTomorrow: 'Mañana',

    slotMenuBody: (day: string) => `Horarios disponibles para ${day}:`,
    slotMenuButton: 'Ver horarios',

    // ----------------------------------------------------------
    // Preguntas extra
    // ----------------------------------------------------------
    answerMenuButton: 'Ver opciones',
    answerInvalidNumber: 'Escríbeme solo números, por favor.',
    answerTooLong: 'Esa respuesta es muy larga. Escríbela más corta, por favor.',
    answerRequired: 'Necesito esa respuesta para agendar. Escríbela, por favor.',

    // ----------------------------------------------------------
    // Resumen y confirmación
    // ----------------------------------------------------------
    summaryBody: (a: AgendaAppointmentSummary) =>
      `Así queda tu ${l.cita}:\n\n${summaryLines(a)}\n\n¿Confirmamos?`,
    summaryConfirm: 'Confirmar ✅',
    summaryReschedule: 'Reprogramar',
    summaryCancel: 'Cancelar',
    confirmed: (a: AgendaAppointmentSummary) =>
      `¡Listo! Quedó agendado:\n\n${summaryLines(a, { price: false })}\n\nTe esperamos 🙌. Si necesitas cambiar algo, escríbeme "${l.cita}".`,

    // ----------------------------------------------------------
    // Errores y recuperación
    // ----------------------------------------------------------
    retry: 'No entendí 😅. Por favor elige una de las opciones.',
    slotTaken: 'Uy, ese horario se ocupó mientras elegías 😅. Te muestro otras opciones:',
    dayTaken: 'Ese día se llenó mientras elegías 😅. Mira los días disponibles:',
    noDaysAvailable:
      'Por ahora no tengo horarios disponibles. Escríbeme "asesor" y un humano te ayuda a cuadrar.',
    noServices: `Aún no tengo ${l.servicios} para agendar. Escríbeme "asesor" y te ayudamos.`,
    noStaffForService: `Por ahora no hay ${l.profesionales} disponibles para eso. Elige otra opción, por favor:`,
    /** Falló una escritura crítica (agendar, confirmar o cancelar). */
    confirmError: `Uy, no pude completar ese cambio en tu ${l.cita} en este momento 😅. Intenta de nuevo o escríbeme "asesor".`,

    // ----------------------------------------------------------
    // Gestión de una cita existente
    // ----------------------------------------------------------
    manageMenuBody: (a: { service: string; date: string; time: string }) =>
      `Vi que ya tienes algo agendado:\n\n📌 ${a.service}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Qué quieres hacer?`,
    // Fijo y neutro en género: "Nueva turno" / "Nuevo cita" no existen.
    manageNew: 'Agendar otra vez',
    manageReschedule: 'Reprogramar',
    manageCancel: btn(`Cancelar ${l.cita}`),
    rescheduleStart: 'Listo, elige el nuevo día:',
    cancelConfirmBody: (a: { date: string; time: string }) =>
      `¿Seguro que quieres cancelar tu ${l.cita} del ${a.date} a las ${a.time}?`,
    cancelYes: 'Sí, cancelar',
    cancelNo: 'No, volver',
    cancelDone: `Listo, quedó cancelado. Cuando quieras agendar de nuevo, escríbeme "${l.cita}". 🙌`,
    cancelDeclined: 'Perfecto, lo dejo como está. ¡Te esperamos! 🙌',
    rescheduleDone: (a: AgendaAppointmentSummary) =>
      `¡Listo! Quedó reprogramado.\n\n${summaryLines(a, { price: false })}\n\n¡Te esperamos! 🙌`,
    /** La cita gestionada ya no existe o ya no está activa. */
    managedAppointmentGone: `Veo que eso ya no está activo. Escríbeme "${l.cita}" para agendar de nuevo.`,
    /** Se abandonó un borrador de cita nueva desde el resumen. */
    draftCancelled: `Listo, no agendé nada. Cuando quieras, escríbeme "${l.cita}". 🙌`,
    /** Catálogo cambiado: el servicio de la cita ya no existe. */
    serviceFallback: `tu ${l.servicio}`,
    /** Pieza "reprogramar/cancelar" apagada: lo atiende una persona. */
    changesByHuman:
      'Para cambiar o cancelar, te ayuda un asesor por este chat. Ya le avisé; mientras tanto todo sigue igual. 🙌',

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
      `¡Hola! 👋 Te recordamos tu ${l.cita} en ${a.business}:\n\n📌 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¿Nos confirmas?`,
    reminderConfirm: 'Confirmar',
    reminderReschedule: 'Reprogramar',
    reminderCancel: 'Cancelar',
    reminderConfirmed: (a: { service: string; staff: string; date: string; time: string }) =>
      `¡Listo! Queda confirmado:\n\n📌 ${a.service}\n👤 ${a.staff}\n📅 ${a.date}\n🕐 ${a.time}\n\n¡Te esperamos! 🙌`,

    // ----------------------------------------------------------
    // Handoff a un humano
    // ----------------------------------------------------------
    handoff:
      'Entiendo. Dejo tu conversación con un asesor humano para que te ayude. En breve te contactan. 🙌',
    handoffNote: 'El cliente pidió hablar con una persona desde el flujo de la agenda (bot en pausa).',
    /** D1: "Reprogramar" del recordatorio con un humano a cargo del chat. */
    rescheduleHandedToHuman:
      'Listo, le avisé a un asesor para que te ayude a reprogramar. Te escribe por este chat; mientras tanto todo sigue igual. 🙌',
    rescheduleRequestNotificationTitle: 'Cliente quiere reprogramar (Agenda)',
    rescheduleRequestNotificationBody: (a: { who: string; date: string; time: string }) =>
      `${a.who} tocó "Reprogramar" en el recordatorio de su ${l.cita} del ${a.date} a las ${a.time}. Respóndele por este chat.`,
    handoffNotificationTitle: 'Cliente pide un asesor (Agenda)',
    handoffNotificationBody: (name: string) =>
      `${name} pidió hablar con una persona desde el flujo de ${l.citas}.`,
    /** Pieza "reprogramar/cancelar" apagada: el cliente quiere cambiar su cita. */
    changeRequestNote: `El cliente quiere cambiar o cancelar su ${l.cita} y esa opción está apagada (bot en pausa).`,
    changeRequestNotificationTitle: 'Cliente quiere cambiar su cita (Agenda)',
    changeRequestNotificationBody: (a: {
      who: string
      action: 'reschedule' | 'cancel'
      date: string
      time: string
    }) =>
      `${a.who} quiere ${a.action === 'cancel' ? 'cancelar' : 'reprogramar'} su ${l.cita} del ${a.date} a las ${a.time}. Respóndele por este chat.`,
  }
}

export type AgendaAgentTexts = ReturnType<typeof buildAgentTexts>

/** Copy con las palabras por defecto (tests y lugares sin cuenta). */
export const AGENDA_AGENT_TEXTS: AgendaAgentTexts = buildAgentTexts(DEFAULT_LABELS)
