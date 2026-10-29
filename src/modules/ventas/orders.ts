// ============================================================
// Dominio puro de Ventas A — pedidos hechos por WhatsApp.
//
// Sin base de datos ni red: validación del pedido que llega del
// navegador, totales en centavos enteros, transiciones de estado y
// mapeo estado → etapa del pipeline. El repositorio (repo.ts) y las
// rutas solo orquestan; las reglas viven aquí.
//
// Reglas de oro:
//   - Jamás lanza. Los errores de validación se devuelven como
//     `{ ok: false, message }` con el mensaje listo para la pantalla
//     (es-CO, tuteo).
//   - El total NUNCA se toma del cliente: ni aparece en el resultado
//     de `validateOrderCreate`. Se calcula con `orderTotals`.
//   - Los límites coinciden con los CHECK de la migración 054; la base
//     es la última red, no la primera.
//   - El dinero se maneja en centavos enteros para no perder precisión
//     (0.1 + 0.2 no es 0.30000000000000004).
// ============================================================

import { ACCOUNT_TIME_ZONE } from '@/lib/time-zone'

export type Valid<T> = { ok: true; value: T } | { ok: false; message: string }

// ------------------------------------------------------------
// Límites (alineados con 054_ventas.sql)
// ------------------------------------------------------------

export const ORDER_LIMITS = {
  itemsMin: 1,
  itemsMax: 50,
  nameMax: 120,
  quantityMin: 1,
  quantityMax: 9999,
  /** unit_price y shipping: 99.999.999,99 (numeric(12,2) deja mucho margen por línea). */
  amountMaxCents: 9_999_999_999,
  /** orders.total es numeric(12,2): 9.999.999.999,99. */
  totalMaxCents: 999_999_999_999,
  cityMax: 80,
  addressMax: 200,
  idNumberMax: 20,
  notesMax: 500,
  carrierMax: 60,
  trackingMax: 60,
} as const

// ------------------------------------------------------------
// Dinero en centavos
// ------------------------------------------------------------

/**
 * Tolerancia RELATIVA para aceptar el ruido de coma flotante de valores
 * como 0.1 + 0.2 (= 0.30000000000000004). El error de punto flotante crece
 * con el tamaño del número (unos pocos ulp, ~1e-15 relativo); una
 * tolerancia absoluta aceptaría fracciones de centavo diminutas como
 * 1e-7 en importes pequeños. Aquí: |x·100 − centavos| ≤ |x·100| · 1e-13.
 * Un tercer decimal real (1.005, 10.001, 99999999.9901) se aleja del
 * centavo por mucho más que eso, y 0 solo admite 0 exacto.
 */
const CENT_NOISE_RELATIVE = 1e-13

/** Importe → centavos enteros (redondea; normaliza -0). */
export function toCents(amount: number): number {
  const cents = Math.round(amount * 100)
  return cents === 0 ? 0 : cents
}

/**
 * ¿El importe cabe en centavos (máximo 2 decimales), descontando el ruido
 * de coma flotante? Misma tolerancia que usa la validación del pedido.
 */
export function hasCentPrecision(amount: number): boolean {
  const scaled = amount * 100
  return Math.abs(scaled - Math.round(scaled)) <= Math.abs(scaled) * CENT_NOISE_RELATIVE
}

/** Centavos enteros → importe con 2 decimales. */
export function fromCents(cents: number): number {
  const amount = cents / 100
  return amount === 0 ? 0 : amount
}

/** 1234567 → '12.345,67' (sin símbolo; para mensajes de validación). */
function plainAmount(cents: number): string {
  const whole = Math.trunc(cents / 100)
  const rest = String(cents % 100).padStart(2, '0')
  return `${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${rest}`
}

export interface OrderTotals {
  subtotalCents: number
  shippingCents: number
  totalCents: number
  subtotal: number
  shipping: number
  total: number
}

/** Totales del pedido en centavos enteros (cantidad × precio, más envío). */
export function orderTotals(
  items: ReadonlyArray<{ quantity: number; unitPrice: number }>,
  shipping: number,
): OrderTotals {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.quantity * toCents(item.unitPrice),
    0,
  )
  const shippingCents = toCents(shipping)
  const totalCents = subtotalCents + shippingCents
  return {
    subtotalCents,
    shippingCents,
    totalCents,
    subtotal: fromCents(subtotalCents),
    shipping: fromCents(shippingCents),
    total: fromCents(totalCents),
  }
}

// ------------------------------------------------------------
// Validación de textos
// ------------------------------------------------------------

/**
 * Caracteres de control, formato (zero-width space, ZWJ, marcas de
 * dirección), sustitutos sueltos y de uso privado. Mismo criterio que
 * las palabras de la agenda (labels.ts): se prefiere un emoji simple a
 * un compuesto con ZWJ.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Cédula / documento: letras, números, puntos y guiones. */
const ID_NUMBER_RE = /^[0-9A-Za-z.-]+$/

/** Largo en puntos de código (igual que char_length de Postgres). */
const length = (text: string): number => Array.from(text).length

interface TextRules {
  /** 'La ciudad' (sujeto de la frase). */
  subject: string
  /** 'no pueden' si el sujeto es plural. */
  verb?: string
  max: number
  /** Permite \n y \t (notas). */
  multiline?: boolean
}

function optionalText(raw: unknown, rules: TextRules): Valid<string | null> {
  const { subject, max } = rules
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') {
    const be = rules.verb === 'no pueden' ? 'deben' : 'debe'
    return { ok: false, message: `${subject} ${be} ser texto.` }
  }
  let text = raw.trim()
  if (rules.multiline) text = text.replace(/\r\n?/g, '\n')
  if (!text) return { ok: true, value: null }
  const probe = rules.multiline ? text.replace(/[\n\t]/g, '') : text
  if (CONTROL_OR_FORMAT.test(probe)) {
    const have = rules.verb === 'no pueden' ? 'tienen' : 'tiene'
    return { ok: false, message: `${subject} ${have} caracteres no permitidos.` }
  }
  if (length(text) > max) {
    return {
      ok: false,
      message: `${subject} ${rules.verb ?? 'no puede'} pasar de ${max} caracteres.`,
    }
  }
  return { ok: true, value: text }
}

interface RequiredTextRules {
  /** Mensaje si falta o no es texto. */
  missing: string
  /** 'La transportadora' (sujeto de la frase). */
  subject: string
  max: number
}

function requiredText(raw: unknown, rules: RequiredTextRules): Valid<string> {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: rules.missing }
  const text = raw.trim()
  if (CONTROL_OR_FORMAT.test(text)) {
    return { ok: false, message: `${rules.subject} tiene caracteres no permitidos.` }
  }
  if (length(text) > rules.max) {
    return { ok: false, message: `${rules.subject} no puede pasar de ${rules.max} caracteres.` }
  }
  return { ok: true, value: text }
}

// ------------------------------------------------------------
// Validación de importes
// ------------------------------------------------------------

/**
 * Importe en pesos con máximo 2 decimales. `subject` va en la frase
 * ("el precio", "El envío"); devuelve el importe normalizado (sin
 * ruido de coma flotante).
 */
function validateAmount(raw: unknown, subject: string): Valid<number> {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, message: `${subject} debe ser un número.` }
  }
  if (raw < 0) return { ok: false, message: `${subject} no puede ser negativo.` }
  const cents = Math.round(raw * 100)
  if (cents > ORDER_LIMITS.amountMaxCents) {
    return {
      ok: false,
      message: `${subject} no puede pasar de ${plainAmount(ORDER_LIMITS.amountMaxCents)}.`,
    }
  }
  if (!hasCentPrecision(raw)) {
    return { ok: false, message: `${subject} admite máximo 2 decimales.` }
  }
  return { ok: true, value: fromCents(cents) }
}

// ------------------------------------------------------------
// validateOrderCreate
// ------------------------------------------------------------

export interface OrderItemInput {
  name: string
  quantity: number
  unitPrice: number
}

/** Pedido validado y normalizado, listo para `create_order()`. Sin total. */
export interface ValidOrderCreate {
  contactId: string
  conversationId: string | null
  items: OrderItemInput[]
  shipping: number
  paid: boolean
  city: string | null
  address: string | null
  idNumber: string | null
  notes: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validateItem(raw: unknown, index: number): Valid<OrderItemInput> {
  const prefix = `Producto ${index + 1}:`
  if (!isRecord(raw)) return { ok: false, message: `${prefix} los datos no son válidos.` }

  const name = requiredText(raw.name, {
    missing: 'escribe el nombre.',
    subject: 'el nombre',
    max: ORDER_LIMITS.nameMax,
  })
  if (!name.ok) return { ok: false, message: `${prefix} ${name.message}` }

  const quantity = raw.quantity
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < ORDER_LIMITS.quantityMin ||
    quantity > ORDER_LIMITS.quantityMax
  ) {
    return {
      ok: false,
      message: `${prefix} la cantidad debe ser un número entero entre ${ORDER_LIMITS.quantityMin} y ${ORDER_LIMITS.quantityMax}.`,
    }
  }

  const price = validateAmount(raw.unitPrice, 'el precio')
  if (!price.ok) return { ok: false, message: `${prefix} ${price.message}` }

  return { ok: true, value: { name: name.value, quantity, unitPrice: price.value } }
}

/**
 * Valida el cuerpo de "crear pedido". Cualquier `total`, `subtotal` o
 * campo desconocido que llegue se ignora: el total se calcula con
 * `orderTotals` a partir de las líneas y el envío.
 */
export function validateOrderCreate(input: unknown): Valid<ValidOrderCreate> {
  if (!isRecord(input)) return { ok: false, message: 'Los datos del pedido no son válidos.' }

  const { contactId, conversationId } = input
  if (contactId === undefined || contactId === null || contactId === '') {
    return { ok: false, message: 'Falta el contacto del pedido.' }
  }
  if (typeof contactId !== 'string' || !UUID_RE.test(contactId)) {
    return { ok: false, message: 'El contacto del pedido no es válido.' }
  }
  if (
    conversationId !== undefined &&
    conversationId !== null &&
    conversationId !== '' &&
    (typeof conversationId !== 'string' || !UUID_RE.test(conversationId))
  ) {
    return { ok: false, message: 'La conversación del pedido no es válida.' }
  }

  const rawItems = input.items
  if (!Array.isArray(rawItems) || rawItems.length < ORDER_LIMITS.itemsMin) {
    return { ok: false, message: 'Agrega al menos un producto.' }
  }
  if (rawItems.length > ORDER_LIMITS.itemsMax) {
    return {
      ok: false,
      message: `Un pedido admite máximo ${ORDER_LIMITS.itemsMax} productos.`,
    }
  }
  const items: OrderItemInput[] = []
  for (let i = 0; i < rawItems.length; i++) {
    const item = validateItem(rawItems[i], i)
    if (!item.ok) return item
    items.push(item.value)
  }

  let shipping = 0
  if (input.shipping !== undefined && input.shipping !== null) {
    const result = validateAmount(input.shipping, 'El envío')
    if (!result.ok) return result
    shipping = result.value
  }

  const totals = orderTotals(items, shipping)
  if (totals.totalCents > ORDER_LIMITS.totalMaxCents) {
    return {
      ok: false,
      message: `El total del pedido no puede pasar de ${plainAmount(ORDER_LIMITS.totalMaxCents)}.`,
    }
  }

  let paid = false
  if (input.paid !== undefined && input.paid !== null) {
    if (typeof input.paid !== 'boolean') {
      return { ok: false, message: 'Indica si el pedido ya está pagado (sí o no).' }
    }
    paid = input.paid
  }

  const city = optionalText(input.city, { subject: 'La ciudad', max: ORDER_LIMITS.cityMax })
  if (!city.ok) return city
  const address = optionalText(input.address, { subject: 'La dirección', max: ORDER_LIMITS.addressMax })
  if (!address.ok) return address

  const idNumber = optionalText(input.idNumber, { subject: 'La cédula', max: ORDER_LIMITS.idNumberMax })
  if (!idNumber.ok) return idNumber
  if (idNumber.value !== null && !ID_NUMBER_RE.test(idNumber.value)) {
    return { ok: false, message: 'La cédula solo admite letras, números, puntos y guiones.' }
  }

  const notes = optionalText(input.notes, {
    subject: 'Las notas',
    verb: 'no pueden',
    max: ORDER_LIMITS.notesMax,
    multiline: true,
  })
  if (!notes.ok) return notes

  return {
    ok: true,
    value: {
      contactId,
      conversationId: typeof conversationId === 'string' && conversationId !== '' ? conversationId : null,
      items,
      shipping,
      paid,
      city: city.value,
      address: address.value,
      idNumber: idNumber.value,
      notes: notes.value,
    },
  }
}

// ------------------------------------------------------------
// Estados, acciones y transiciones
// ------------------------------------------------------------

export type OrderStatus = 'new' | 'shipped' | 'delivered' | 'cancelled'
export type PaymentStatus = 'pending' | 'paid'

/**
 * Lo mínimo del pedido que las reglas necesitan (nombres de columna).
 * `city` y `address` los exige `mark_shipped`: si faltan en el pedido
 * deben llegar por `extra`.
 */
export interface OrderState {
  status: OrderStatus
  payment_status: PaymentStatus
  city?: string | null
  address?: string | null
}

/** Zona horaria con la que se mide el mes de "vendido este mes". */
export const SALES_TIME_ZONE = ACCOUNT_TIME_ZONE

/**
 * ¿El pedido cuenta como venta? Definición única de "vendido este mes"
 * (pestaña /ventas): la SUMA de `total` de los pedidos con
 * `payment_status = 'paid'` Y `status <> 'cancelled'`, agrupados por el
 * mes de `paid_at` en la zona America/Bogota (`SALES_TIME_ZONE`).
 *
 *   - Se cuenta cuando se COBRA, no cuando se crea ni cuando se entrega.
 *   - Un pedido cancelado deja de contar aunque se hubiera cobrado
 *     (el reembolso lo maneja el negocio; en el CRM la venta se cae).
 *   - "Por cobrar" es lo contrario: `payment_status = 'pending'` y no
 *     cancelado.
 *
 * El filtro por mes es de fechas (SQL/repo); esta función es la parte de
 * estado, para que ninguna pantalla invente su propia regla.
 */
export function isCountedSale(order: Pick<OrderState, 'status' | 'payment_status'>): boolean {
  return order.payment_status === 'paid' && order.status !== 'cancelled'
}

export const ORDER_ACTIONS = ['mark_paid', 'mark_shipped', 'mark_delivered', 'cancel'] as const
export type OrderAction = (typeof ORDER_ACTIONS)[number]

export const isOrderAction = (value: unknown): value is OrderAction =>
  typeof value === 'string' && (ORDER_ACTIONS as readonly string[]).includes(value)

/** Aviso al cliente que dispara una acción. */
export type NoticeKind = 'paid' | 'shipped' | 'delivered'

export function noticeFor(action: OrderAction): NoticeKind | null {
  switch (action) {
    case 'mark_paid':
      return 'paid'
    case 'mark_shipped':
      return 'shipped'
    case 'mark_delivered':
      return 'delivered'
    default:
      return null
  }
}

/** Columnas de `orders` que una acción cambia (listo para un UPDATE). */
export interface OrderPatch {
  status?: OrderStatus
  payment_status?: PaymentStatus
  paid_at?: string
  shipped_at?: string
  delivered_at?: string
  cancelled_at?: string
  carrier?: string
  tracking_number?: string
  /** Solo si llegaron por `extra` al marcar enviado. */
  city?: string
  address?: string
}

/** Datos extra de una acción (hoy: solo "enviado"). */
export interface OrderActionExtra {
  carrier?: unknown
  tracking_number?: unknown
  city?: unknown
  address?: unknown
}

/**
 * Ciudad o dirección de envío. Si llega por `extra` (no vacía) se valida
 * y se devuelve para el parche; si no, el pedido ya debe tenerla.
 * `undefined` en el valor = no tocar lo que ya tiene el pedido.
 */
function shippingPlace(
  provided: unknown,
  current: string | null | undefined,
  rules: { subject: string; missing: string; max: number },
): Valid<string | undefined> {
  const isProvided =
    provided !== undefined &&
    provided !== null &&
    !(typeof provided === 'string' && !provided.trim())
  if (isProvided) {
    if (typeof provided !== 'string') {
      return { ok: false, message: `${rules.subject} debe ser texto.` }
    }
    return requiredText(provided, rules)
  }
  if (typeof current === 'string' && current.trim()) return { ok: true, value: undefined }
  return { ok: false, message: rules.missing }
}

export type OrderActionResult =
  | {
      ok: true
      /** false = no había nada que hacer (marcar pagado un pedido ya pagado). */
      changed: boolean
      patch: OrderPatch
      /** Aviso a mandar al cliente; null si no hay o si no cambió nada. */
      notice: NoticeKind | null
    }
  | {
      ok: false
      message: string
      /**
       * 'transition' = el estado actual del pedido no admite la acción
       * (ya enviado, entregado, cancelado…): es un conflicto (409).
       * 'invalid' = faltan datos o están mal, o la acción no existe (400).
       */
      reason: 'invalid' | 'transition'
    }

const refuse = (message: string, reason: 'invalid' | 'transition' = 'invalid'): OrderActionResult => ({
  ok: false,
  message,
  reason,
})
const blocked = (message: string): OrderActionResult => refuse(message, 'transition')

/**
 * Aplica una acción a un pedido. Pura: no muta el pedido ni toca la
 * base; devuelve el parche a guardar o un error en español.
 *
 *   mark_paid       pending → paid, en cualquier estado no cancelado.
 *                   Ya pagado: no-op (`changed: false`, sin aviso).
 *   mark_shipped    new → shipped. Exige transportadora, guía, ciudad
 *                   y dirección (las dos últimas, del pedido o de `extra`).
 *   mark_delivered  new | shipped → delivered. Desde `new` es el retiro
 *                   en tienda o la entrega local sin guía: no pide
 *                   ciudad, dirección ni transportadora, y el aviso de
 *                   entrega se manda igual.
 *   cancel          new | shipped → cancelled.
 *
 * Un pedido entregado o cancelado no se reabre (se crea otro).
 */
export function applyOrderAction(
  order: OrderState,
  action: string,
  extra: OrderActionExtra = {},
  now: Date = new Date(),
): OrderActionResult {
  const at = now.toISOString()

  switch (action) {
    case 'mark_paid': {
      if (order.status === 'cancelled') {
        return blocked('Un pedido cancelado no se puede marcar como pagado.')
      }
      if (order.payment_status === 'paid') {
        return { ok: true, changed: false, patch: {}, notice: null }
      }
      return {
        ok: true,
        changed: true,
        patch: { payment_status: 'paid', paid_at: at },
        notice: 'paid',
      }
    }

    case 'mark_shipped': {
      if (order.status === 'shipped') return blocked('El pedido ya fue marcado como enviado.')
      if (order.status === 'delivered') return blocked('El pedido ya fue entregado.')
      if (order.status === 'cancelled') return blocked('El pedido está cancelado.')

      const carrier = requiredText(extra.carrier, {
        missing: 'Escribe la transportadora.',
        subject: 'La transportadora',
        max: ORDER_LIMITS.carrierMax,
      })
      if (!carrier.ok) return refuse(carrier.message)
      const tracking = requiredText(extra.tracking_number, {
        missing: 'Escribe el número de guía.',
        subject: 'El número de guía',
        max: ORDER_LIMITS.trackingMax,
      })
      if (!tracking.ok) return refuse(tracking.message)

      // Un envío sin ciudad y dirección no sale: se toman del pedido o,
      // si faltan, de `extra` (y entonces quedan guardadas en el pedido).
      const city = shippingPlace(extra.city, order.city, {
        subject: 'La ciudad',
        missing: 'Escribe la ciudad de envío.',
        max: ORDER_LIMITS.cityMax,
      })
      if (!city.ok) return refuse(city.message)
      const address = shippingPlace(extra.address, order.address, {
        subject: 'La dirección',
        missing: 'Escribe la dirección de envío.',
        max: ORDER_LIMITS.addressMax,
      })
      if (!address.ok) return refuse(address.message)

      return {
        ok: true,
        changed: true,
        patch: {
          status: 'shipped',
          shipped_at: at,
          carrier: carrier.value,
          tracking_number: tracking.value,
          ...(city.value !== undefined ? { city: city.value } : {}),
          ...(address.value !== undefined ? { address: address.value } : {}),
        },
        notice: 'shipped',
      }
    }

    case 'mark_delivered': {
      if (order.status === 'delivered') return blocked('El pedido ya fue entregado.')
      if (order.status === 'cancelled') return blocked('El pedido está cancelado.')
      return {
        ok: true,
        changed: true,
        patch: { status: 'delivered', delivered_at: at },
        notice: 'delivered',
      }
    }

    case 'cancel': {
      if (order.status === 'delivered') return blocked('Un pedido entregado no se puede cancelar.')
      if (order.status === 'cancelled') return blocked('El pedido ya está cancelado.')
      return {
        ok: true,
        changed: true,
        patch: { status: 'cancelled', cancelled_at: at },
        notice: null,
      }
    }

    default:
      return refuse('La acción no es válida.')
  }
}

// ------------------------------------------------------------
// Pipeline "Ventas"
// ------------------------------------------------------------

/**
 * Etapas del pipeline Ventas, en el orden en que se crean. Solo las que
 * `pipelineStageFor` usa: un pedido nuevo nace en "Pago pendiente" o
 * "Pagado", así que no hay etapa "Nuevo".
 */
export const SALES_STAGES = [
  'Pago pendiente',
  'Pagado',
  'Enviado',
  'Entregado',
  'Cancelado',
] as const
export type SalesStage = (typeof SALES_STAGES)[number]

/**
 * Estado del negocio (`deals.status`) que corresponde al pedido: un
 * pedido entregado es un negocio ganado, uno cancelado es perdido y el
 * resto sigue abierto. Así el tablero y sus totales no cuentan como
 * abiertos negocios que ya terminaron.
 */
export function dealStatusFor(order: Pick<OrderState, 'status'>): 'open' | 'won' | 'lost' {
  if (order.status === 'delivered') return 'won'
  if (order.status === 'cancelled') return 'lost'
  return 'open'
}

/** Etapa del negocio que corresponde al pedido (diseño §3.2). */
export function pipelineStageFor(order: OrderState): SalesStage {
  switch (order.status) {
    case 'cancelled':
      return 'Cancelado'
    case 'delivered':
      return 'Entregado'
    case 'shipped':
      return 'Enviado'
    default:
      return order.payment_status === 'paid' ? 'Pagado' : 'Pago pendiente'
  }
}
