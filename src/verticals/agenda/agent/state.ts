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

import { URGENCY_FLOOR_STEMS, URGENCY_FLOOR_WORDS } from '@/modules/clinica/texts'

import type { AnswerMap } from '../questions'

export type BookingStep =
  | 'pick_service'
  | 'pick_staff'
  | 'pick_day'
  | 'pick_slot'
  | 'ask_question'
  | 'summary'
  | 'manage_menu'
  | 'manage_cancel_confirm'
  | 'consent'
  | 'clinic_menu'
  | 'urgency'
  | 'pick_patient'
  | 'new_patient_name'
  | 'pick_appointment'
  | 'marketing_consent'
  /** Esperando la duda del paciente: el siguiente texto es para la IA. */
  | 'faq_open'

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
   * Respuestas por id de pregunta, con la etiqueta que vio el cliente. Una
   * pregunta opcional que no respondió queda con valor '' (así no se vuelve a
   * preguntar); esas no se muestran ni se guardan en la cita.
   */
  answers?: AnswerMap
  /** Paciente de la cita (módulo clínica). */
  patientId?: string
  /**
   * Sede de la cita que se reprograma (módulo clínica): la nueva cita queda en la
   * misma sede que la anterior, no en la que tenga la clínica ese día.
   */
  locationId?: string
  /** Página del menú de días, cuando hay más de los que caben en una lista. */
  dayPage?: number
  /**
   * Texto y versión de la autorización tal como se le mostraron a la persona.
   * Se guardan al responder: la clínica puede editar su texto mientras tanto, y
   * el registro tiene que decir lo que la persona vio, no lo que hay ahora.
   */
  consentText?: string
  consentVersion?: number
  /** Qué sigue al aceptar la autorización; por defecto, el menú. */
  afterConsent?: 'urgency_book'
  /** Reserva abierta desde el flujo de urgencia: salta al menú de horas. */
  urgent?: boolean
  /** Acción del recordatorio que espera saber sobre cuál cita aplica. */
  reminderAction?: ReminderAction
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
/** Paciente de la lista, o 'new' para registrar a otra persona. */
export const patId = (id: string): string => `pat:${id}`
export const apptId = (id: string): string => `appt:${id}`
/**
 * Opción `index` (base 0) de una pregunta extra. Lleva el id de la pregunta: un
 * botón viejo de otra pregunta no puede contestar la que está abierta. Cabe en
 * los 200 caracteres de Meta (id de pregunta uuid = 36).
 */
export const ansId = (questionId: string, index: number): string => `ans:${questionId}:${index}`
/** Opción "Omitir" de una pregunta extra opcional. */
export const ansSkipId = (questionId: string): string => `ans:${questionId}:skip`

/** 'ans:<pregunta>:<n|skip>' → sus partes; todo lo demás → null. */
export function parseAnswerId(
  id: string,
): { questionId: string; index: number | 'skip' } | null {
  if (!id.startsWith('ans:')) return null
  const rest = id.slice('ans:'.length)
  const cut = rest.lastIndexOf(':')
  if (cut <= 0) return null
  const questionId = rest.slice(0, cut)
  const tail = rest.slice(cut + 1)
  if (tail === 'skip') return { questionId, index: 'skip' }
  return /^\d+$/.test(tail) ? { questionId, index: Number(tail) } : null
}

// ------------------------------------------------------------
// Ids del recordatorio (Fase 3)
//
// Los tres botones del recordatorio viajan con id `rem:<acción>`, y con
// `rem:<acción>:<cita>` cuando el negocio tiene varios pacientes por
// número. Una plantilla enviada sin payload devuelve la ETIQUETA del
// botón ("Confirmar"): por eso también se leen las etiquetas. Sin id de
// cita, la cita se resuelve en el controlador.
// ------------------------------------------------------------

export const REMINDER_ACTIONS = ['confirm', 'reschedule', 'cancel'] as const

export type ReminderAction = (typeof REMINDER_ACTIONS)[number]

export const remId = (action: ReminderAction, appointmentId?: string): string =>
  appointmentId ? `rem:${action}:${appointmentId}` : `rem:${action}`

export interface ReminderTap {
  action: ReminderAction
  appointmentId: string | null
  /**
   * El toque llegó como ETIQUETA ("Confirmar"), no como id `rem:*`. Cualquier
   * otra plantilla o difusión puede traer un botón con esa misma etiqueta,
   * así que el controlador solo la acepta si el mensaje responde a un
   * recordatorio.
   */
  viaLabel?: true
}

const REMINDER_LABELS: Readonly<Record<string, ReminderAction>> = {
  Confirmar: 'confirm',
  Reprogramar: 'reschedule',
  Cancelar: 'cancel',
}

/** 'rem:confirm', 'rem:confirm:<id>' o la etiqueta 'Confirmar'; lo demás → null. */
export function parseReminderTap(id: string): ReminderTap | null {
  if (Object.hasOwn(REMINDER_LABELS, id)) {
    return { action: REMINDER_LABELS[id], appointmentId: null, viaLabel: true }
  }
  const [prefix, action, appointmentId] = id.split(':')
  if (prefix !== 'rem') return null
  if (!(REMINDER_ACTIONS as readonly string[]).includes(action)) return null
  return { action: action as ReminderAction, appointmentId: appointmentId || null }
}

export type OptionKind = 'svc' | 'staff' | 'day' | 'slot' | 'act' | 'ans' | 'pat' | 'appt'

const OPTION_KINDS: readonly OptionKind[] = ['svc', 'staff', 'day', 'slot', 'act', 'ans', 'pat', 'appt']

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
  return indexOfWord(text, words) >= 0
}

/** Posición, en el texto normalizado, de la primera de estas palabras; -1 si no hay ninguna. */
function indexOfWord(text: string, words: readonly string[]): number {
  const normalized = normalizeText(text)
  let first = -1
  for (const w of words) {
    const found = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(w)}(?![\\p{L}\\p{N}])`, 'u').exec(normalized)
    if (found && (first === -1 || found.index < first)) first = found.index
  }
  return first
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
  // Una clínica llama "atención" a su servicio, y "gracias por la atención"
  // no es un pedido de cita.
  'atencion',
  'atenciones',
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

/**
 * ¿TODO el mensaje es una palabra de pedir un humano? Es la regla estricta
 * mientras el cliente escribe la respuesta a una pregunta de texto: "es para
 * una persona mayor" es la respuesta, no un pedido de asesor.
 */
export function isHandoffOnly(text: string): boolean {
  return (HANDOFF_WORDS as readonly string[]).includes(squash(text))
}

/** Palabras que, como mensaje completo, saltan una pregunta extra opcional ("n/a" queda como "n a"). */
const SKIP_WORDS: readonly string[] = ['omitir', 'no', 'ninguno', 'ninguna', 'no aplica', 'na', 'n a']

/** ¿Todo el mensaje (sin mayúsculas, tildes ni puntuación) es una palabra de salto? */
export function isSkipAnswer(text: string): boolean {
  return SKIP_WORDS.includes(squash(text))
}

/** ¿El cliente pidió hablar con una persona? (gana sobre todo lo demás). */
export function containsHandoffWord(text: string): boolean {
  return containsWord(text, HANDOFF_WORDS)
}

/**
 * ¿El mensaje trae alguna de estas palabras o frases, enteras y sin importar
 * mayúsculas ni tildes? Las palabras que se pasan no necesitan venir
 * normalizadas.
 */
export function containsAnyWord(text: string, words: readonly string[]): boolean {
  return containsWord(text, words.map(normalizeText))
}

/**
 * Posición de la primera de estas palabras en `normalizeText(text)`, o -1. Sirve
 * para mirar lo que viene antes de ella.
 */
export function indexOfAnyWord(text: string, words: readonly string[]): number {
  return indexOfWord(text, words.map(normalizeText))
}

/** ¿El mensaje trae una palabra de urgencia de la clínica? */
export function containsUrgencyWord(text: string, words: readonly string[]): boolean {
  return containsAnyWord(text, words)
}

/**
 * ¿Trae algo del piso fijo (`URGENCY_FLOOR_STEMS` y `URGENCY_FLOOR_WORDS`)? Las
 * raíces valen al inicio de una palabra; las palabras, enteras.
 */
export function containsUrgencyFloor(text: string): boolean {
  const normalized = normalizeText(text)
  // Al inicio de una palabra: lo que va antes no es una letra ni un número.
  const stem = (s: string) =>
    new RegExp(String.raw`(?<![\p{L}\p{N}])` + escapeRegex(s), 'u').test(normalized)
  return URGENCY_FLOOR_STEMS.some(stem) || containsWord(text, URGENCY_FLOOR_WORDS)
}

/**
 * Lo que abre los signos de alarma: la lista de la clínica MÁS el piso fijo. Un
 * fallo de la configuración o una lista vacía no dejan a nadie sin detectar.
 */
export function detectsUrgency(text: string, clinicWords: readonly string[]): boolean {
  return containsUrgencyWord(text, clinicWords) || containsUrgencyFloor(text)
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

// ------------------------------------------------------------
// Menús de decisión: autorización de datos, aviso de marketing y signos
// de alarma.
//
// Aquí un malentendido cuesta caro: leer un "no" como "sí" registra una
// autorización que nadie dio, y leer "no puedo respirar" como "ninguno"
// manda a agendar a quien necesita urgencias.
//   - Autorización (consent_*): el SÍ solo llega
//     por TOQUE de botón. Ningún texto acepta, ni "acepto" ni "sí": un texto
//     se lee mal (emojis, tildes, "autorizó", dudas) y una autorización tiene
//     que ser explícita. Un texto con una negación en cualquier parte es un
//     rechazo ("acepto, no hay problema" también); cualquier otro, null: el
//     bot vuelve a mostrar los botones y a la segunda pasa a una persona.
//   - Aviso de marketing (mkt_*): el SÍ también solo llega por toque. Es opcional
//     y el rechazo queda registrado, así que solo un mensaje COMPLETO que es un
//     "no" lo rechaza (`MKT_NO_WHOLE`).
//     Cualquier otro, null: el controlador cierra la pregunta sin registrar nada
//     y el mensaje sigue su camino.
//   - Signos de alarma (alarm_*): descartarlos (alarm_no) exige el toque o un
//     mensaje completo de una lista cerrada y SIN emojis ni símbolos
//     ("ninguno 🤔" no descarta nada). Va a una persona (alarm_yes) un toque,
//     un mensaje de otra lista cerrada, una negación dentro de una frase
//     ("no puedo respirar") o un signo dicho con palabras ("fiebre alta"):
//     ante la duda, no se agenda. Lo demás ("tengo mucho dolor"), null.
// Estos botones no muestran números, así que un número tampoco acepta ni
// descarta nada. Un toque de botón (replyId) no pasa por aquí y siempre vale.
// ------------------------------------------------------------

/**
 * Opciones que deciden algo por la persona: no se eligen por número ni por
 * texto suelto. Aceptar o descartar los signos de alarma es evidente; el
 * rechazo también, porque queda en un registro de solo agregar y pausa el bot,
 * y un "2" suelto no es una decisión.
 */
const ACCEPTING_IDS: ReadonlySet<string> = new Set([
  'act:consent_yes',
  'act:consent_no',
  'act:mkt_yes',
  'act:mkt_no',
  'act:alarm_no',
])

/** Mensajes completos que descartan los signos de alarma, ya en forma `squash`. */
const ALARM_NO_WHOLE: readonly string[] = [
  'no',
  'no ninguno',
  'ninguno',
  'ninguna',
  'no ninguna',
  'no tengo',
  'no tengo ninguno',
  'no tengo ninguna',
  'no tengo nada',
  'nada',
  'ninguno de esos',
  'ninguna de esas',
  'ninguno de los anteriores',
  'no ninguno de esos',
  'no ninguna de esas',
  'no tengo ninguno de esos',
  'no tengo ninguna de esas',
  'no no',
  'no no tengo',
  'nop',
  'nope',
  'noo',
  'no gracias',
  'no senor',
  'no senora',
  'nada de eso',
  'no nada de eso',
  'no doctora',
  'no doctor',
  'no senorita',
  'creo que no',
  'no tengo ninguno de esos signos',
]

/**
 * El texto ORIGINAL solo trae letras, números, espacios y puntuación simple.
 * `squash` borra emojis y símbolos, así que sin esta comprobación "ninguno 🤔"
 * parecería un "ninguno" limpio.
 */
const PLAIN_TEXT = /^[\p{L}\p{N}\s.,;:!¡]+$/u

/** Un signo de alarma dicho con palabras (texto ya normalizado). */
const ALARM_SIGNS =
  /\b(si|respir\w*|trag\w*|sangr\w*|hinch\w*|inflam\w*|fiebre|calentura|golpe\w*|ahog\w*|aire)\b/

/** Mensajes completos que dicen que sí hay signos de alarma. */
const ALARM_YES_WHOLE: readonly string[] = ['si', 'si tengo', 'si tengo alguno', 'tengo alguno']

/**
 * Una respuesta a los signos que no es ni "sí" ni "no": una negación sin ningún
 * signo. No es una opción del menú; `handleClinicChoice` la lee.
 */
export const ALARM_UNSURE = 'act:alarm_unsure'

/** Mensajes completos que rechazan los avisos de control, ya en forma `squash`. */
const MKT_NO_WHOLE: readonly string[] = ['no', 'no gracias', 'mejor no', 'no senor', 'no senora']

/** Negaciones en texto ya normalizado: "noo", "nop", "para nada", "nunca"… */
const NEGATION = /\b(no+|nop|nope|ni|nunca|jamas|tampoco|nada)\b/

/**
 * Lee la respuesta escrita a un menú de decisión. `undefined` = el menú no
 * es de decisión y sigue el emparejamiento normal; `null` = no se entendió.
 */
function matchDecision(
  text: string,
  squashed: string,
  offered: ReadonlySet<string>,
): string | null | undefined {
  if (offered.has('act:consent_yes') || offered.has('act:consent_no')) {
    return offered.has('act:consent_no') && NEGATION.test(squashed) ? 'act:consent_no' : null
  }

  // Los avisos de control son opcionales y el rechazo queda registrado: solo un mensaje
  // que ES un "no" lo registra. Una negación dentro de otra frase ("no voy a poder
  // asistir a la cita", "¿no hay parqueadero?") sigue su camino sin registrar nada.
  if (offered.has('act:mkt_yes') || offered.has('act:mkt_no')) {
    return offered.has('act:mkt_no') && PLAIN_TEXT.test(text) && MKT_NO_WHOLE.includes(squashed)
      ? 'act:mkt_no'
      : null
  }

  if (offered.has('act:alarm_yes') || offered.has('act:alarm_no')) {
    // Con "?" no hay respuesta: "¿ninguno?" es una pregunta (y "?" no pasa PLAIN_TEXT).
    if (offered.has('act:alarm_no') && PLAIN_TEXT.test(text) && ALARM_NO_WHOLE.includes(squashed)) {
      return 'act:alarm_no'
    }
    if (offered.has('act:alarm_yes')) {
      // Un signo, dicho con palabras o dentro de una negación ("no puedo respirar"), va a urgencias.
      if (ALARM_YES_WHOLE.includes(squashed) || ALARM_SIGNS.test(squashed)) return 'act:alarm_yes'
      // Una negación en una frase sin ningún signo ("no, solo me duele") no descarta
      // nada y tampoco dice "ve a urgencias" a ciegas: se avisa a la clínica.
      if (NEGATION.test(squashed)) return ALARM_UNSURE
    }
    return null
  }

  return undefined
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
    const id = idx >= 0 && idx < options.length ? options[idx].id : null
    // Los botones de decisión no muestran números: un número no puede aceptar,
    // rechazar ni descartar los signos de alarma.
    return id && !ACCEPTING_IDS.has(id) ? id : null
  }

  const squashed = squash(text)
  if (!squashed) return null

  const offered = new Set(options.map((o) => o.id))

  // Autorización, marketing y signos de alarma: ver `matchDecision`. Su
  // respuesta es final, así que NO caen a la coincidencia suelta por título
  // ("acep" estaría dentro de "sí acepto").
  const decision = matchDecision(text, squashed, offered)
  if (decision !== undefined) return decision

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

/**
 * Respuesta a la lista de citas. Como `matchChoice`, pero un texto escrito que
 * coincide con VARIAS citas ("Marta" cuando hay dos de Marta) no elige la primera:
 * no empareja, y cuenta como fallo. Primero manda el título entero; después, la
 * única cita que lo contiene. El toque y el número de posición no cambian. Solo
 * esta lista lo usa: los demás menús siguen con `matchChoice`.
 */
export function matchAppointmentOption(args: MatchChoiceArgs): string | null {
  const typed = normalizeText(args.text)
  if (args.replyId || !typed || /^(\d+)[.)]?$/.test(typed)) return matchChoice(args)

  const squashed = squash(args.text)
  if (!squashed) return null
  const exact = args.options.filter((o) => squash(o.title) === squashed)
  if (exact.length) return exact.length === 1 ? exact[0].id : null

  const hits = args.options.filter((o) => matchChoice({ text: args.text, options: [o] }) !== null)
  return hits.length === 1 ? hits[0].id : null
}
