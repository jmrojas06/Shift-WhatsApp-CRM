// ============================================================
// Estado conversacional del agente de reservas — puro.
//
// El paso del diálogo vive en `booking_sessions.state` (jsonb) y
// lo posee este módulo. Aquí no hay base de datos ni envíos: solo
// la forma del estado, la codificación de los ids de botón/lista
// (que WhatsApp devuelve tal cual) y el emparejamiento de la
// respuesta del cliente contra el último menú ofrecido.
//
// Emparejamiento por capas (de más fiable a más laxa):
//   1. Tap de botón/lista → id exacto.
//   2. Texto numérico → posición en el último menú ('2').
//   3. Título del menú (sin acentos, mayúsculas ni puntuación).
//   4. Sinónimos de acción ('sí', 'cancelar', 'cualquiera'…).
// ============================================================

export type BookingStep =
  | 'pick_service'
  | 'pick_staff'
  | 'pick_day'
  | 'pick_slot'
  | 'ask_question'
  | 'summary'
  | 'manage_menu'
  | 'manage_cancel_confirm'

/** 'book' = cita nueva · 'reschedule' = reprogramación de una existente. */
export type BookingMode = 'book' | 'reschedule'

export interface OfferedOption {
  /** Id que viaja como button_reply/list_reply id. */
  id: string
  /** Texto visible (también sirve para emparejar respuestas escritas). */
  title: string
}

export interface BookingState {
  step: BookingStep
  mode: BookingMode
  /** Último menú ofrecido: permite resolver respuestas por número/título. */
  options: OfferedOption[]
  /** Respuestas inválidas seguidas; a la segunda se hace handoff. */
  fails: number
  serviceId?: string
  /** Id real de barbero o 'any' ("Cualquiera"). */
  staffId?: string
  /** 'YYYY-MM-DD' local (America/Bogota). */
  dateKey?: string
  /** ISO UTC del slot elegido. */
  slotStartsAt?: string
  /** Cita existente que se está gestionando (cancelar/reprogramar). */
  appointmentId?: string
  /**
   * Pregunta extra en curso, por id (no por posición: el dueño puede reordenar,
   * desactivar o editar mientras el cliente responde). Con `step: 'ask_question'`.
   */
  questionId?: string
  /**
   * Respuestas por id de pregunta. Una pregunta opcional que el cliente no
   * respondió queda con '' (así no se vuelve a preguntar); esas no se muestran
   * ni se guardan en la cita.
   */
  answers?: Record<string, string>
}

export function newBookingState(
  step: BookingStep,
  extra: Partial<BookingState> = {},
): BookingState {
  return { step, mode: 'book', options: [], fails: 0, ...extra }
}

// ------------------------------------------------------------
// Ids de opción
// ------------------------------------------------------------

export const svcId = (id: string): string => `svc:${id}`
export const staffId = (id: string): string => `staff:${id}`
export const dayId = (key: string): string => `day:${key}`
export const slotId = (iso: string): string => `slot:${iso}`
export const actId = (action: string): string => `act:${action}`
/** Opción `index` (base 0) de la pregunta extra en curso. */
export const ansId = (index: number): string => `ans:${index}`

// ------------------------------------------------------------
// Ids del recordatorio (Fase 3)
//
// Los tres botones del recordatorio viajan con id estático
// `rem:<acción>`: en el mensaje libre son los ids de botón y en la
// plantilla de Meta son el payload de los quick replies, que NO
// admite valores dinámicos. La cita sobre la que se actúa se
// resuelve en el controlador (próxima cita activa del contacto).
// ------------------------------------------------------------

export const REMINDER_ACTIONS = ['confirm', 'reschedule', 'cancel'] as const

export type ReminderAction = (typeof REMINDER_ACTIONS)[number]

export const remId = (action: ReminderAction): string => `rem:${action}`

/** 'rem:confirm' → 'confirm'; todo lo demás → null. */
export function parseReminderId(id: string): ReminderAction | null {
  const prefix = 'rem:'
  if (!id.startsWith(prefix)) return null
  const action = id.slice(prefix.length)
  return (REMINDER_ACTIONS as readonly string[]).includes(action)
    ? (action as ReminderAction)
    : null
}

export type OptionKind = 'svc' | 'staff' | 'day' | 'slot' | 'act' | 'ans'

const OPTION_KINDS: readonly OptionKind[] = ['svc', 'staff', 'day', 'slot', 'act', 'ans']

export function parseOptionId(
  id: string,
): { kind: OptionKind; value: string } | null {
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  const kind = id.slice(0, idx) as OptionKind
  const value = id.slice(idx + 1)
  if (!OPTION_KINDS.includes(kind) || value === '') return null
  return { kind, value }
}

// ------------------------------------------------------------
// Textos: normalización y palabras clave
// ------------------------------------------------------------

/** Minúsculas, sin acentos, espacios colapsados. Conserva puntuación. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Como normalizeText pero además fuera la puntuación. */
function squash(text: string): string {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const HANDOFF_WORDS = [
  'asesor',
  'humano',
  'humana',
  'persona',
] as const

const INTENT_WORDS = [
  'hola',
  'cita',
  'citas',
  'agenda',
  'agendar',
  'reservar',
  'reserva',
  'turno',
  'corte',
  'cortes',
  'servicio',
  'servicios',
] as const

/** Escapa los metacaracteres de regex: las palabras propias vienen del dueño. */
const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Límites de palabra con Unicode: `\b` solo conoce ASCII, así que una
 * letra no latina o una ñ pegada contaría como borde.
 */
function containsWord(text: string, words: readonly string[]): boolean {
  const normalized = normalizeText(text)
  return words.some((w) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(w)}(?![\\p{L}\\p{N}])`, 'u').test(normalized),
  )
}

/** Palabras del dueño demasiado comunes para abrir el flujo por sí solas. */
const EXTRA_INTENT_STOPLIST: ReadonlySet<string> = new Set([
  'hora',
  'horas',
  'info',
  'plan',
  'dia',
  'dias',
  'vez',
  'pregunta',
  'precio',
  'precios',
])

/** Mínimo de caracteres para que una palabra del dueño cuente como intención. */
const EXTRA_INTENT_MIN = 4

/**
 * Palabras propias del negocio como palabras de intención: sin acentos,
 * solo letras y números ("clase 🧘" → "clase"), sin las muy cortas ni
 * las muy comunes.
 */
function cleanExtraIntentWords(words: readonly string[]): string[] {
  return words
    .map((w) => normalizeText(w).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim())
    .filter((w) => w.length >= EXTRA_INTENT_MIN && !EXTRA_INTENT_STOPLIST.has(w))
}

/** ¿El cliente pidió hablar con una persona? (gana sobre todo lo demás). */
export function containsHandoffWord(text: string): boolean {
  return containsWord(text, HANDOFF_WORDS)
}

/**
 * ¿El cliente quiere agendar? (arranca el flujo cuando no hay sesión).
 * Acepta además las palabras propias del negocio ("consulta", "turno").
 */
export function containsIntentWord(text: string, extraWords: readonly string[] = []): boolean {
  return containsWord(text, [...INTENT_WORDS, ...cleanExtraIntentWords(extraWords)])
}

// ------------------------------------------------------------
// Emparejamiento de la respuesta
// ------------------------------------------------------------

/**
 * Sinónimos aceptados para acciones y pseudo-opciones, por id de
 * opción. Solo aplican si el último menú ofreció esa opción — así
 * un 'no' suelto no cancela nada que no esté en pantalla.
 */
const ACTION_SYNONYMS: Record<string, string[]> = {
  'act:confirm': ['confirmar', 'confirmo', 'confirmado', 'si', 'dale', 'listo', 'ok'],
  'act:reschedule': ['reprogramar', 'reagendar', 'cambiar', 'cambiar hora', 'otro dia', 'otra hora', 'mover'],
  'act:cancel': ['cancelar', 'cancela', 'anular'],
  'act:cancel_yes': ['si cancelar', 'confirmo cancelar'],
  'act:back': ['volver', 'atras', 'no', 'mejor no'],
  'staff:any': ['cualquiera', 'el que sea', 'alguno', 'me da igual', 'el primero', 'sin preferencia'],
}

export interface MatchChoiceArgs {
  text: string
  /** Id del botón/lista que tocó el cliente, cuando hubo tap. */
  replyId?: string | null
  options: OfferedOption[]
}

/** Resuelve la respuesta del cliente al id de una de las opciones. */
export function matchChoice({
  text,
  replyId,
  options,
}: MatchChoiceArgs): string | null {
  // Un tap solo empareja por id: si el menú ya venció, no se
  // adivina por texto (Meta manda el texto vacío en los taps).
  if (replyId) {
    return options.some((o) => o.id === replyId) ? replyId : null
  }

  const t = normalizeText(text)
  if (!t) return null

  // Número del menú ('2', '2.', '2)').
  const num = t.match(/^(\d+)[.)]?$/)
  if (num) {
    const idx = Number(num[1]) - 1
    return idx >= 0 && idx < options.length ? options[idx].id : null
  }

  const squashed = squash(text)
  if (!squashed) return null

  // Título exacto…
  for (const opt of options) {
    if (squash(opt.title) === squashed) return opt.id
  }
  // …o el texto contiene el título / el título contiene el texto.
  // La contención inversa exige un texto de ≥4 letras: sin este
  // guard, 'sí' emparejaría dentro de 'cla-si-co'.
  const MIN_LOOSE_MATCH = 4
  for (const opt of options) {
    const title = squash(opt.title)
    if (!title) continue
    if (
      squashed.includes(title) ||
      (squashed.length >= MIN_LOOSE_MATCH && title.includes(squashed))
    ) {
      return opt.id
    }
  }

  // Sinónimos, solo para opciones realmente ofrecidas.
  const offered = new Set(options.map((o) => o.id))
  for (const [id, words] of Object.entries(ACTION_SYNONYMS)) {
    if (!offered.has(id)) continue
    if (words.some((w) => new RegExp(`\\b${squash(w)}\\b`).test(squashed))) {
      return id
    }
  }
  return null
}

/**
 * Respuesta a una pregunta extra de opciones. Como `matchChoice`, pero un
 * texto que es el título ENTERO de una opción (sin mayúsculas ni tildes) gana
 * sobre leerlo como número de posición. Los títulos no pueden ser solo
 * números, así que "2" sigue siendo la posición 2; esto cubre títulos como
 * "2 horas" y filas viejas.
 */
export function matchAnswerOption(args: MatchChoiceArgs): string | null {
  if (!args.replyId) {
    const typed = normalizeText(args.text)
    if (typed) {
      const exact = args.options.find((o) => normalizeText(o.title) === typed)
      if (exact) return exact.id
    }
  }
  return matchChoice(args)
}
