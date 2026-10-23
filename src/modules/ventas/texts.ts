// ============================================================
// Textos de Ventas — español colombiano, tuteo, neutro.
//
// Todo el copy del módulo vive aquí (panel, formularios y avisos al
// cliente); no entra a los catálogos i18n del CRM, igual que la agenda.
// Funciones puras: sin base de datos ni red.
//
// Reglas del copy: nada de jerga técnica, nada de voseo ni "usted", no
// se nombra una ciudad ni un tipo de negocio (Ventas sirve a joyerías,
// ropa, comida, tiendas…) y no se promete nada que el producto no haga.
// ============================================================

import { formatPrice } from '@/verticals/agenda/agent/format'

import { toCents, type NoticeKind, type OrderStatus, type PaymentStatus } from './orders'

// ------------------------------------------------------------
// Dinero
// ------------------------------------------------------------

/**
 * Importe con símbolo. Pesos enteros sin decimales ('$150.000'); si hay
 * centavos se muestran con coma ('$12.000,50'). A diferencia de
 * `formatPrice` (que redondea al peso), aquí no se pierde ningún centavo.
 */
export function formatMoney(amount: number, currency: string): string {
  const cents = toCents(amount)
  const whole = Math.trunc(cents / 100)
  const rest = Math.abs(cents % 100)
  const base = formatPrice(whole, currency)
  return rest === 0 ? base : `${base},${String(rest).padStart(2, '0')}`
}

/** 'Pedido #1001' (lista, detalle y título del negocio en el pipeline). */
export const orderLabel = (number: number | string): string => `Pedido #${number}`
export const dealTitle = orderLabel

// ------------------------------------------------------------
// Avisos al cliente (diseño §3.5)
// ------------------------------------------------------------

/** Nombres de las plantillas de Meta (categoría utilidad). */
export const NOTICE_TEMPLATES: Readonly<Record<NoticeKind, string>> = Object.freeze({
  paid: 'pedido_pagado',
  shipped: 'pedido_enviado',
  delivered: 'pedido_entregado',
})

export interface NoticeContext {
  /** Consecutivo del pedido (1001, 1002…). */
  number: number
  businessName?: string | null
  carrier?: string | null
  trackingNumber?: string | null
}

/** Texto en una sola línea, sin espacios repetidos. */
const plain = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim()

/** Tope de una variable de plantilla (el nombre del negocio es el único sin tope propio). */
const TEMPLATE_PARAM_MAX = 60

/**
 * Variable de plantilla: Meta rechaza vacías, con saltos de línea,
 * tabulaciones o 4+ espacios seguidos. Se recorta a 60 puntos de código
 * (sin partir un emoji) y sin espacio al final.
 */
const templateParam = (value: string | null | undefined, fallback: string): string => {
  const text = Array.from(plain(value)).slice(0, TEMPLATE_PARAM_MAX).join('').trimEnd()
  return text || fallback
}

const FALLBACK_BUSINESS = 'tu tienda'
const FALLBACK_PARAM = '-'

/** Mensaje libre (ventana de 24 h abierta). */
export function buildNoticeText(kind: NoticeKind, ctx: NoticeContext): string {
  const n = ctx.number
  switch (kind) {
    case 'paid':
      return `¡Recibimos tu pago! Tu pedido #${n} está confirmado. Te avisamos cuando salga. 🙌`
    case 'shipped': {
      const carrier = plain(ctx.carrier)
      const tracking = plain(ctx.trackingNumber)
      const parts = [`Tu pedido #${n} salió 📦.`]
      if (carrier) parts.push(`Transportadora: ${carrier}.`)
      if (tracking) parts.push(`Guía: ${tracking}.`)
      return parts.join(' ')
    }
    case 'delivered':
      return `Tu pedido #${n} fue entregado. ¡Gracias por comprarnos! 🙌`
  }
}

/**
 * Variables del cuerpo de la plantilla, en el orden documentado:
 *   pedido_pagado     {{1}} negocio · {{2}} número
 *   pedido_enviado    {{1}} número · {{2}} transportadora · {{3}} guía
 *   pedido_entregado  {{1}} número
 */
export function buildNoticeTemplateParams(kind: NoticeKind, ctx: NoticeContext): string[] {
  const n = String(ctx.number)
  switch (kind) {
    case 'paid':
      return [templateParam(ctx.businessName, FALLBACK_BUSINESS), n]
    case 'shipped':
      return [
        n,
        templateParam(ctx.carrier, FALLBACK_PARAM),
        templateParam(ctx.trackingNumber, FALLBACK_PARAM),
      ]
    case 'delivered':
      return [n]
  }
}

export function buildNoticeTemplate(
  kind: NoticeKind,
  ctx: NoticeContext,
): { name: string; params: string[] } {
  return { name: NOTICE_TEMPLATES[kind], params: buildNoticeTemplateParams(kind, ctx) }
}

/**
 * Cuerpo de cada plantilla tal como se crea en WhatsApp Manager
 * (categoría utilidad, idioma `es`, sin encabezado, pie ni botones).
 * Es la fuente única del texto: docs/ventas.md y la bandeja lo usan.
 */
export const NOTICE_TEMPLATE_BODIES: Readonly<Record<NoticeKind, string>> = Object.freeze({
  paid: '¡Hola! {{1}} recibió tu pago. Tu pedido #{{2}} está confirmado y te avisamos cuando salga. 🙌',
  shipped: 'Tu pedido #{{1}} salió 📦. Transportadora: {{2}}. Guía: {{3}}.',
  delivered: 'Tu pedido #{{1}} fue entregado. ¡Gracias por comprarnos! 🙌',
})

/**
 * Lo que el cliente recibe de verdad con la plantilla: el cuerpo
 * documentado con las variables ya puestas. Es lo que se guarda como
 * texto del mensaje saliente para que la bandeja muestre lo enviado.
 * Una variable que falte queda como '-' (nunca queda un {{n}} a la vista).
 */
export function renderNoticeTemplateBody(kind: NoticeKind, params: readonly string[]): string {
  return NOTICE_TEMPLATE_BODIES[kind].replace(/\{\{(\d+)\}\}/g, (_match, n: string) => {
    const value = params[Number(n) - 1]
    return value && value.length > 0 ? value : FALLBACK_PARAM
  })
}

const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  paid: 'pago',
  shipped: 'envío',
  delivered: 'entrega',
}

/**
 * Línea del pedido: 'Aviso de pago mandado' / 'Aviso de pago: no se pudo
 * mandar'. null si no hubo aviso. ("Mandado" y no "enviado": en Ventas
 * "enviado" es el estado del paquete.)
 */
export function noticeStatusText(kind: NoticeKind | null, failed: boolean): string | null {
  if (!kind) return null
  const label = NOTICE_KIND_LABEL[kind]
  return failed ? `Aviso de ${label}: no se pudo mandar` : `Aviso de ${label} mandado`
}

// ------------------------------------------------------------
// Panel
// ------------------------------------------------------------

export const VENTAS_TEXTS = {
  title: 'Ventas',
  subtitle: 'Los pedidos que cierras por WhatsApp, del pago a la entrega.',
  loading: 'Cargando…',
  /** Tooltip de lo que un rol de solo lectura no puede hacer. */
  readOnly: (action: string) => `Solo lectura: tu rol no puede ${action}.`,
  notEnabledTitle: 'Módulo no habilitado',
  notEnabledBody:
    'El módulo de ventas no está activo para esta cuenta. Pídele a tu asesor de Shift Digital que lo active.',
  /** Mensajes del servidor que llegan a la pantalla. */
  errors: {
    notFound: 'No encontramos ese pedido.',
    moduleOff: 'El módulo de ventas no está activo para esta cuenta.',
    forbidden: 'Tu rol no puede hacer esto.',
    generic: 'No pudimos completar la acción. Inténtalo de nuevo.',
  },

  summary: {
    soldThisMonth: 'Vendido este mes',
    orders: 'Pedidos',
    pending: 'Por cobrar',
  },

  filters: {
    all: 'Todos',
    pendingPayment: 'Pago pendiente',
    toShip: 'Por enviar',
    shipped: 'Enviados',
    delivered: 'Entregados',
    cancelled: 'Cancelados',
  },
  searchPlaceholder: 'Buscar por número o cliente',

  empty: {
    title: 'Todavía no hay pedidos',
    body: 'Cuando cierres una venta, créala desde la conversación y aparecerá aquí.',
    filtered: 'No hay pedidos con este filtro.',
  },

  status: {
    new: 'Nuevo',
    shipped: 'Enviado',
    delivered: 'Entregado',
    cancelled: 'Cancelado',
  } satisfies Record<OrderStatus, string>,
  payment: {
    pending: 'Pago pendiente',
    paid: 'Pagado',
  } satisfies Record<PaymentStatus, string>,

  detail: {
    customer: 'Cliente',
    phone: 'Teléfono',
    items: 'Productos',
    subtotal: 'Subtotal',
    shipping: 'Envío',
    total: 'Total',
    city: 'Ciudad',
    address: 'Dirección',
    idNumber: 'Cédula',
    notes: 'Notas',
    carrier: 'Transportadora',
    tracking: 'Número de guía',
    createdAt: 'Creado',
    paidAt: 'Pagado',
    shippedAt: 'Enviado',
    deliveredAt: 'Entregado',
    cancelledAt: 'Cancelado',
    quantityTimes: (quantity: number | string) => `${quantity} ×`,
  },

  actions: {
    markPaid: 'Marcar pagado',
    markShipped: 'Marcar enviado',
    markDelivered: 'Marcar entregado',
    cancel: 'Cancelar pedido',
    viewDetail: 'Ver detalle',
    working: 'Guardando…',
    done: 'Listo.',
  },

  shipDialog: {
    title: 'Datos del envío',
    body: 'Con el aviso de envío prendido, se los mandamos al cliente por WhatsApp.',
    carrierLabel: 'Transportadora',
    carrierPlaceholder: 'Servientrega, Coordinadora, Envía…',
    trackingLabel: 'Número de guía',
    cityLabel: 'Ciudad de envío',
    addressLabel: 'Dirección de envío',
    placeHint: 'Si el pedido no tenía ciudad o dirección, complétalas para poder enviarlo.',
    submit: 'Marcar enviado',
    cancel: 'Volver',
  },

  cancelDialog: {
    title: (number: number | string) => `¿Cancelar el pedido #${number}?`,
    body: 'Un pedido cancelado no se puede reabrir; si hace falta, creas otro. Si el cliente ya pagó, el reembolso lo manejas tú.',
    confirm: 'Sí, cancelar',
    keep: 'No, volver',
  },

  createOrder: {
    open: 'Crear pedido',
    title: 'Crear pedido',
    customerFromContact: 'El nombre y el teléfono salen del contacto.',
    itemsTitle: 'Productos',
    productLabel: 'Producto',
    productPlaceholder: 'Ej. Anillo de oro 18k',
    quantityLabel: 'Cantidad',
    unitPriceLabel: 'Precio unitario',
    addLine: 'Agregar producto',
    removeLine: (n: number | string) => `Quitar producto ${n}`,
    shippingLabel: 'Envío',
    subtotalLabel: 'Subtotal',
    totalLabel: 'Total',
    cityLabel: 'Ciudad',
    addressLabel: 'Dirección',
    idNumberLabel: 'Cédula (opcional)',
    idNumberHint: 'Solo si el cliente te la da. No se muestra en las listas.',
    notesLabel: 'Notas',
    paidLabel: 'El cliente ya pagó',
    paidHint: 'Con el aviso de pago prendido, le avisamos al cliente que recibimos su pago.',
    submit: 'Guardar pedido',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    created: (number: number | string) => `Pedido #${number} creado.`,
  },

  contactOrders: {
    title: 'Pedidos de este contacto',
    empty: 'Este contacto todavía no tiene pedidos.',
    viewAll: 'Ver en Ventas',
  },

  settings: {
    title: 'Avisos al cliente',
    description: 'Mensajes automáticos de WhatsApp cuando cambia el estado de un pedido.',
    notifyPaid: 'Aviso de pago recibido',
    notifyShipped: 'Aviso de pedido enviado',
    notifyDelivered: 'Aviso de pedido entregado',
    saved: 'Cambios guardados.',
    adminOnly: 'Solo el dueño o un administrador puede cambiar los avisos.',
  },
} as const
