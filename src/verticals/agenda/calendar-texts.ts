// ============================================================
// Textos del calendario del panel (/agenda/calendario) — español de
// Colombia, en palabras simples.
//
// Donde la pantalla nombra a quien atiende o lo que se agenda, usa las
// palabras del negocio (AgendaLabels) y nunca les pone artículo delante:
// el género cambia ("la cita", "el turno", "la sesión").
//
// Van aparte de AGENDA_TEXTS para no mezclar el calendario con la
// configuración y el bot. Sin rayas largas ni símbolos raros: la
// pantalla muestra estos textos tal cual.
// ============================================================

import { capitalize, type AgendaLabels } from './labels'

export const CALENDAR_TEXTS = {
  title: 'Calendario',
  subtitle: (l: AgendaLabels) => `Todas las ${l.citas} del equipo, por día y por semana.`,
  backToAgenda: 'Agenda de hoy',
  viewCalendar: 'Ver calendario',

  // Barra de herramientas
  prev: (view: 'day' | 'week') => (view === 'day' ? 'Día anterior' : 'Semana anterior'),
  next: (view: 'day' | 'week') => (view === 'day' ? 'Día siguiente' : 'Semana siguiente'),
  today: 'Hoy',
  goToDay: 'Ir a un día',
  viewDay: 'Día',
  viewWeek: 'Semana',
  viewSwitch: 'Cambiar la vista',
  staffFilter: (l: AgendaLabels) => capitalize(l.profesional),
  allStaff: (l: AgendaLabels) => `Todos los ${l.profesionales}`,
  showCancelled: 'Mostrar canceladas',
  newAppointment: (l: AgendaLabels) => `Nueva ${l.cita}`,
  newAppointmentGate: (l: AgendaLabels) => `crear ${l.citas}`,

  // Cuadrícula
  gridLabel: (l: AgendaLabels) => `Calendario de ${l.citas}`,
  countOf: (n: number, l: AgendaLabels) => (n === 1 ? `1 ${l.cita}` : `${n} ${l.citas}`),
  noAppointmentsDay: (l: AgendaLabels) => `Sin ${l.citas}`,
  noStaff: (l: AgendaLabels) =>
    `Todavía no hay ${l.profesionales} activos. Agrégalos en Configuración para ver el calendario.`,
  loading: 'Cargando el calendario…',
  loadError: 'No se pudo cargar el calendario. Revisa tu conexión e inténtalo de nuevo.',
  migrationMissing: 'Falta actualizar la base de datos. Avísale a Shift.',
  retry: 'Reintentar',
  goToConfig: 'Ir a Configuración',
  freeSlot: (time: string) => `Agendar a las ${time}`,
  timeOff: 'Bloqueado',
  timeOffWithReason: (reason: string) => `Bloqueado: ${reason}`,
  outsideHours: 'Fuera de horario',
  now: 'Ahora',
  emptyWeekDay: (l: AgendaLabels) => `Sin ${l.citas} este día`,
  openDay: (label: string) => `Ver el día ${label}`,
  noService: 'Servicio eliminado',
  noStaffAssigned: 'Sin asignar',
  noName: 'Sin nombre',

  // Estados de la cita: sin género, para que sirvan con cualquier palabra.
  status: {
    pending: 'Pendiente',
    confirmed: 'Confirmada',
    completed: 'Atendida',
    no_show: 'No vino',
    cancelled: 'Cancelada',
  },
  patientConfirmed: 'Confirmó que va',
  appointmentAria: (args: { who: string; time: string; status: string; extra?: string }) =>
    `${args.who}, ${args.time}, ${args.status}${args.extra ? `, ${args.extra}` : ''}`,

  // Nueva cita
  newDialog: {
    title: (l: AgendaLabels) => `Nueva ${l.cita}`,
    description: 'Se guarda con las mismas reglas del bot: sin choques y dentro del horario de quien atiende.',
    contactSection: 'Contacto',
    contactSearch: 'Buscar por nombre o celular',
    contactSearchPlaceholder: 'Escribe al menos 2 letras o 3 números',
    contactSearching: 'Buscando…',
    contactNoResults: 'No encontramos a nadie con eso.',
    contactSearchFailed: 'No se pudo buscar. Inténtalo de nuevo.',
    contactNew: 'Contacto nuevo',
    contactExisting: 'Buscar un contacto',
    contactChange: 'Cambiar',
    contactName: 'Nombre',
    contactNameRequired: 'Escribe el nombre del contacto.',
    contactPhone: 'Celular de WhatsApp',
    contactPhoneHint: 'Con el indicativo del país, por ejemplo +57 300 123 4567.',
    contactPhoneInvalid: 'El celular debe llevar el indicativo del país con +, por ejemplo +573001234567.',
    contactRequired: 'Elige un contacto o escribe uno nuevo.',
    patientSection: 'Paciente',
    patientExisting: 'Pacientes de este contacto',
    patientsLoading: 'Buscando los pacientes de este contacto…',
    patientOther: 'Otro paciente',
    patientName: 'Nombre del paciente',
    patientNameHint: 'Quien va a la consulta. Puede ser distinto de quien escribe por WhatsApp.',
    patientNameRequired: 'Escribe el nombre del paciente.',
    serviceSection: (l: AgendaLabels) => capitalize(l.servicio),
    servicePlaceholder: (l: AgendaLabels) => `Elige el ${l.servicio}`,
    serviceRequired: (l: AgendaLabels) => `Elige el ${l.servicio}.`,
    staffSection: (l: AgendaLabels) => capitalize(l.profesional),
    staffAny: 'Cualquiera disponible',
    staffPlaceholder: 'Elige quién atiende para poder escribir otra hora.',
    staffNone: (l: AgendaLabels) => `Ningún ${l.profesional} atiende eso.`,
    dayLabel: 'Día',
    timeLabel: 'Hora',
    pickServiceFirst: (l: AgendaLabels) => `Elige primero el ${l.servicio} para ver las horas libres.`,
    slotsLoading: 'Buscando horas libres…',
    slotsEmpty: 'No hay horas libres ese día. Prueba otro día o escribe otra hora.',
    slotsFailed: 'No se pudieron cargar las horas libres. Puedes escribir la hora a mano.',
    otherTime: 'Otra hora',
    otherTimeHint: 'Si queda fuera del horario te lo avisamos antes de guardar.',
    timeRequired: 'Elige la hora.',
    dayRequired: 'Elige el día.',
    notify: 'Avisar por WhatsApp',
    notifyHint: 'Le llega un mensaje con el día y la hora.',
    save: 'Guardar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    outsideTitle: (staff: string) => `Está fuera del horario de ${staff}`,
    outsideBody: '¿Agendar igual? Quedará guardada a esa hora.',
    outsideConfirm: 'Sí, agendar igual',
    outsideBack: 'Elegir otra hora',
    saved: (l: AgendaLabels) => `${capitalize(l.cita)} guardada`,
    savedNotifyFailed: 'La cita quedó guardada, pero no se pudo avisar por WhatsApp.',
    saveFailed: 'No se pudo guardar. Inténtalo de nuevo.',
  },

  // Detalle de la cita
  detail: {
    title: (l: AgendaLabels) => `Detalle de la ${l.cita}`,
    when: 'Cuándo',
    who: 'Contacto',
    patient: 'Paciente',
    service: (l: AgendaLabels) => capitalize(l.servicio),
    staff: (l: AgendaLabels) => capitalize(l.profesional),
    state: 'Estado',
    phone: 'Celular',
    move: 'Mover',
    cancel: (l: AgendaLabels) => `Cancelar ${l.cita}`,
    complete: 'Atendida',
    noShow: 'No vino',
    openConversation: 'Abrir conversación',
    close: 'Cerrar',
    readOnly: 'Tu rol solo puede ver el calendario.',
    cannotMovePast: 'Ya pasó, así que no se puede mover.',
    closedState: (status: string) => `Esta cita está marcada como ${status.toLowerCase()} y ya no se puede cambiar.`,
    changing: 'Actualizando…',
    statusFailed: 'No se pudo actualizar. Recarga e inténtalo de nuevo.',
    pastTitle: 'Ya pasó',
    pastBody: 'Estaba programada para otra hora y ya pasó. ¿Seguro que quieres cambiar su estado?',
    pastConfirm: 'Sí, cambiar',
    pastBack: 'Volver',
    statusDone: 'Estado actualizado',
  },

  // Mover
  move: {
    title: (l: AgendaLabels) => `Mover ${l.cita}`,
    description: (summary: string) => summary,
    day: 'Nuevo día',
    time: 'Nueva hora',
    staff: (l: AgendaLabels) => `${capitalize(l.profesional)}`,
    notify: 'Avisar por WhatsApp',
    notifyHint: 'Le llega la nueva hora. Los recordatorios salen de nuevo para esa hora.',
    save: 'Mover',
    saving: 'Moviendo…',
    back: 'Volver',
    done: (l: AgendaLabels) => `${capitalize(l.cita)} movida`,
    failed: 'No se pudo mover. Inténtalo de nuevo.',
    sameTime: 'Elige una hora distinta a la de ahora.',
  },

  // Cancelar
  cancel: {
    title: (l: AgendaLabels) => `¿Cancelar ${l.cita}?`,
    description: (summary: string) =>
      `${summary.endsWith('.') ? summary : `${summary}.`} Después no se puede volver a cambiar su estado.`,
    reason: 'Motivo (opcional)',
    reasonHint: 'Solo lo ves tú. No se le envía al paciente.',
    reasonPlaceholder: 'Por ejemplo: el paciente pidió cancelar',
    notify: 'Avisar por WhatsApp',
    notifyHint: 'Le llega un mensaje con un botón para agendar otra.',
    confirm: (l: AgendaLabels) => `Sí, cancelar ${l.cita}`,
    back: 'Volver',
    saving: 'Cancelando…',
    done: (l: AgendaLabels) => `${capitalize(l.cita)} cancelada`,
    failed: 'No se pudo cancelar. Inténtalo de nuevo.',
    // La hora ya pasó: cancelar pide un "sí" aparte (sin género, sirve con cualquier palabra).
    pastTitle: 'Ya pasó',
    pastBody: 'Ya pasó la hora programada. ¿Cancelar igual?',
    pastConfirm: 'Sí, cancelar igual',
    pastBack: 'Volver',
  },

  doneNotifyFailed: 'El cambio quedó guardado, pero no se pudo avisar por WhatsApp.',
  stale: 'Alguien cambió esto mientras lo editabas. Recarga e intenta de nuevo.',
} as const
