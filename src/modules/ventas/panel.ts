// ============================================================
// Lógica pura de las pantallas de Ventas (/ventas y el inbox).
//
// Sin React, sin base de datos y sin red: resumen del mes en hora de
// Colombia, filtros, búsqueda, qué acciones admite un pedido y cómo se
// le explica a la persona un error o el resultado de un aviso. Las
// reglas de negocio NO se repiten aquí: las acciones disponibles se
// preguntan a `applyOrderAction` y "vendido" a `isCountedSale`.
// ============================================================

import { formatDayLabel, formatLongDate, formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts, zonedTimeToUtc } from '@/verticals/agenda/agent/time'

import {
  ORDER_ACTIONS,
  SALES_TIME_ZONE,
  applyOrderAction,
  isCountedSale,
  toCents,
  type NoticeKind,
  type OrderAction,
} from './orders'
import type { OrderRow } from './repo'
import { VENTAS_TEXTS as T, formatMoney, noticeStatusText } from './texts'

/** Lo que las listas leen de cada pedido (nunca la cédula). */
export type PanelOrder = Pick<
  OrderRow,
  | 'id'
  | 'number'
  | 'customer_name'
  | 'customer_phone'
  | 'total'
  | 'currency'
  | 'payment_status'
  | 'status'
  | 'city'
  | 'address'
  | 'carrier'
  | 'tracking_number'
  | 'last_notice'
  | 'last_notice_error'
  | 'paid_at'
  | 'created_at'
>

/** Columnas de `orders` para las listas: sin `id_number` a propósito (lo prueba panel.test.ts). */
export const PANEL_ORDER_COLUMNS =
  'id, number, customer_name, customer_phone, total, currency, payment_status, status, city, address, carrier, tracking_number, last_notice, last_notice_error, paid_at, created_at'

// ------------------------------------------------------------
// Mes en hora de Colombia
// ------------------------------------------------------------

/** 'YYYY-MM' del instante en la zona de ventas. */
function monthKey(instant: Date, tz: string): string {
  return zonedParts(instant, tz).dateKey.slice(0, 7)
}

/** Primer instante (00:00 del día 1) del mes de `now` en la zona de ventas. */
export function salesMonthStart(now: Date, tz: string = SALES_TIME_ZONE): Date {
  return zonedTimeToUtc(`${monthKey(now, tz)}-01`, '00:00', tz)
}

/**
 * Fecha y hora de un pedido en la zona de ventas: 'mar 20 oct, 8:30 p. m.'
 * (lista) o 'martes 20 de octubre de 2026, 8:30 p. m.' (detalle). null si
 * no hay fecha o no se puede leer.
 */
export function formatOrderDate(
  iso: string | null | undefined,
  style: 'short' | 'long' = 'short',
  tz: string = SALES_TIME_ZONE,
): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = zonedParts(date, tz)
  const day = style === 'long' ? formatLongDate(parts.dateKey) : formatDayLabel(parts.dateKey)
  return `${day}, ${formatTimeLabel(parts)}`
}

const inMonth = (iso: string | null | undefined, key: string, tz: string): boolean => {
  if (!iso) return false
  const date = new Date(iso)
  return !Number.isNaN(date.getTime()) && monthKey(date, tz) === key
}

// ------------------------------------------------------------
// Resumen
// ------------------------------------------------------------

/** Importe en centavos enteros de una moneda. */
export interface MoneyAmount {
  currency: string
  cents: number
}

export interface SalesSummary {
  /** Pagados (y no cancelados) cuyo `paid_at` cae en el mes. */
  soldThisMonth: MoneyAmount[]
  /** Creados en el mes, sin cancelados. */
  ordersThisMonth: number
  /** Sin pagar y no cancelados, de cualquier fecha. */
  pendingToCollect: MoneyAmount[]
}

type SummaryOrder = Pick<PanelOrder, 'status' | 'payment_status' | 'total' | 'currency' | 'paid_at' | 'created_at'>

/** Columnas mínimas para el resumen. */
export const SUMMARY_ORDER_COLUMNS = 'status, payment_status, total, currency, paid_at, created_at'

function addAmount(map: Map<string, number>, currency: string, total: unknown): void {
  const value = Number(total)
  if (!Number.isFinite(value)) return
  const code = (currency || '').toUpperCase()
  map.set(code, (map.get(code) ?? 0) + toCents(value))
}

/** Montos por moneda, la de la cuenta primero y el resto por código. */
function toAmounts(map: Map<string, number>, preferred: string | null): MoneyAmount[] {
  return [...map.entries()]
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => {
      if (preferred && a.currency === preferred) return -1
      if (preferred && b.currency === preferred) return 1
      return a.currency.localeCompare(b.currency)
    })
}

/**
 * Resumen del mes de `now` en hora de Colombia. Cada moneda se suma por
 * separado (nunca se mezclan pesos con dólares).
 */
export function salesSummary(
  orders: readonly SummaryOrder[],
  now: Date,
  preferredCurrency: string | null = null,
  tz: string = SALES_TIME_ZONE,
): SalesSummary {
  const key = monthKey(now, tz)
  const sold = new Map<string, number>()
  const pending = new Map<string, number>()
  let ordersThisMonth = 0

  for (const order of orders) {
    if (isCountedSale(order) && inMonth(order.paid_at, key, tz)) {
      addAmount(sold, order.currency, order.total)
    }
    if (order.status !== 'cancelled') {
      if (inMonth(order.created_at, key, tz)) ordersThisMonth += 1
      if (order.payment_status === 'pending') addAmount(pending, order.currency, order.total)
    }
  }

  const preferred = preferredCurrency?.toUpperCase() ?? null
  return {
    soldThisMonth: toAmounts(sold, preferred),
    ordersThisMonth,
    pendingToCollect: toAmounts(pending, preferred),
  }
}

/**
 * '$150.000'; con varias monedas cada una lleva su código ISO
 * ('$20.000 COP + $10 MXN'), porque varias comparten el símbolo '$'.
 * Sin montos, cero en la moneda de la cuenta.
 */
export function formatAmounts(amounts: readonly MoneyAmount[], fallbackCurrency: string): string {
  if (amounts.length === 0) return formatMoney(0, fallbackCurrency)
  if (amounts.length === 1) return formatMoney(amounts[0].cents / 100, amounts[0].currency)
  return amounts.map((a) => `${formatMoney(a.cents / 100, a.currency)} ${a.currency}`).join(' + ')
}

/** Tope de filas que se leen para el resumen (ver `isSummaryTruncated`). */
export const SUMMARY_LIMIT = 1000

/** El resumen llegó al tope: las cifras pueden estar incompletas. */
export function isSummaryTruncated(rowCount: number, limit: number = SUMMARY_LIMIT): boolean {
  return rowCount >= limit
}

// ------------------------------------------------------------
// Filtros y búsqueda
// ------------------------------------------------------------

/** Mismo orden y claves que `VENTAS_TEXTS.filters`. */
export const ORDER_FILTERS = [
  'all',
  'pendingPayment',
  'toShip',
  'shipped',
  'delivered',
  'cancelled',
] as const
export type OrderFilter = (typeof ORDER_FILTERS)[number]

export const isOrderFilter = (value: unknown): value is OrderFilter =>
  typeof value === 'string' && (ORDER_FILTERS as readonly string[]).includes(value)

export function matchesOrderFilter(
  order: Pick<PanelOrder, 'status' | 'payment_status'>,
  filter: OrderFilter,
): boolean {
  switch (filter) {
    case 'pendingPayment':
      // Incluye la contraentrega: enviado (o entregado) y aún sin cobrar.
      return order.payment_status === 'pending' && order.status !== 'cancelled'
    case 'toShip':
      return order.payment_status === 'paid' && order.status === 'new'
    case 'shipped':
      return order.status === 'shipped'
    case 'delivered':
      return order.status === 'delivered'
    case 'cancelled':
      return order.status === 'cancelled'
    default:
      return true
  }
}

/** Minúsculas, sin tildes y con espacios simples. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const digitsOf = (text: string): string => text.replace(/\D/g, '')

/**
 * Busca por número de pedido (con o sin '#'), nombre del cliente (sin
 * importar tildes ni mayúsculas) o teléfono (solo dígitos).
 */
export function matchesOrderSearch(
  order: Pick<PanelOrder, 'number' | 'customer_name' | 'customer_phone'>,
  query: string,
): boolean {
  const q = normalize(query)
  if (!q) return true
  if (normalize(order.customer_name ?? '').includes(q)) return true

  const digits = digitsOf(q)
  const onlyNumberish = /^[#+\d\s().-]+$/.test(q)
  if (!digits || !onlyNumberish) return false
  if (String(order.number).includes(digits)) return true
  const phone = digitsOf(order.customer_phone ?? '')
  // Un número corto (1-3 dígitos) se busca solo en el consecutivo.
  return digits.length >= 4 && phone.includes(digits)
}

const createdMs = (order: Pick<PanelOrder, 'created_at'>): number => {
  const ms = new Date(order.created_at).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/** Filtra y busca; el más reciente primero. No muta la lista. */
export function filterOrders<T extends PanelOrder>(
  orders: readonly T[],
  filter: OrderFilter,
  query: string,
): T[] {
  return orders
    .filter((order) => matchesOrderFilter(order, filter) && matchesOrderSearch(order, query))
    .sort((a, b) => createdMs(b) - createdMs(a) || b.number - a.number)
}

// ------------------------------------------------------------
// Acciones
// ------------------------------------------------------------

/**
 * Acciones que tienen sentido para el pedido, preguntándole al dominio:
 * se muestra la acción si `applyOrderAction` la acepta y cambia algo, o
 * si solo la rechaza por datos que el diálogo pedirá (transportadora,
 * guía, ciudad o dirección). Un rechazo por el estado actual la oculta.
 */
export function availableOrderActions(
  order: Pick<PanelOrder, 'status' | 'payment_status' | 'city' | 'address'>,
): OrderAction[] {
  return ORDER_ACTIONS.filter((action) => {
    const result = applyOrderAction(order, action)
    return result.ok ? result.changed : result.reason === 'invalid'
  })
}

/** Qué datos de envío le faltan al pedido para poder marcarlo enviado. */
export function missingShippingPlace(
  order: Pick<PanelOrder, 'city' | 'address'>,
): { city: boolean; address: boolean } {
  return {
    city: !order.city?.trim(),
    address: !order.address?.trim(),
  }
}

// ------------------------------------------------------------
// Errores y avisos
// ------------------------------------------------------------

/** Error de una llamada a /api/modules/ventas/*. status 0 = no hubo respuesta. */
export interface SalesApiFailure {
  status: number
  code?: string | null
  error?: string | null
}

/**
 * Mensaje para la pantalla. Los de datos (400) y de transición los
 * escribe el dominio en español y se muestran tal cual; el resto se
 * traduce por código. Nunca se muestra un detalle técnico de un 500.
 */
export function salesErrorMessage(failure: SalesApiFailure): string {
  const { status, code } = failure
  const message = failure.error?.trim() || null
  if (status === 0) return T.errors.network
  switch (code) {
    case 'invalid':
      return message ?? T.errors.invalid
    case 'invalid_transition':
      return message ?? T.errors.generic
    case 'stale':
      return T.errors.stale
    case 'forbidden':
      return T.errors.forbidden
    case 'not_found':
      return T.errors.notFound
    case 'module_inactive':
      return T.errors.moduleOff
    case 'unauthorized':
      return T.errors.session
  }
  if (status === 401) return T.errors.session
  if (status === 403) return T.errors.forbidden
  if (status === 404) return T.errors.notFound
  // toModuleErrorResponse responde 409 sin `code` si el módulo está apagado.
  if (status === 409 && message && /no está activo/i.test(message)) return T.errors.moduleOff
  if (status === 400) return message ?? T.errors.invalid
  return T.errors.generic
}

export type NoticeOutcome = 'sent' | 'skipped' | 'failed'

export type NoticeResult = { tone: 'success' | 'warning'; text: string }

/** Qué decir del aviso tras guardar: 'sent' y 'failed' se cuentan; el resto no. */
export function noticeResult(
  notice: NoticeOutcome | null | undefined,
  order: Pick<PanelOrder, 'last_notice_error'>,
): NoticeResult | null {
  if (notice === 'sent') return { tone: 'success', text: T.notice.sent }
  if (notice === 'failed') return { tone: 'warning', text: T.notice.failed(order.last_notice_error) }
  return null
}

const NOTICE_KINDS: readonly NoticeKind[] = ['paid', 'shipped', 'delivered']

/** Estado del último aviso guardado en el pedido (lista y detalle). */
export function orderNoticeLine(
  order: Pick<PanelOrder, 'last_notice' | 'last_notice_error'>,
): { failed: boolean; text: string; reason: string | null } | null {
  const kind = order.last_notice
  if (!kind || !NOTICE_KINDS.includes(kind)) return null
  const reason = order.last_notice_error?.trim() || null
  const text = noticeStatusText(kind, reason !== null)
  return text ? { failed: reason !== null, text, reason } : null
}

// ------------------------------------------------------------
// Resultado de una acción sobre un pedido
// ------------------------------------------------------------

/** Mensaje arriba de la lista tras una acción. */
export type ActionFeedback =
  | { kind: 'notice'; result: NoticeResult }
  | { kind: 'error'; text: string }

/** Respuesta de PATCH /orders/[id] tal como la entrega api-client. */
export type ActionResponse =
  | { ok: true; data: { order: PanelOrder; notice: NoticeOutcome | null } }
  | { ok: false; status: number; code: string | null; message: string }

export type ActionOutcome =
  | { ok: true; order: PanelOrder; closeDialog: true; reload: false; feedback: ActionFeedback }
  | {
      ok: false
      /** false = el error es de datos y se corrige en el mismo diálogo. */
      closeDialog: boolean
      /** El pedido cambió por otro lado: hay que releer la lista. */
      reload: boolean
      dialogError: string | null
      feedback: ActionFeedback | null
    }

/** Solo las columnas de la lista (la respuesta trae la fila completa y las líneas). */
export function toPanelOrder(row: PanelOrder): PanelOrder {
  return {
    id: row.id,
    number: row.number,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    total: row.total,
    currency: row.currency,
    payment_status: row.payment_status,
    status: row.status,
    city: row.city,
    address: row.address,
    carrier: row.carrier,
    tracking_number: row.tracking_number,
    last_notice: row.last_notice,
    last_notice_error: row.last_notice_error,
    paid_at: row.paid_at,
    created_at: row.created_at,
  }
}

const RELOAD_CODES = new Set(['stale', 'invalid_transition', 'not_found'])

/**
 * Qué hace la pantalla con la respuesta de una acción:
 *   - éxito: actualiza el pedido, cierra el diálogo y cuenta el aviso;
 *   - 400 dentro de un diálogo (transportadora, guía…): el error queda en
 *     el diálogo, que sigue abierto para corregir;
 *   - el pedido cambió por otro lado (stale, transición, no existe):
 *     recarga la lista y lo dice arriba;
 *   - cualquier otro error (o un 400 de un clic): mensaje arriba.
 */
export function actionOutcome(res: ActionResponse, opts: { inDialog: boolean }): ActionOutcome {
  if (!res.ok) {
    if (res.code === 'invalid' && opts.inDialog) {
      return { ok: false, closeDialog: false, reload: false, dialogError: res.message, feedback: null }
    }
    return {
      ok: false,
      closeDialog: true,
      reload: RELOAD_CODES.has(res.code ?? ''),
      dialogError: null,
      feedback: { kind: 'error', text: res.message },
    }
  }

  const order = toPanelOrder(res.data.order)
  const notice = noticeResult(res.data.notice, order)
  const done = T.actions.updated(order.number)
  const result: NoticeResult =
    notice?.tone === 'warning'
      ? notice
      : { tone: 'success', text: notice ? `${done} ${notice.text}` : done }
  return { ok: true, order, closeDialog: true, reload: false, feedback: { kind: 'notice', result } }
}
