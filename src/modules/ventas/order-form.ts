// ============================================================
// Borrador del formulario "Crear pedido" (inbox) — lógica pura.
//
// Los campos se guardan como texto (lo que la persona escribe) y se
// convierten al cuerpo de POST /api/modules/ventas/orders solo al
// guardar. La validación es la MISMA del servidor (`validateOrderCreate`):
// aquí solo se adelanta el mensaje para no hacer un viaje en vano.
// El total que se muestra es de muestra; el servidor lo recalcula.
// ============================================================

import {
  ORDER_LIMITS,
  orderTotals,
  validateOrderCreate,
  type OrderTotals,
  type ValidOrderCreate,
} from './orders'

export interface OrderDraftLine {
  /** Clave estable para React (no viaja al servidor). */
  key: string
  name: string
  quantity: string
  unitPrice: string
}

export interface OrderDraft {
  lines: OrderDraftLine[]
  shipping: string
  city: string
  address: string
  idNumber: string
  notes: string
  paid: boolean
}

let lineSeq = 0
const nextKey = (): string => {
  lineSeq += 1
  return `line-${lineSeq}`
}

const emptyLine = (): OrderDraftLine => ({ key: nextKey(), name: '', quantity: '1', unitPrice: '' })

export function emptyOrderDraft(): OrderDraft {
  return {
    lines: [emptyLine()],
    shipping: '',
    city: '',
    address: '',
    idNumber: '',
    notes: '',
    paid: false,
  }
}

/** Agrega una línea vacía; no pasa del máximo del dominio. */
export function addDraftLine(draft: OrderDraft): OrderDraft {
  if (draft.lines.length >= ORDER_LIMITS.itemsMax) return draft
  return { ...draft, lines: [...draft.lines, emptyLine()] }
}

/** Quita una línea; siempre queda al menos una. */
export function removeDraftLine(draft: OrderDraft, key: string): OrderDraft {
  if (draft.lines.length <= ORDER_LIMITS.itemsMin) return draft
  return { ...draft, lines: draft.lines.filter((line) => line.key !== key) }
}

export function updateDraftLine(
  draft: OrderDraft,
  key: string,
  patch: Partial<Omit<OrderDraftLine, 'key'>>,
): OrderDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
  }
}

// ------------------------------------------------------------
// Números escritos a mano
// ------------------------------------------------------------

const GROUPED = (sep: string) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`)

/**
 * Importe como lo escribe la gente en Colombia: '150.000', '12.000,50',
 * '1,5'. También tolera '1,234.56'. Reglas: con punto y coma a la vez,
 * el último es el decimal; con un solo separador repetido son miles; con
 * uno solo, seguido de exactamente 3 dígitos son miles y si no, decimal.
 * Vacío → null. Texto ilegible o negativo → NaN (el dominio lo rechaza
 * con su mensaje).
 */
export function parseAmountInput(raw: string): number | null {
  const text = raw.replace(/[\s$]/g, '')
  if (!text) return null
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return Number.NaN

  const hasDot = text.includes('.')
  const hasComma = text.includes(',')
  let normalized: string

  if (hasDot && hasComma) {
    const decimal = text.lastIndexOf('.') > text.lastIndexOf(',') ? '.' : ','
    const thousands = decimal === '.' ? ',' : '.'
    const [whole, fraction, ...rest] = text.split(decimal)
    if (rest.length > 0 || !GROUPED(thousands).test(whole)) return Number.NaN
    normalized = `${whole.split(thousands).join('')}.${fraction}`
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ','
    const parts = text.split(sep)
    if (parts.length > 2) {
      if (!GROUPED(sep).test(text)) return Number.NaN
      normalized = parts.join('')
    } else if (parts[1].length === 3 && parts[0].length > 0) {
      normalized = parts.join('')
    } else {
      normalized = `${parts[0] || '0'}.${parts[1]}`
    }
  } else {
    normalized = text
  }

  const value = Number(normalized)
  return Number.isFinite(value) ? value : Number.NaN
}

/** Cantidad entera; cualquier otra cosa es NaN. */
export function parseQuantityInput(raw: string): number {
  const text = raw.trim()
  return /^\d+$/.test(text) ? Number(text) : Number.NaN
}

// ------------------------------------------------------------
// Total de muestra
// ------------------------------------------------------------

const orZero = (value: number | null): number =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : 0

/** Total en vivo: una línea a medio escribir cuenta como cero. */
export function draftTotals(draft: OrderDraft): OrderTotals {
  const items = draft.lines.map((line) => {
    const quantity = parseQuantityInput(line.quantity)
    return {
      quantity: Number.isFinite(quantity) ? quantity : 0,
      unitPrice: orZero(parseAmountInput(line.unitPrice)),
    }
  })
  return orderTotals(items, orZero(parseAmountInput(draft.shipping)))
}

// ------------------------------------------------------------
// Cuerpo de la petición
// ------------------------------------------------------------

export type OrderFormField =
  | 'name'
  | 'quantity'
  | 'unitPrice'
  | 'shipping'
  | 'city'
  | 'address'
  | 'idNumber'
  | 'notes'
  | 'lines'

export type OrderRequestResult =
  | { ok: true; value: ValidOrderCreate }
  | { ok: false; message: string; field?: OrderFormField; line?: number }

/** Campo al que apunta un mensaje del dominio (para marcarlo y enfocarlo). */
function locate(message: string): { field?: OrderFormField; line?: number } {
  const item = /^Producto (\d+):\s*(.*)$/.exec(message)
  if (item) {
    const line = Number(item[1]) - 1
    const rest = item[2]
    if (/cantidad/i.test(rest)) return { field: 'quantity', line }
    if (/precio/i.test(rest)) return { field: 'unitPrice', line }
    return { field: 'name', line }
  }
  if (/^El envío/.test(message)) return { field: 'shipping' }
  if (/^La ciudad/.test(message)) return { field: 'city' }
  if (/^La dirección/.test(message)) return { field: 'address' }
  if (/^La cédula/.test(message)) return { field: 'idNumber' }
  if (/^Las notas/.test(message)) return { field: 'notes' }
  if (/producto/i.test(message)) return { field: 'lines' }
  return {}
}

/**
 * Convierte el borrador en el cuerpo de "crear pedido" y lo pasa por la
 * validación del servidor. Nunca incluye el total. Nombre y teléfono no
 * se piden: salen del contacto en la base.
 */
export function buildOrderRequest(
  draft: OrderDraft,
  contactId: string,
  conversationId: string | null,
): OrderRequestResult {
  const shipping = parseAmountInput(draft.shipping)
  const body = {
    contactId,
    conversationId,
    items: draft.lines.map((line) => ({
      name: line.name,
      quantity: parseQuantityInput(line.quantity),
      // Vacío → NaN: el dominio responde "el precio debe ser un número".
      unitPrice: parseAmountInput(line.unitPrice) ?? Number.NaN,
    })),
    shipping: shipping ?? 0,
    paid: draft.paid,
    city: draft.city,
    address: draft.address,
    idNumber: draft.idNumber,
    notes: draft.notes,
  }

  const result = validateOrderCreate(body)
  if (!result.ok) return { ok: false, message: result.message, ...locate(result.message) }
  return { ok: true, value: result.value }
}
