// ============================================================
// Textos de la superficie de la agenda — español colombiano.
//
// Por decisión de producto, el vertical NO entra a los catálogos
// i18n del CRM (messages/*.json): su superficie es solo es-CO y su
// copy vive aquí, junto al manifest y las semillas.
//
// El panel no escribe a mano "barbero" ni "cita": donde la pantalla
// nombra a quien atiende o lo que se agenda, la entrada es una función
// de las palabras del negocio (labels). Junto a esas palabras se evitan
// artículos y adjetivos, porque el género cambia ("la cita", "el
// turno", "la sesión").
// ============================================================

import { truncate } from './agent/format'
import { DEFAULT_LABELS, LABEL_MAX, capitalize, type AgendaLabels } from './labels'
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, QUESTION_LABEL_MAX } from './questions'

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
  title: 'Agenda',
  subtitle: 'Tus servicios, tu equipo y tus horarios.',
  loading: 'Cargando…',
  /** Tooltip de lo que un rol de solo lectura no puede hacer. */
  readOnly: (action: string) => `Solo lectura: tu rol no puede ${action}.`,
  notEnabledTitle: 'Módulo no habilitado',
  notEnabledBody:
    'El módulo de agenda no está activo para esta cuenta. Pídele a tu asesor de Shift Digital que lo active.',
  loadError:
    'No se pudo cargar la información. Recarga la página e inténtalo de nuevo.',
  /** La base no tiene las columnas/tablas nuevas (migración 051 sin aplicar). */
  migrationMissing:
    'Falta actualizar la base de datos (migración 051). Avísale a Shift.',

  statusTitle: 'Estado de la plantilla',
  statusInstalled: 'Instalada',
  statusNotInstalled: 'Sin instalar',
  statusInstalledBody:
    'La plantilla está instalada. Reinstalar es seguro: no duplica ni sobrescribe lo que ya editaste.',
  statusNotInstalledBody:
    'Aún no has elegido tu tipo de negocio. Con tu elección creamos servicios de ejemplo, un horario, etiquetas, un embudo, respuestas rápidas y documentos para tu agente de IA.',
  reinstallButton: 'Reinstalar plantilla',
  installing: 'Instalando…',
  gateReason: 'instalar la plantilla',
  installFailed: 'No se pudo completar la instalación. Inténtalo de nuevo.',

  // ----------------------------------------------------------
  // Asistente de arranque (cuenta sin plantilla)
  // ----------------------------------------------------------
  wizard: {
    title: 'Elige tu tipo de negocio',
    hint: 'Es solo un punto de partida: crea servicios, un horario y respuestas de ejemplo y ajusta las palabras del bot. Después editas todo en Configuración.',
    choose: 'Usar este tipo',
    installingNamed: (name: string) => `Preparando tu agenda de "${name}"…`,
    viewerGate: 'elegir el tipo de negocio',
    readOnlyNote:
      'Solo el dueño o un administrador puede elegir el tipo de negocio.',
    doneTitle: 'Tu agenda está lista',
    doneBody:
      'Revisa los servicios, el equipo y el horario de ejemplo en Configuración y ajústalos a tu negocio.',
    goToConfig: 'Ir a Configuración',
  },

  reportTitle: 'Resultado de la instalación',
  createdLabel: 'creados',
  skippedLabel: 'ya existían',
  pipelineCreated: (stages: number) =>
    `Embudo de la agenda creado con ${stages} etapas`,
  pipelineSkipped: 'El embudo de la agenda ya existía',
  aiPromptWritten: 'Prompt creado (estaba vacío)',
  aiPromptAlreadySet: 'Prompt ya configurado; no se modificó',
  aiPromptNoConfig: 'Aún sin configurar',
  promptSuggestionTitle: 'Prompt sugerido para tu agente de IA',
  promptSuggestionHint:
    'Cópialo en Agentes de IA cuando conectes tu proveedor; no sobrescribimos nada.',

  servicesTitle: (l: AgendaLabels) => capitalize(l.servicios),
  servicesEmpty: (l: AgendaLabels) =>
    `Aún no hay ${l.servicios}. Elige un tipo de negocio o créalos a tu medida.`,
  staffTitle: (l: AgendaLabels) => capitalize(l.profesionales),
  staffEmpty: (l: AgendaLabels) => `Aún no hay ${l.profesionales} en el equipo.`,
  inactiveLabel: 'Inactivo',
  servicesCount: (n: number, l: AgendaLabels) =>
    n === 1 ? `1 ${l.servicio}` : `${n} ${l.servicios}`,
  staffCount: (n: number, l: AgendaLabels) =>
    n === 1 ? `1 ${l.profesional}` : `${n} ${l.profesionales}`,
  minutes: (n: number) => `${n} min`,

  // ----------------------------------------------------------
  // Agenda del día
  // ----------------------------------------------------------
  agendaTitle: 'Agenda de hoy',
  agendaEmpty: (l: AgendaLabels) => `No hay ${l.citas} para hoy.`,
  agendaServiceGone: 'Servicio eliminado',
  agendaStaffGone: 'Sin asignar',
  agendaContactFallback: 'Sin nombre',
  agendaStatusPending: 'Pendiente',
  // Formas sin género ("estado: confirmado"): no sabemos si la palabra del
  // negocio es "cita", "turno" o "sesión".
  agendaStatusConfirmed: 'Confirmado',
  agendaStatusCompleted: 'Completado',
  agendaStatusNoShow: 'No asistió',
  agendaStatusCancelled: 'Cancelado',
  /** "8 citas" / "1 turno" junto a la fecha de hoy. */
  agendaCount: (n: number, l: AgendaLabels) =>
    n === 1 ? `1 ${l.cita}` : `${n} ${l.citas}`,
  // Sin género: cada negocio llama distinto a la cita ("turno", "reserva").
  agendaActionComplete: 'Asistió',
  agendaActionMore: 'Más',
  agendaActionMoreLabel: 'Más acciones',
  agendaActionNoShow: 'No asistió',
  agendaActionCancel: (l: AgendaLabels) => `Cancelar ${l.cita}`,
  agendaCancelTitle: (l: AgendaLabels) => `¿Cancelar ${l.cita}?`,
  agendaCancelBody: (summary: string) =>
    `${summary}. Después no se puede volver a cambiar su estado. Al cliente no se le envía ningún mensaje.`,
  agendaCancelConfirm: (l: AgendaLabels) => `Sí, cancelar ${l.cita}`,
  agendaCancelBack: 'Volver',
  agendaChangeFailed:
    'No se pudo actualizar. Recarga la agenda e inténtalo de nuevo.',
  agendaPastTitle: 'Ya pasó',
  agendaPastBody: (date: string, time: string) =>
    `Estaba programado para el ${date} a las ${time} y ya pasó. ¿Seguro que quieres cambiar su estado?`,
  agendaPastConfirm: 'Sí, cambiar',
  agendaPastBack: 'Volver',

  // ----------------------------------------------------------
  // Recordatorios (Fase 3)
  // ----------------------------------------------------------
  remindersTitle: 'Recordatorios',
  /** Resumen en una línea de las dos señales (ver Configuración > Piezas). */
  remindersSummary: (on: boolean, twoHour: boolean) =>
    on
      ? `24 h antes: activo. 2 h antes: ${twoHour ? 'activo' : 'apagado'}.`
      : 'Recordatorios apagados.',
  remindersConfigLink: 'Cambiar en Configuración',
  remindersPendingTitle: 'Por enviar',
  remindersSentTitle: 'Enviados',
  remindersEmpty: 'Nada por enviar ni enviado en este momento.',
  remindersPending24h: 'Pendiente 24 h',
  remindersPending2h: 'Pendiente 2 h',
  remindersSent24h: 'Enviado 24 h',
  remindersSent2h: 'Enviado 2 h',
  remindersSentAt: (date: string, time: string) => `enviado el ${date} a las ${time}`,
  remindersLoadFailed:
    'No se pudieron cargar los recordatorios. Recarga la página e inténtalo de nuevo.',

  sections: {
    services: (l: AgendaLabels) => capitalize(l.servicios),
    staff: (l: AgendaLabels) => capitalize(l.profesionales),
    staffServices: (l: AgendaLabels) =>
      `${capitalize(l.servicios)} de cada ${l.profesional}`,
    workingHours: 'Bloques de horario',
    tags: 'Etiquetas',
    customFields: 'Campos personalizados',
    quickReplies: 'Respuestas rápidas',
    knowledge: 'Documentos de conocimiento',
    questions: 'Preguntas extra',
    aiAgent: 'Agente de IA',
    pipeline: 'Embudo',
  },

  // ----------------------------------------------------------
  // Configuración (Fase 4) — /agenda/configuracion
  // ----------------------------------------------------------
  config: {
    title: 'Configuración',
    subtitle:
      'Administra tu negocio, tus servicios, tu equipo y los textos del bot.',
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

    // Las pestañas de servicios y equipo toman el nombre de las palabras del
    // negocio (ver la página); estos son los valores por si faltan.
    tabs: {
      business: 'Negocio',
      type: 'Tipo de negocio',
      services: 'Servicios',
      staff: 'Equipo',
      schedule: 'Horarios',
      timeOff: 'Bloqueos',
      pieces: 'Piezas',
      questions: 'Preguntas',
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
      timezoneHint: 'Todo se agenda y se muestra en hora de Bogotá.',
      currency: 'Moneda',
      currencyHint: 'Se usa para mostrar el precio de los servicios.',
      save: 'Guardar datos del negocio',
    },

    // ----------------------------------------------------------
    // Pestaña "Tipo de negocio"
    // ----------------------------------------------------------
    type: {
      title: 'Tipo de negocio',
      hint: 'Elige el punto de partida que más se parezca a tu negocio. Cambia las palabras que usa el bot y cómo se muestran los servicios, y agrega ejemplos para arrancar.',
      current: 'Actual',
      wordsTitle: 'Palabras de tu negocio',
      wordsHint:
        'Así llama tu negocio a cada cosa, en el bot y en el panel. Deja una palabra vacía para usar la de por defecto.',
      words: {
        profesional: 'Quien atiende (singular)',
        profesionales: 'Quien atiende (plural)',
        servicio: 'Lo que se agenda (singular)',
        servicios: 'Lo que se agenda (plural)',
        cita: 'La reserva (singular)',
        citas: 'La reserva (plural)',
      } satisfies Record<keyof AgendaLabels, string>,
      wordsDefaultNote: 'Por defecto:',
      saveWords: 'Guardar palabras',
      wordTooLong: (word: string) =>
        `"${word}" no puede pasar de ${LABEL_MAX} caracteres.`,
      wordInvalid: (word: string) =>
        `"${word}" tiene caracteres no permitidos (por ejemplo * _ ~ o comillas invertidas).`,
      confirmTitle: (name: string) => `¿Usar "${name}" como tipo de negocio?`,
      confirmBody: (l: AgendaLabels) =>
        `Se aplican las palabras y cómo se muestran los servicios (quién atiende, precios, duración). Se agregan los servicios, el horario de ejemplo y las preguntas que aún no tengas. Tus ${l.citas}, servicios, equipo y preguntas actuales se quedan activos: desactiva lo que no uses. La bienvenida solo cambia si no la personalizaste.`,
      sameTitle: (name: string) => `Ya usas "${name}"`,
      sameBody:
        'Ya usas este tipo de negocio. Volver a aplicarlo no cambia tus servicios ni tu equipo: solo rellena las etiquetas, el embudo, las respuestas rápidas y los documentos que falten.',
      cancel: 'Cancelar',
      apply: 'Sí, usar este tipo',
      reapply: 'Volver a aplicar',
      applied: (name: string) =>
        `Listo: ahora usas "${name}". Revisa los servicios, el equipo y las preguntas en las otras pestañas.`,
      viewerGate: 'cambiar el tipo de negocio',
    },

    // ----------------------------------------------------------
    // Pestaña "Piezas"
    // ----------------------------------------------------------
    pieces: {
      title: 'Piezas',
      hint: 'Prende solo lo que tu negocio usa. El bot salta los pasos que apagues.',
      on: 'Prendida',
      off: 'Apagada',
      items: {
        chooseStaff: {
          title: 'Elegir quién atiende',
          hint: (l: AgendaLabels) =>
            `Apagado: el bot no pregunta "¿con qué ${l.profesional}?" y asigna a quien esté libre.`,
        },
        showPrice: {
          title: 'Mostrar precios',
          hint: () => 'Apagado: el bot no muestra el precio en el menú, el resumen ni la confirmación.',
        },
        showDuration: {
          title: 'Mostrar duración',
          hint: () => 'Apagado: el menú de servicios del bot no muestra los minutos.',
        },
        remindersEnabled: {
          title: 'Recordatorios',
          hint: (l: AgendaLabels) =>
            `Mensaje automático antes de cada ${l.cita}: 24 horas antes y, si lo activas en "Bot y recordatorios", 2 horas antes.`,
        },
        allowReschedule: {
          title: 'Reprogramar y cancelar',
          hint: (l: AgendaLabels) =>
            `Apagado: si el cliente quiere cambiar o cancelar su ${l.cita}, el bot avisa a una persona del equipo para que lo atienda por el chat.`,
        },
      },
    },

    // ----------------------------------------------------------
    // Pestaña "Preguntas"
    // ----------------------------------------------------------
    questions: {
      title: 'Preguntas extra',
      hint: (l: AgendaLabels) =>
        `El bot las hace después de elegir la hora y antes de confirmar tu ${l.cita}. Máximo ${MAX_QUESTIONS}.`,
      count: (n: number) => `${n} de ${MAX_QUESTIONS}`,
      remaining: (n: number) =>
        n === 0
          ? 'Ya llegaste al máximo de preguntas.'
          : n === 1
            ? 'Puedes agregar 1 pregunta más.'
            : `Puedes agregar ${n} preguntas más.`,
      empty: 'Sin preguntas extra: el bot pasa directo al resumen.',
      addTitle: 'Agregar pregunta',
      editTitle: 'Editar pregunta',
      label: 'Pregunta',
      labelPlaceholder: 'Ej.: ¿Cuál es la placa de tu carro?',
      labelHint: (n: number) => `${n} de ${QUESTION_LABEL_MAX} caracteres`,
      kind: 'Tipo de respuesta',
      kinds: {
        texto: 'Texto libre',
        direccion: 'Dirección',
        numero: 'Número',
        opcion: 'Opciones',
      },
      required: 'Obligatoria',
      optional: 'Opcional',
      requiredHint: 'Si no es obligatoria, el cliente puede omitirla.',
      options: 'Opciones (una por línea)',
      optionsPlaceholder: 'Norte\nSur',
      optionsHint: `Entre ${MIN_OPTIONS} y ${MAX_OPTIONS} opciones. Con 3 o menos, el bot las muestra como botones (hasta 20 caracteres cada una); con más, como una lista (hasta 24). No pueden repetirse ni ser solo números.`,
      save: 'Guardar pregunta',
      saveEdit: 'Guardar cambios',
      cancel: 'Cancelar',
      edit: 'Editar',
      remove: 'Quitar',
      removeTitle: 'Quitar pregunta',
      removeBody:
        'El bot dejará de hacerla. Las respuestas que ya dieron tus clientes se conservan.',
      removeYes: 'Sí, quitar',
      viewerGate: 'editar las preguntas',
    },

    reminders: {
      title: (l: AgendaLabels) => `Recordatorios de ${l.citas}`,
      alwaysTitle: 'Recordatorio 24 h antes',
      alwaysBody: (l: AgendaLabels) =>
        `Activo mientras la pieza Recordatorios esté prendida: cada ${l.cita} recibe un recordatorio el día anterior.`,
      offBody:
        'Apagado: prende la pieza Recordatorios en la pestaña Piezas para que se envíen.',
      twoHourTitle: 'Segunda señal 2 h antes',
      twoHourBody: (l: AgendaLabels) =>
        `Envía un recordatorio adicional dos horas antes de cada ${l.cita}.`,
      twoHourOffHint:
        'Está en pausa porque la pieza Recordatorios está apagada (pestaña Piezas).',
      badgeOff: 'Apagado',
    },

    services: {
      title: (l: AgendaLabels) => capitalize(l.servicios),
      empty: (l: AgendaLabels) =>
        `Aún no hay ${l.servicios}. Usa "Agregar ${l.servicio}" para que el bot tenga qué ofrecer.`,
      add: (l: AgendaLabels) => `Agregar ${l.servicio}`,
      createTitle: (l: AgendaLabels) => `Agregar ${l.servicio}`,
      editTitle: (l: AgendaLabels) => `Editar ${l.servicio}`,
      name: 'Nombre',
      description: 'Descripción',
      descriptionPlaceholder: 'Qué incluye y para quién es',
      duration: 'Duración (minutos)',
      price: 'Precio',
      active: 'Activo',
      inactive: 'Inactivo',
      activeHint:
        'Lo inactivo deja de ofrecerse en nuevas reservas; lo ya agendado no se modifica.',
      moveUp: 'Subir',
      moveDown: 'Bajar',
      save: 'Guardar',
    },

    staff: {
      title: (l: AgendaLabels) => capitalize(l.profesionales),
      empty: (l: AgendaLabels) =>
        `Aún no hay ${l.profesionales}. Crea el equipo para asignarles horarios y servicios.`,
      add: (l: AgendaLabels) => `Agregar ${l.profesional}`,
      createTitle: (l: AgendaLabels) => `Agregar ${l.profesional}`,
      editTitle: (l: AgendaLabels) => `Editar ${l.profesional}`,
      name: 'Nombre',
      bio: 'Descripción',
      bioPlaceholder: 'Qué hace y en qué se especializa',
      bioHint: 'Descripción corta (opcional).',
      active: 'Activo',
      inactive: 'Inactivo',
      servicesTitle: (l: AgendaLabels) => `${capitalize(l.servicios)} que atiende`,
      servicesHint:
        'Solo se ofrecerá para lo que marques aquí. La opción "Cualquiera" asigna a quien esté disponible.',
      noServicesAvailable: (l: AgendaLabels) =>
        `Todavía no hay ${l.servicios} para elegir. Agrega en la pestaña ${capitalize(l.servicios)}.`,
      save: 'Guardar',
    },

    schedule: {
      title: 'Horario semanal',
      subtitle: (l: AgendaLabels) =>
        `Define cuándo acepta ${l.citas} cada integrante del equipo. Los cambios aplican de inmediato a nuevas reservas; lo que ya está confirmado no se toca.`,
      pickStaff: (l: AgendaLabels) => capitalize(l.profesional),
      pickStaffEmpty: () =>
        'Crea primero a alguien del equipo para configurar su horario.',
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
      pickStaff: (l: AgendaLabels) => capitalize(l.profesional),
      pickStaffEmpty: () =>
        'Crea primero a alguien del equipo para programar bloqueos.',
      from: 'Desde',
      to: 'Hasta',
      reason: 'Motivo',
      reasonPlaceholder: 'Vacaciones, diligencia personal…',
      add: 'Agregar bloqueo',
      empty: 'No hay bloqueos programados.',
      upcoming: 'Próximos bloqueos',
      delete: 'Eliminar',
      deleteTitle: 'Eliminar bloqueo',
      deleteBody:
        '¿Seguro que quieres eliminar este bloqueo? Esa persona vuelve a estar disponible en ese rango.',
      deleteYes: 'Sí, eliminar',
      deleteNo: 'Cancelar',
      past: 'Pasado',
    },

    bot: {
      title: 'Textos del bot',
      hint: 'Personaliza los mensajes del flujo de reservas. Deja un campo vacío para usar el texto por defecto. Los mensajes con datos de lo agendado (resumen, confirmación, recordatorio) no se editan aquí.',
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
        welcome: (l: AgendaLabels) =>
          `Primer mensaje cuando el cliente escribe "hola" o "${l.cita}".`,
        retry: () =>
          'Cuando la respuesta no coincide con el menú (se reenvía el menú).',
        noServices: () => 'Cuando el catálogo no tiene servicios activos.',
        noDaysAvailable: () =>
          'Cuando no hay horarios libres en los próximos días.',
        handoff: () => 'Cuando el cliente pide hablar con una persona.',
      } satisfies Record<EditableBotTextKey, (l: AgendaLabels) => string>,
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
  /** Cuántas respuestas no caben en el mensaje (se avisa con una línea). */
  moreAnswers?: number
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
  for (const answer of a.answers ?? []) {
    // Una pregunta que ya termina en "?" no lleva dos puntos.
    const sep = answer.label.endsWith('?') ? ' ' : ': '
    lines.push(`📝 ${answer.label}${sep}${answer.value}`)
  }
  if (a.moreAnswers) {
    lines.push(`📝 +${a.moreAnswers} ${a.moreAnswers === 1 ? 'respuesta más' : 'respuestas más'}`)
  }
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
    /** Línea que se agrega a una pregunta NO obligatoria que se responde escribiendo. */
    answerOptionalHint: '(Opcional: si no aplica, escribe "omitir".)',
    /** Ídem, cuando la pregunta de opciones trae el botón/fila "Omitir". */
    answerOptionalHintOptions: '(Opcional: toca "Omitir" o escríbelo.)',
    /** Reintento cuando se esperaba una respuesta escrita (no hay opciones que elegir). */
    answerRetryText: 'No entendí tu respuesta 😅. Escríbela, por favor.',
    /** Opción extra de una pregunta de opciones NO obligatoria (cabe en un botón). */
    answerSkip: 'Omitir',
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
    /** Pieza "reprogramar/cancelar" apagada: solo se puede agendar otra vez. */
    manageMenuBodyNoChanges: (a: { service: string; date: string; time: string }) =>
      `Vi que ya tienes algo agendado:\n\n📌 ${a.service}\n📅 ${a.date}\n🕐 ${a.time}\n\nPara cambiar o cancelar tu ${l.cita}, escríbeme "asesor" y te ayuda una persona. ¿O quieres agendar otra vez?`,
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
      `Para cambiar o cancelar tu ${l.cita} te ayuda un asesor por este chat. Ya le avisé; mientras tanto tu ${l.cita} sigue igual. 🙌`,

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
    /** La reprogramación no se pudo deshacer: la agenda puede quedar con dos citas. */
    rescheduleBroken: `Uy, tu ${l.cita} quedó en revisión y no alcancé a dejarla como estaba 😅. Ya avisé al equipo para que lo arreglen por este chat; no necesitas hacer nada más. 🙏`,
    rescheduleBrokenNotificationTitle: 'Reprogramación a medias (Agenda)',
    rescheduleBrokenNotificationBody: (a: { who: string }) =>
      `${a.who} intentó reprogramar y el cambio no se pudo deshacer: puede tener dos ${l.citas} a su nombre. Revísalo en la agenda y respóndele por este chat.`,
    rescheduleBrokenNote: `La reprogramación desde el bot quedó a medias (cambio sin deshacer): revisar si quedaron dos ${l.citas}. Bot en pausa en este hilo.`,
    handoffNotificationTitle: 'Cliente pide un asesor (Agenda)',
    handoffNotificationBody: (name: string) =>
      `${name} pidió hablar con una persona desde el flujo de ${l.citas}.`,
    /** Pieza "reprogramar/cancelar" apagada: el cliente quiere cambiar su cita. */
    changeRequestNote: (a: { action: 'reschedule' | 'cancel'; date: string; time: string }) =>
      `El cliente quiere ${a.action === 'cancel' ? 'cancelar' : 'reprogramar'} su ${l.cita} del ${a.date} a las ${a.time}, pero esa opción está apagada (bot en pausa).`,
    changeRequestNotificationTitle: `Cliente quiere cambiar su ${l.cita} (Agenda)`,
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
