// ============================================================
// Plantilla de la agenda — tipos del seed y contrato del instalador.
//
// Este módulo es puro (sin I/O) para que la página /agenda pueda
// importar los tipos sin arrastrar código de servidor. Los datos de
// cada tipo de negocio viven en `presets/`. Todo el texto está en
// español colombiano y es editable por el dueño desde la UI.
// ============================================================

import type { PresetKey } from './presets'

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
  /** Punto de partida que se aplicó. */
  presetKey: PresetKey
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
  /** Preguntas extra del bot (`created` = las del punto de partida; `skipped` = la cuenta ya tenía). */
  questions: InstallSectionCounts
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

/** "Agenda" desde 051; "Barbería" en cuentas instaladas antes. */
export const AGENDA_PIPELINE_NAMES = ['agenda', 'barbería'] as const

/** ¿Es el nombre (sin importar mayúsculas ni espacios) del pipeline de la agenda? */
export function isAgendaPipelineName(name: unknown): boolean {
  return (AGENDA_PIPELINE_NAMES as readonly string[]).includes(
    String(name).trim().toLowerCase(),
  )
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
