// ============================================================
// Textos de la tarjeta "Llamadas" de Configuración.
//
// Viven aparte de `verticals/agenda/texts.ts` (igual que los de Google
// Calendar). Español sencillo, sin guiones largos y sin tecnicismos.
// ============================================================

export const CALLS_TEXTS = {
  title: 'Llamadas',
  description: 'Un asistente de voz confirma tus citas por teléfono y contesta las llamadas que entran.',

  statusActive: 'Prendidas',
  statusOff: 'Apagadas',
  statusPending: 'Pendiente de Shift',

  costNotice:
    'Las llamadas tienen costo por minuto. Las salientes solo salen de lunes a sábado en tu ventana y nunca en festivos.',
  telnyxMissing:
    'Falta un paso de Shift para activar las llamadas en este servidor. Puedes guardar tu configuración, pero no prenderlas todavía.',

  loading: 'Cargando las llamadas...',
  loadFailed: 'No pudimos cargar la configuración de llamadas.',
  retry: 'Reintentar',

  // Interruptores
  outboundTitle: 'Llamadas de confirmación',
  outboundHint:
    'Llama a quien no confirmó su cita por WhatsApp. El paciente marca 1 para confirmar, 2 para cancelar o 3 para que alguien del equipo lo contacte.',
  inboundTitle: 'Atención de llamadas entrantes',
  inboundHint:
    'Contesta el teléfono las 24 horas: ayuda a agendar por WhatsApp, a confirmar o cancelar una cita, da el horario y pasa a un asesor.',
  notReadyTelnyx: 'Se podrá prender cuando Shift termine la configuración.',
  notReadyOutboundNumber: 'Se podrá prender cuando Shift te asigne un número que marque.',
  notReadyInboundNumber: 'Se podrá prender cuando Shift te asigne un número.',

  // Números de Shift
  numbersTitle: 'Números',
  numbersHint: 'Los asigna Shift. Si necesitas cambiarlos, escríbenos.',
  inboundNumber: 'Número de llamadas entrantes',
  callerId: 'Número que marca',
  numberPending: 'Pendiente: lo asigna Shift',

  // Asesores
  advisorsLabel: 'Teléfonos de asesores',
  advisorsHint:
    'Si alguien marca 0 dentro del horario de atención, la llamada suena en todos estos teléfonos a la vez. Escríbelos con el + y el indicativo del país.',
  advisorsEmpty: 'Sin teléfonos, no se puede pasar la llamada a una persona.',
  advisorPlaceholder: '+573001234567',
  advisorAria: (position: number) => `Teléfono del asesor ${position}`,
  advisorAdd: 'Agregar teléfono',
  advisorRemove: (position: number) => `Quitar el teléfono ${position}`,

  // Horario de atención
  hoursTitle: 'Horario de atención',
  hoursHint:
    'Dentro de este horario, quien marque 0 habla con un asesor. Los festivos de Colombia cuentan como cerrado.',
  hoursCopy: 'Copiar lunes a martes-viernes',
  hoursClosed: 'Cerrado',
  hoursOpenAria: (day: string) => `${day}: abierto`,
  hoursFrom: 'De',
  hoursTo: 'a',
  hoursStartAria: (day: string, position: number) => `${day}, tramo ${position}: hora de apertura`,
  hoursEndAria: (day: string, position: number) => `${day}, tramo ${position}: hora de cierre`,
  hoursAddBlock: 'Agregar tramo',
  hoursAddBlockAria: (day: string) => `Agregar un tramo al ${day.toLowerCase()}`,
  hoursRemoveBlock: (day: string, position: number) => `Quitar el tramo ${position} del ${day.toLowerCase()}`,
  hoursPreviewLabel: 'Así se lee tu horario',
  // "p. m." ya termina en punto: no se agrega otro.
  hoursPreview: (text: string) => `Atendemos ${text}${text.endsWith('.') ? '' : '.'}`,
  hoursPreviewEmpty: 'Sin horario: nadie pasará a un asesor y el asistente no podrá decir tu horario.',

  // Texto de horario y dirección
  infoLabel: 'Horario y dirección para quien llama',
  infoHint:
    'Esto es lo que lee el asistente cuando alguien marca 3. Escríbelo como se dice en voz alta, sin abreviaturas ni símbolos. Si lo dejas vacío, lee el horario de atención.',
  infoPlaceholder:
    'Atendemos de lunes a viernes de 8 de la mañana a 6 de la tarde. Estamos en la calle 10 con carrera 5, consultorio 301.',
  infoCount: (used: number, max: number) => `${used} de ${max}`,

  // Salientes
  outboundSectionTitle: 'Cuándo y cuántas veces se llama',
  windowStart: 'Llamar desde',
  windowEnd: 'Llamar hasta',
  windowHint: 'Hora de Bogotá. Nunca se llama en domingo ni en festivo.',
  saturday: 'Llamar también los sábados',
  attempts: 'Intentos por cita',
  attemptsOption: (count: number) => (count === 1 ? '1 intento' : `${count} intentos`),
  attemptsHint: 'Cuántas veces se llama a un paciente que no contesta.',
  retryMinutes: 'Minutos entre intentos',
  retryHint: 'Lo que se espera antes de volver a llamar.',
  callAfterMinutes: 'Minutos después del recordatorio',
  callAfterHint: 'Se espera este tiempo tras el recordatorio de 24 horas para llamar a quien no confirmó.',
  minLeadMinutes: 'Minutos mínimos antes de la cita',
  minLeadHint: 'Si falta menos que esto para la cita, ya no se llama.',

  // Uso del mes
  usageTitle: 'Llamadas salientes de este mes',
  usageValue: (used: number, limit: number) => `${used} de ${limit}`,
  usageHint: 'El tope lo define Shift. Al llegar a él, no salen más llamadas hasta el mes siguiente.',
  usageLow: (left: number) =>
    left === 1 ? 'Te queda 1 llamada este mes.' : `Te quedan ${left} llamadas este mes.`,
  usageFull: 'Llegaste al tope del mes: no saldrán más llamadas salientes hasta el mes siguiente.',
  usageAria: 'Llamadas salientes usadas este mes',

  // Prueba
  testTitle: 'Probar una llamada',
  testHint:
    'Te llamamos al número que escribas con un mensaje de ejemplo marcado como prueba. No toca ninguna cita. Es una llamada real, con el mismo costo por minuto.',
  testLabel: 'Número para la prueba',
  testPlaceholder: '+573001234567',
  testButton: 'Probar llamada',
  testCalling: 'Llamando...',
  testPhoneInvalid: 'Escribe el número con el + y el indicativo del país, por ejemplo +573001234567.',
  testNeedsTelnyx: 'La prueba se activa cuando Shift termine la configuración.',
  testSuccess: 'Listo, te estamos llamando. Contesta y escucha el mensaje de prueba.',
  testFailed: 'No se pudo hacer la llamada de prueba.',

  // Guardar
  save: 'Guardar cambios',
  saving: 'Guardando...',
  saved: 'Cambios guardados.',
  discard: 'Descartar cambios',
  unsaved: 'Tienes cambios sin guardar.',
  saveFailed: 'No se pudieron guardar los cambios. Inténtalo de nuevo en un momento.',
} as const
