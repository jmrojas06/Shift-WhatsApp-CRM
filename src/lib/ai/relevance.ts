import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Filtro gratis antes de la IA: ¿el mensaje es del negocio?
//
// Sin modelo y sin costo: compara las palabras del cliente con el
// vocabulario del negocio (su nombre, el contexto que Shift escribe en
// la IA, la base de conocimiento y los servicios) y con las intenciones
// comunes de cualquier comercio (precio, horario, cita, envío, pago…).
//
// Es conservador a propósito: ante la duda deja pasar. Solo frena
// mensajes con varias palabras de contenido y ninguna relación con el
// negocio ("escríbeme un ensayo sobre la revolución francesa"). Los
// mensajes cortos (saludos, "sí", "precio?") siempre pasan.
// ============================================================

/** Hasta este número de palabras de contenido el mensaje siempre pasa. */
const SHORT_MESSAGE_WORDS = 2

/** Intenciones de cualquier comercio, ya normalizadas (sin tildes, raíz). */
const COMMON_INTENTS = [
  // saludo, cortesía y pedir una persona
  'hola', 'buen', 'buena', 'buenas', 'buenos', 'dia', 'tarde', 'noche', 'gracia', 'favor',
  'asesor', 'humano', 'persona', 'ayuda', 'ayudar', 'informacion', 'info',
  // precio y pago
  'precio', 'cuesta', 'cuestan', 'vale', 'valen', 'valor', 'cuanto', 'costo', 'tarifa', 'cotizacion',
  'pago', 'pagar', 'nequi', 'daviplata', 'transferencia', 'efectivo', 'tarjeta', 'abono', 'anticipo',
  'descuento', 'promocion', 'oferta', 'mayor', 'mayorista', 'detal',
  // horario, ubicación y contacto
  'horario', 'hora', 'abren', 'abierto', 'cierran', 'cerrado', 'atienden', 'domingo', 'sabado', 'festivo',
  'direccion', 'ubicacion', 'ubicado', 'ubicados', 'donde', 'queda', 'local', 'sede', 'llegar', 'mapa',
  'telefono', 'whatsapp', 'llamar', 'contacto',
  // citas
  'cita', 'turno', 'reserva', 'reservar', 'agendar', 'agenda', 'disponible', 'disponibilidad', 'cupo',
  'cancelar', 'reprogramar', 'cambiar', 'confirmar',
  // pedidos y productos
  'pedido', 'comprar', 'compra', 'producto', 'servicio', 'catalogo', 'foto', 'modelo', 'talla',
  'color', 'stock', 'tienen', 'hay', 'venden', 'envio', 'enviar', 'domicilio', 'entrega', 'guia',
  'garantia', 'devolucion', 'cambio', 'factura',
  // inglés y portugués básicos (Shift también atiende EE. UU. y España)
  'price', 'cost', 'hour', 'open', 'appointment', 'book', 'booking', 'order', 'shipping', 'address',
  'preco', 'horario', 'agendamento', 'entrega',
]

/** Palabras que no dicen de qué trata el mensaje. */
const STOPWORDS = new Set([
  'que', 'quien', 'como', 'cual', 'cuando', 'para', 'por', 'con', 'sin', 'una', 'uno', 'unos', 'unas',
  'los', 'las', 'del', 'las', 'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'aqui', 'alli', 'muy', 'mas',
  'pero', 'porque', 'pues', 'tambien', 'solo', 'algo', 'todo', 'nada', 'mucho', 'poco', 'ser', 'estar',
  'tengo', 'tiene', 'quiero', 'quisiera', 'puedo', 'puede', 'puedes', 'necesito', 'saber', 'ustedes',
  'usted', 'ellos', 'ella', 'nosotros', 'mio', 'tuyo', 'suyo', 'sus', 'mis', 'tus', 'les', 'nos',
  'the', 'and', 'you', 'for', 'with', 'what', 'how', 'can', 'are', 'this', 'that', 'have', 'please',
  'sobre', 'entre', 'hasta', 'desde', 'hacia', 'segun', 'durante', 'mediante', 'ahora', 'ayer', 'hoy',
])

/** Minúsculas, sin tildes ni signos; palabras de 3+ letras, sin stopwords, con raíz simple. */
export function contentWords(text: string): string[] {
  return text
    // La ñ va aparte: sin esto "uñas" quedaría en "unas" (una stopword).
    .replace(/ñ/gi, 'nn')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem)
}

/** Raíz mínima: quita el plural para que "cortes" encuentre "corte". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1)
  return word
}

/** Vocabulario del negocio a partir de sus textos. */
export function buildVocabulary(sources: readonly (string | null | undefined)[]): Set<string> {
  const vocab = new Set<string>()
  for (const source of sources) {
    if (!source) continue
    for (const word of contentWords(source)) vocab.add(word)
  }
  for (const intent of COMMON_INTENTS) vocab.add(stem(intent))
  return vocab
}

/** ¿Vale la pena que la IA responda este mensaje? */
export function isOnTopic(message: string, vocabulary: ReadonlySet<string>): boolean {
  const words = contentWords(message)
  if (words.length <= SHORT_MESSAGE_WORDS) return true
  return words.some((word) => vocabulary.has(word))
}

/** Tope de texto leído por fuente: el vocabulario no necesita documentos enteros. */
const MAX_SOURCE_CHARS = 20_000

/**
 * Junta los textos del negocio. Cada lectura es independiente y si falla
 * se ignora: sin vocabulario solo quedan las intenciones comunes, y el
 * filtro sigue siendo conservador.
 */
export async function loadBusinessVocabulary(
  db: SupabaseClient,
  accountId: string,
  systemPrompt: string | null,
): Promise<Set<string>> {
  const [account, docs, services] = await Promise.all([
    db.from('accounts').select('name').eq('id', accountId).maybeSingle(),
    db
      .from('ai_knowledge_documents')
      .select('title, content')
      .eq('account_id', accountId)
      .limit(200),
    db
      .from('booking_services')
      .select('name, description')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .limit(200),
  ])

  const sources: (string | null | undefined)[] = [systemPrompt]
  if (!account.error) sources.push((account.data as { name?: string } | null)?.name)
  if (!docs.error) {
    for (const d of (docs.data ?? []) as { title: string; content: string }[]) {
      sources.push(d.title, d.content.slice(0, MAX_SOURCE_CHARS))
    }
  }
  if (!services.error) {
    for (const s of (services.data ?? []) as { name: string; description: string | null }[]) {
      sources.push(s.name, s.description)
    }
  }
  return buildVocabulary(sources)
}
