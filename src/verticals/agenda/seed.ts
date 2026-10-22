// ============================================================
// Plantilla de barbería — datos semilla y contrato del instalador.
//
// Este módulo es puro (sin I/O) para que la página /agenda pueda
// importar los tipos sin arrastrar código de servidor. Todo el texto
// está en español colombiano y es editable por el dueño desde la UI.
// ============================================================

export interface InstallSectionCounts {
  created: number
  skipped: number
}

/** Qué pasó con la moneda de la cuenta durante la instalación. */
export type CurrencyOutcome =
  /** La cuenta seguía en el default intacto (USD) y se pasó a COP. */
  | 'set_cop'
  /** El dueño ya tenía una moneda elegida (COP incluido): no se tocó. */
  | 'kept'

/** Qué pasó con el prompt del agente de IA durante la instalación. */
export type AiPromptOutcome =
  /** Se escribió porque `ai_configs.system_prompt` estaba vacío. */
  | 'written'
  /** Ya había un prompt propio: nada se tocó. */
  | 'already_set'
  /** La cuenta aún no tiene fila en `ai_configs`. */
  | 'no_config'

export interface AgendaInstallReport {
  currency: CurrencyOutcome
  services: InstallSectionCounts
  staff: InstallSectionCounts
  staffServices: InstallSectionCounts
  workingHours: InstallSectionCounts
  tags: InstallSectionCounts
  customFields: InstallSectionCounts
  pipeline: { created: boolean; stagesCreated: number }
  quickReplies: InstallSectionCounts
  knowledge: InstallSectionCounts
  aiPrompt: AiPromptOutcome
  /** Avisos en español para mostrar en la UI tras instalar. */
  warnings: string[]
}

export interface AgendaSeedService {
  name: string
  description: string
  durationMinutes: number
  price: number
  position: number
}

export interface AgendaSeedStaff {
  name: string
  bio: string
  position: number
}

/** 0 = domingo … 6 = sábado (coincide con JS y con `extract(dow)`). */
export interface AgendaSeedHour {
  weekday: number
  startTime: string
  endTime: string
}

export interface AgendaSeedTag {
  name: string
  color: string
}

export interface AgendaSeedQuickReply {
  title: string
  content: string
}

export interface AgendaSeedDoc {
  title: string
  content: string
}

export interface AgendaSeed {
  services: AgendaSeedService[]
  staff: AgendaSeedStaff[]
  weeklySchedule: AgendaSeedHour[]
  tags: AgendaSeedTag[]
  customFields: string[]
  pipeline: { name: string; stages: { name: string; color: string }[] }
  quickReplies: AgendaSeedQuickReply[]
  knowledgeDocs: AgendaSeedDoc[]
}

export const AGENDA_SEED: AgendaSeed = {
  services: [
    {
      name: 'Corte clásico',
      description: 'Máquina, tijera y lavado. El favorito para el día a día.',
      durationMinutes: 30,
      price: 25000,
      position: 0,
    },
    {
      name: 'Corte + barba',
      description: 'Corte completo y arreglo de barba con navaja y toalla caliente.',
      durationMinutes: 45,
      price: 40000,
      position: 1,
    },
    {
      name: 'Perfilado de barba',
      description: 'Diseño y perfilado de barba con máquina y navaja.',
      durationMinutes: 20,
      price: 15000,
      position: 2,
    },
  ],

  staff: [
    {
      name: 'Andrés',
      bio: 'Barbero principal. Atiende de lunes a sábado.',
      position: 0,
    },
  ],

  // Lunes a sábado, jornada partida (mediodía libre). Editable por el dueño.
  weeklySchedule: [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, startTime: '09:00:00', endTime: '13:00:00' },
    { weekday, startTime: '14:00:00', endTime: '19:00:00' },
  ]),

  tags: [
    { name: 'cita-pendiente', color: '#f59e0b' },
    { name: 'cita-confirmada', color: '#10b981' },
    { name: 'cita-reprogramada', color: '#6366f1' },
    { name: 'cita-cancelada', color: '#ef4444' },
    { name: 'quiere-humano', color: '#8b5cf6' },
    { name: 'atendido', color: '#3b82f6' },
  ],

  // El CRM solo ofrece campos personalizados de texto por ahora.
  customFields: ['barbero_preferido', 'ultima_visita'],

  pipeline: {
    name: 'Barbería',
    stages: [
      { name: 'Nuevo', color: '#3b82f6' },
      { name: 'Cita agendada', color: '#f59e0b' },
      { name: 'Atendida', color: '#10b981' },
      { name: 'No asistió', color: '#ef4444' },
      { name: 'Perdido', color: '#6b7280' },
    ],
  },

  quickReplies: [
    {
      title: 'Saludo',
      content: '¡Hola! 👋 Gracias por escribirnos. ¿Quieres agendar una cita o tienes alguna pregunta?',
    },
    {
      title: 'Horario de atención',
      content:
        'Atendemos de lunes a sábado, de 9:00 a.m. a 1:00 p.m. y de 2:00 p.m. a 7:00 p.m. ¿Te agendo tu cita?',
    },
    {
      title: 'Lista de precios',
      content:
        'Corte clásico: $25.000\nCorte + barba: $40.000\nPerfilado de barba: $15.000\n¿Cuál te gustaría agendar?',
    },
    {
      title: 'Ubicación',
      content: '📍 Estamos en [escribe tu dirección]. Te esperamos de lunes a sábado.',
    },
  ],

  knowledgeDocs: [
    {
      title: 'Horarios de atención',
      content:
        'Atendemos de lunes a sábado, de 9:00 a.m. a 1:00 p.m. y de 2:00 p.m. a 7:00 p.m. Los domingos y festivos permanecemos cerrados.\n\n' +
        'Puedes agendar tu cita por WhatsApp en cualquier momento. El equipo responde dentro del horario de atención.\n\n' +
        'Si necesitas una cita fuera del horario habitual, escríbenos y revisamos la disponibilidad.',
    },
    {
      title: 'Servicios y precios',
      content:
        'Servicios disponibles: corte clásico (30 minutos) por $25.000; corte + barba (45 minutos) por $40.000; perfilado de barba (20 minutos) por $15.000.\n\n' +
        'El precio final puede variar según el largo y el estado del cabello. El barbero confirma el valor antes de empezar.\n\n' +
        'También atendemos a niños, siempre que vengan acompañados por un adulto.',
    },
    {
      title: 'Política de citas y cancelaciones',
      content:
        'Puedes cancelar o reprogramar tu cita por este mismo WhatsApp. Te pedimos hacerlo con al menos 2 horas de anticipación para dejar el cupo disponible.\n\n' +
        'Si llegas más de 10 minutos tarde, puede que debamos atender a otro cliente o reprogramar tu cita.\n\n' +
        'Si no puedes asistir, avísanos: así liberamos el espacio para alguien más.',
    },
    {
      title: 'Métodos de pago',
      content:
        'Recibimos efectivo, Nequi, Daviplata y tarjetas débito y crédito.\n\n' +
        'Al pagar con tarjeta o por transferencia te entregamos el comprobante al finalizar el servicio.\n\n' +
        'Si necesitas factura electrónica, pídesela al barbero antes de pagar.',
    },
    {
      title: 'Ubicación y contacto',
      content:
        'Estamos ubicados en [escribe aquí tu dirección exacta y puntos de referencia para llegar].\n\n' +
        'Puedes escribirnos por este mismo WhatsApp para pedir indicaciones o resolver cualquier duda antes de tu visita.',
    },
  ],
}

/**
 * Prompt sugerido para el agente de IA. Solo se escribe si
 * `ai_configs.system_prompt` está vacío (nunca sobrescribe uno propio).
 * El scaffold de la app lo complementa con las reglas generales
 * (idioma del cliente, protocolo de handoff, no inventar datos).
 */
export const AGENDA_AI_PROMPT = [
  'Eres el asistente de WhatsApp de una barbería en Colombia. Respondes dudas de los clientes y les ayudas a conseguir su cita.',
  '',
  'Contexto del negocio:',
  '- Servicios: corte clásico (30 min) $25.000; corte + barba (45 min) $40.000; perfilado de barba (20 min) $15.000.',
  '- Horario: lunes a sábado, de 9:00 a.m. a 1:00 p.m. y de 2:00 p.m. a 7:00 p.m. Domingos y festivos cerrado.',
  '- Pagos: efectivo, Nequi, Daviplata y tarjetas débito y crédito.',
  '- Cancelaciones y reprogramaciones: con al menos 2 horas de anticipación.',
  '',
  'Cómo responder:',
  '- Escribe en español colombiano, cercano y respetuoso. Mensajes cortos, como se escribe en WhatsApp.',
  '- Usa solo la información de este mensaje y de los documentos del negocio. Si algo no está definido (promociones, precios especiales, disponibilidad exacta), no lo inventes: di que un asesor lo confirmará.',
  '- Nunca prometas una cita, un horario o un precio que no puedas verificar.',
  '- Si el cliente pide hablar con una persona, o el tema no es servicios, precios, horarios o pagos, pasa la conversación a un asesor.',
  '',
  'Actualiza este texto cuando cambien tus precios, servicios u horarios.',
].join('\n')
