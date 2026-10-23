// ============================================================
// Repositorio de Ventas A — datos.
//
// Única puerta de escritura del módulo: las rutas validan con
// orders.ts y llaman aquí. Reglas:
//
//   - Dos clientes de Supabase, cada uno para lo suyo:
//       * `ctx.supabase` (el del usuario, con RLS): `create_order()`
//         y TODA lectura y escritura de `orders`. Así aplican la
//         política de UPDATE (agent+, misma cuenta) y los triggers de
//         la migración 054 (estado solo hacia delante, pago sin
//         reversa, marcas de tiempo fijadas por el servidor).
//       * `db` (service-role, `supabaseAdmin()`): pipeline, negocio y
//         líneas del pedido. Un agente no puede crear pipelines con
//         RLS (solo admin) y el pedido no debe depender de eso. Toda
//         consulta de `db` va filtrada por `account_id`.
//   - El pedido manda (diseño §3.2): el negocio del pipeline es un
//     reflejo best-effort. Si falla, se registra y el pedido se queda
//     como está. Nunca se deshace un pedido por un fallo del negocio.
//   - Los errores de PostgREST se lanzan tal cual (la ruta responde 500
//     genérico). Los de dominio son `SalesError`, con status HTTP, un
//     `code` legible por máquina y mensaje en español para la pantalla.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { AccountContext } from '@/lib/auth/account'
import { moduleNotActiveMessage } from '@/lib/modules/errors'

import {
  SALES_STAGES,
  applyOrderAction,
  dealStatusFor,
  pipelineStageFor,
  type NoticeKind,
  type OrderActionExtra,
  type OrderStatus,
  type PaymentStatus,
  type SalesStage,
  type ValidOrderCreate,
} from './orders'
import { dealTitle } from './texts'

// ------------------------------------------------------------
// Tipos
// ------------------------------------------------------------

/** Fila de `orders` (migración 054). */
export interface OrderRow {
  id: string
  account_id: string
  number: number
  contact_id: string | null
  customer_name: string
  customer_phone: string
  conversation_id: string | null
  deal_id: string | null
  subtotal: number
  shipping: number
  total: number
  currency: string
  payment_status: PaymentStatus
  status: OrderStatus
  city: string | null
  address: string | null
  id_number: string | null
  carrier: string | null
  tracking_number: string | null
  notes: string | null
  last_notice: NoticeKind | null
  last_notice_error: string | null
  created_by: string | null
  paid_at: string | null
  shipped_at: string | null
  delivered_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

/** Fila de `order_items`. */
export interface OrderItemRow {
  id: string
  order_id: string
  account_id: string
  name: string
  quantity: number
  unit_price: number
  position: number
}

export interface OrderWithItems extends OrderRow {
  items: OrderItemRow[]
}

export interface SalesSettings {
  notify_paid: boolean
  notify_shipped: boolean
  notify_delivered: boolean
}

export const SALES_SETTING_KEYS = ['notify_paid', 'notify_shipped', 'notify_delivered'] as const

/** Lo que el repositorio necesita del contexto de la ruta. */
export type SalesContext = Pick<AccountContext, 'supabase' | 'accountId' | 'userId'>

export type SalesErrorStatus = 400 | 403 | 404 | 409

/**
 * Código legible por máquina (la pantalla decide qué hacer sin leer el
 * texto): forbidden 403 · not_found 404 · invalid 400 · stale 409 (el
 * pedido cambió o la base lo rechazó por estado viejo) ·
 * invalid_transition 409 (el estado actual no admite la acción) ·
 * module_inactive 409.
 */
export type SalesErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'stale'
  | 'invalid_transition'
  | 'module_inactive'

/** Error de dominio con status HTTP, código y mensaje en español. */
export class SalesError extends Error {
  readonly status: SalesErrorStatus
  readonly code: SalesErrorCode
  constructor(status: SalesErrorStatus, code: SalesErrorCode, message: string) {
    super(message)
    this.name = 'SalesError'
    this.status = status
    this.code = code
  }
}

const MESSAGES = {
  forbidden: 'No tienes permiso para crear pedidos en esta cuenta.',
  notInAccount: 'El contacto o la conversación no existe en tu cuenta.',
  invalid: 'Los datos del pedido no son válidos. Revisa los productos, precios y el envío.',
  orderNotFound: 'No encontramos ese pedido.',
  orderChanged: 'El pedido cambió mientras lo editabas. Recarga la página e inténtalo de nuevo.',
} as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase()

/** Lanza el error de PostgREST (si lo hay) y devuelve los datos. */
function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error
  return result.data
}

// ------------------------------------------------------------
// Pipeline "Ventas"
// ------------------------------------------------------------

const PIPELINE_NAME = 'Ventas'

const STAGE_COLORS: Record<SalesStage, string> = {
  Nuevo: '#3b82f6',
  'Pago pendiente': '#f59e0b',
  Pagado: '#10b981',
  Enviado: '#8b5cf6',
  Entregado: '#16a34a',
  Cancelado: '#ef4444',
}

export interface SalesPipeline {
  pipelineId: string
  stageIdByName: Record<SalesStage, string>
}

/**
 * Deja listo el pipeline "Ventas" de la cuenta (nombre sin importar
 * mayúsculas ni espacios) con sus seis etapas. Idempotente y respetuoso:
 * crea lo que falta, nunca renombra, mueve ni borra lo que el dueño ya
 * tiene (las etapas propias se quedan; las que faltan se agregan al
 * final; "Nuevo" queda disponible para uso manual aunque ningún pedido
 * la use).
 *
 * Determinista: con varios pipelines "Ventas" gana el más antiguo
 * (created_at, id) y con etapas repetidas la de menor posición
 * (position, created_at, id).
 *
 * Límite conocido: sin una restricción única en la base, dos primeros
 * pedidos simultáneos podrían crear dos pipelines "Ventas". Es raro, no
 * pierde datos, el orden de arriba hace que ambos usen el mismo, y se
 * ve y se arregla desde el CRM.
 */
export async function ensureSalesPipeline(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<SalesPipeline> {
  const pipelines = unwrap(
    await db
      .from('pipelines')
      .select('id, name')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ) as { id: string; name: string }[] | null
  const found = (pipelines ?? []).find((row) => norm(row.name) === norm(PIPELINE_NAME))

  let pipelineId = found?.id
  if (!pipelineId) {
    pipelineId = crypto.randomUUID()
    unwrap(
      await db
        .from('pipelines')
        .insert({ id: pipelineId, account_id: accountId, user_id: userId, name: PIPELINE_NAME }),
    )
  }

  const stages = unwrap(
    await db
      .from('pipeline_stages')
      .select('id, name, position')
      .eq('pipeline_id', pipelineId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ) as { id: string; name: string; position: number | null }[] | null

  const idByNormName = new Map<string, string>()
  let nextPosition = 0
  for (const stage of stages ?? []) {
    if (!idByNormName.has(norm(stage.name))) idByNormName.set(norm(stage.name), stage.id)
    nextPosition = Math.max(nextPosition, (stage.position ?? -1) + 1)
  }

  const missing = SALES_STAGES.filter((name) => !idByNormName.has(norm(name)))
  if (missing.length > 0) {
    const rows = missing.map((name, index) => {
      const id = crypto.randomUUID()
      idByNormName.set(norm(name), id)
      return {
        id,
        pipeline_id: pipelineId,
        name,
        position: nextPosition + index,
        color: STAGE_COLORS[name],
      }
    })
    unwrap(await db.from('pipeline_stages').insert(rows))
  }

  const stageIdByName = Object.fromEntries(
    SALES_STAGES.map((name) => [name, idByNormName.get(norm(name)) as string]),
  ) as Record<SalesStage, string>
  return { pipelineId, stageIdByName }
}

// ------------------------------------------------------------
// Lecturas
// ------------------------------------------------------------

async function loadItems(
  db: SupabaseClient,
  accountId: string,
  orderId: string,
): Promise<OrderItemRow[]> {
  const rows = unwrap(
    await db
      .from('order_items')
      .select('*')
      .eq('order_id', orderId)
      .eq('account_id', accountId)
      .order('position', { ascending: true }),
  ) as OrderItemRow[] | null
  return rows ?? []
}

// ------------------------------------------------------------
// Negocio del pipeline (best-effort)
// ------------------------------------------------------------

/**
 * Crea el negocio del pedido en el pipeline Ventas y lo enlaza
 * (`orders.deal_id`). Si el enlace falla, borra el negocio recién creado
 * (best-effort, filtrado por cuenta) para no dejar uno huérfano en el
 * tablero, y relanza el error. El que llama lo registra y sigue: el
 * pedido no depende del negocio.
 */
async function createDealForOrder(
  db: SupabaseClient,
  ctx: Pick<SalesContext, 'accountId' | 'userId'>,
  order: OrderRow,
): Promise<string> {
  const { pipelineId, stageIdByName } = await ensureSalesPipeline(db, ctx.accountId, ctx.userId)
  const dealId = crypto.randomUUID()
  unwrap(
    await db.from('deals').insert({
      id: dealId,
      account_id: ctx.accountId,
      user_id: ctx.userId,
      pipeline_id: pipelineId,
      stage_id: stageIdByName[pipelineStageFor(order)],
      ...(order.contact_id ? { contact_id: order.contact_id } : {}),
      conversation_id: order.conversation_id,
      title: dealTitle(order.number),
      value: Number(order.total),
      currency: order.currency,
      status: dealStatusFor(order),
    }),
  )

  const link = await db
    .from('orders')
    .update({ deal_id: dealId })
    .eq('id', order.id)
    .eq('account_id', ctx.accountId)
  if (link.error) {
    try {
      const cleanup = await db.from('deals').delete().eq('id', dealId).eq('account_id', ctx.accountId)
      if (cleanup.error) {
        console.error(`[ventas] pedido ${order.number}: no se pudo borrar el negocio huérfano`, cleanup.error)
      }
    } catch (cleanupError) {
      console.error(`[ventas] pedido ${order.number}: no se pudo borrar el negocio huérfano`, cleanupError)
    }
    throw link.error
  }
  return dealId
}

/**
 * Pone el negocio del pedido donde le toca: etapa (si existe en su
 * pipeline y cambió) y estado (open / won / lost), en UN solo UPDATE.
 *
 * Decide con el pedido RELEÍDO (cliente del usuario), no con el parche
 * que acaba de guardar este request: si otra petición ya lo movió más
 * adelante, el negocio refleja el estado real y no uno viejo. Si el
 * dueño borró el negocio o la etapa, lo que se pueda se hace y el resto
 * se avisa en el log. Lanza ante un error de la base (el que llama lo
 * registra).
 */
async function moveDealForOrder(
  db: SupabaseClient,
  userDb: SupabaseClient,
  accountId: string,
  orderId: string,
  now: Date,
): Promise<void> {
  const fresh = unwrap(
    await userDb
      .from('orders')
      .select('number, status, payment_status, deal_id')
      .eq('id', orderId)
      .eq('account_id', accountId)
      .maybeSingle(),
  ) as Pick<OrderRow, 'number' | 'status' | 'payment_status' | 'deal_id'> | null
  if (!fresh?.deal_id) return

  const deal = unwrap(
    await db
      .from('deals')
      .select('id, pipeline_id, stage_id, status')
      .eq('id', fresh.deal_id)
      .eq('account_id', accountId)
      .maybeSingle(),
  ) as { id: string; pipeline_id: string; stage_id: string; status: string | null } | null
  if (!deal) {
    console.warn(`[ventas] el negocio ${fresh.deal_id} del pedido ${fresh.number} ya no existe`)
    return
  }

  const patch: Record<string, unknown> = {}

  const target = pipelineStageFor(fresh)
  const stages = unwrap(
    await db
      .from('pipeline_stages')
      .select('id, name')
      .eq('pipeline_id', deal.pipeline_id)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ) as { id: string; name: string }[] | null
  const stage = (stages ?? []).find((row) => norm(row.name) === norm(target))
  if (!stage) {
    console.warn(`[ventas] el pipeline del pedido ${fresh.number} no tiene la etapa "${target}"`)
  } else if (stage.id !== deal.stage_id) {
    patch.stage_id = stage.id
  }

  const status = dealStatusFor(fresh)
  if (deal.status !== status) patch.status = status

  if (Object.keys(patch).length === 0) return
  patch.updated_at = now.toISOString()

  unwrap(await db.from('deals').update(patch).eq('id', deal.id).eq('account_id', accountId))
}

// ------------------------------------------------------------
// Crear pedido
// ------------------------------------------------------------

/** Traduce el error de Postgres de `create_order()` a uno de dominio. */
function mapCreateOrderError(error: { code?: string; message?: string }): unknown {
  switch (error.code) {
    case '42501':
      return new SalesError(403, 'forbidden', MESSAGES.forbidden)
    case 'P0001':
      // P0001 es el código de cualquier RAISE EXCEPTION sin ERRCODE: solo
      // es "módulo apagado" si dice exactamente eso; si no, es un error real.
      if (String(error.message ?? '').includes(moduleNotActiveMessage('ventas'))) {
        return new SalesError(409, 'module_inactive', moduleNotActiveMessage('ventas'))
      }
      return error
    case '23503':
      return new SalesError(404, 'not_found', MESSAGES.notInAccount)
    case '23514':
    case '22023':
      return new SalesError(400, 'invalid', MESSAGES.invalid)
    default:
      return error
  }
}

/**
 * Crea el pedido con `create_order()` (atómico: pedido, líneas y
 * consecutivo) llamada con el cliente del usuario y después, si se
 * puede, su negocio en el pipeline Ventas. Devuelve el pedido con sus
 * líneas. El total lo calcula la función: aquí nunca se envía.
 */
export async function createOrder(
  db: SupabaseClient,
  ctx: SalesContext,
  input: ValidOrderCreate,
): Promise<OrderWithItems> {
  const { data, error } = await ctx.supabase.rpc('create_order', {
    p_account_id: ctx.accountId,
    p_contact_id: input.contactId,
    p_conversation_id: input.conversationId,
    p_items: input.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
    p_shipping: input.shipping,
    p_paid: input.paid,
    p_fields: {
      city: input.city,
      address: input.address,
      id_number: input.idNumber,
      notes: input.notes,
    },
  })
  if (error) throw mapCreateOrderError(error)

  let order = (Array.isArray(data) ? data[0] : data) as OrderRow | null
  if (!order) throw new Error('create_order no devolvió el pedido')

  // El pedido ya existe: de aquí en adelante nada puede tumbar la respuesta.
  try {
    const dealId = await createDealForOrder(db, ctx, order)
    order = { ...order, deal_id: dealId }
  } catch (err) {
    console.error(`[ventas] pedido ${order.number}: no se pudo crear el negocio`, err)
  }

  let items: OrderItemRow[]
  try {
    items = await loadItems(db, ctx.accountId, order.id)
  } catch (err) {
    console.error(`[ventas] pedido ${order.number}: no se pudieron leer las líneas`, err)
    items = input.items.map((item, position) => ({
      id: `${order.id}:${position}`,
      order_id: order.id,
      account_id: ctx.accountId,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      position,
    }))
  }
  return { ...order, items }
}

// ------------------------------------------------------------
// Cambiar el estado
// ------------------------------------------------------------

export interface UpdateOrderResult {
  order: OrderWithItems
  /** false = no había nada que hacer (marcar pagado un pedido ya pagado). */
  changed: boolean
  /** Aviso que corresponde mandar al cliente; null si no hay o no cambió nada. */
  notice: NoticeKind | null
}

/**
 * Aplica una acción al pedido de la cuenta: carga, valida con las reglas
 * puras, guarda y mueve el negocio. Sin cambios no escribe nada.
 *
 * El pedido se lee y se guarda con el cliente del usuario: la RLS y los
 * triggers de 054 aplican de verdad. El UPDATE solo prospera si el
 * pedido sigue en el estado que se leyó (control optimista), y eso se
 * reporta como 409 `stale` en dos casos que significan lo mismo, "tu
 * vista está vieja":
 *   - 0 filas actualizadas (otra petición lo cambió entre la lectura y
 *     la escritura: dos clics en "marcar pagado" no guardan ni avisan
 *     dos veces);
 *   - 42501 de la base (el guarda de 054 rechazó una transición que ya
 *     no es válida, o la RLS ya no deja escribir). Se registra en el log
 *     porque también podría ser un permiso quitado a mitad de camino.
 *
 * Rechazos del dominio: los que dependen del estado actual del pedido
 * (ya enviado, entregado, cancelado) son 409 `invalid_transition`; los
 * de datos faltantes o mal escritos, 400 `invalid`.
 */
export async function updateOrderStatus(
  db: SupabaseClient,
  ctx: Pick<SalesContext, 'supabase' | 'accountId'>,
  orderId: string,
  action: string,
  extra: OrderActionExtra = {},
  now: Date = new Date(),
): Promise<UpdateOrderResult> {
  if (!UUID_RE.test(orderId)) throw new SalesError(404, 'not_found', MESSAGES.orderNotFound)

  const current = unwrap(
    await ctx.supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('account_id', ctx.accountId)
      .maybeSingle(),
  ) as OrderRow | null
  if (!current) throw new SalesError(404, 'not_found', MESSAGES.orderNotFound)

  const result = applyOrderAction(current, action, extra, now)
  if (!result.ok) {
    throw result.reason === 'transition'
      ? new SalesError(409, 'invalid_transition', result.message)
      : new SalesError(400, 'invalid', result.message)
  }

  const items = await loadItems(db, ctx.accountId, current.id)
  if (!result.changed) {
    return { order: { ...current, items }, changed: false, notice: null }
  }

  const { data: updated, error } = await ctx.supabase
    .from('orders')
    .update(result.patch)
    .eq('id', current.id)
    .eq('account_id', ctx.accountId)
    .eq('status', current.status)
    .eq('payment_status', current.payment_status)
    .select()
    .maybeSingle()
  if (error) {
    if ((error as { code?: string }).code === '42501') {
      console.error(
        `[ventas] pedido ${current.number}: la base rechazó el cambio (guarda de estado o permisos)`,
        error,
      )
      throw new SalesError(409, 'stale', MESSAGES.orderChanged)
    }
    throw error
  }
  if (!updated) throw new SalesError(409, 'stale', MESSAGES.orderChanged)

  try {
    await moveDealForOrder(db, ctx.supabase, ctx.accountId, current.id, now)
  } catch (err) {
    console.error(`[ventas] pedido ${current.number}: no se pudo mover el negocio`, err)
  }

  return { order: { ...(updated as OrderRow), items }, changed: true, notice: result.notice }
}

// ------------------------------------------------------------
// Ajustes de avisos
// ------------------------------------------------------------

/** Sin fila (o con una columna ausente) los avisos están prendidos, como en la base. */
export async function getSalesSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<SalesSettings> {
  const row = unwrap(
    await db
      .from('sales_settings')
      .select('notify_paid, notify_shipped, notify_delivered')
      .eq('account_id', accountId)
      .maybeSingle(),
  ) as Partial<SalesSettings> | null
  return {
    notify_paid: row?.notify_paid ?? true,
    notify_shipped: row?.notify_shipped ?? true,
    notify_delivered: row?.notify_delivered ?? true,
  }
}

/**
 * Guarda los interruptores enviados (parcial: lo que no viene no se
 * toca) y devuelve los ajustes completos. Crea la fila si no existe.
 */
export async function saveSalesSettings(
  db: SupabaseClient,
  accountId: string,
  patch: Partial<SalesSettings>,
): Promise<SalesSettings> {
  const changes: Partial<SalesSettings> = {}
  for (const key of SALES_SETTING_KEYS) {
    if (typeof patch[key] === 'boolean') changes[key] = patch[key]
  }
  unwrap(
    await db
      .from('sales_settings')
      .upsert({ account_id: accountId, ...changes }, { onConflict: 'account_id' }),
  )
  return getSalesSettings(db, accountId)
}
