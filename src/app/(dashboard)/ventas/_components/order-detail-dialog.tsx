'use client'

// ============================================================
// Detalle de un pedido: líneas, totales, datos de envío, historial y el
// estado del último aviso al cliente (con el motivo si falló).
//
// Es el ÚNICO lugar donde se lee y se muestra la cédula: se pide aquí,
// con el cliente del usuario (RLS: miembros de la cuenta) y filtrado por
// la cuenta, al abrir. El estado guarda de qué pedido es, así nunca se
// muestra el cuerpo del pedido anterior mientras carga el nuevo.
// ============================================================

import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { OrderStatusBadges } from '@/components/ventas/order-badges'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { formatOrderDate, orderNoticeLine, type PanelOrder } from '@/modules/ventas/panel'
import { fetchOrderDetail, type OrderDetail } from '@/modules/ventas/queries'
import { VENTAS_TEXTS, formatMoney } from '@/modules/ventas/texts'

const T = VENTAS_TEXTS.detail

type Detail = OrderDetail

type DetailState =
  | { orderId: string | null; kind: 'loading' }
  | { orderId: string; kind: 'failed' }
  | { orderId: string; kind: 'ready'; order: Detail }

function Field({ label, value, note }: { label: string; value: string | null; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-sm break-words', value ? 'text-foreground' : 'text-muted-foreground')}>
        {value || T.empty}
      </dd>
      {note && value && <dd className="mt-0.5 text-xs text-muted-foreground">{note}</dd>}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
}

export function OrderDetailBody({ order }: { order: Detail }) {
  const money = (value: number | string) => formatMoney(Number(value), order.currency)
  const notice = orderNoticeLine(order)
  const timeline: Array<[string, string | null]> = [
    [T.createdAt, order.created_at],
    [T.paidAt, order.paid_at],
    [T.shippedAt, order.shipped_at],
    [T.deliveredAt, order.delivered_at],
    [T.cancelledAt, order.cancelled_at],
  ]

  return (
    <div className="grid gap-5">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label={T.customer} value={order.customer_name} />
        <Field label={T.phone} value={order.customer_phone} />
      </dl>

      <section className="grid gap-2" aria-labelledby={`items-${order.id}`}>
        <SectionTitle>
          <span id={`items-${order.id}`}>{T.items}</span>
        </SectionTitle>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm break-words text-foreground">{item.name}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {T.quantityTimes(item.quantity)} {money(item.unit_price)}
                </p>
              </div>
              <p className="shrink-0 text-sm tabular-nums text-foreground">
                {money(Number(item.quantity) * Number(item.unit_price))}
              </p>
            </li>
          ))}
        </ul>
        <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{T.subtotal}</dt>
          <dd className="text-right tabular-nums">{money(order.subtotal)}</dd>
          <dt className="text-muted-foreground">{T.shipping}</dt>
          <dd className="text-right tabular-nums">{money(order.shipping)}</dd>
          <dt className="border-t border-border pt-1 font-medium">{T.total}</dt>
          <dd className="border-t border-border pt-1 text-right font-semibold tabular-nums">
            {money(order.total)}
          </dd>
        </dl>
      </section>

      <section className="grid gap-2">
        <SectionTitle>{T.shippingData}</SectionTitle>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label={T.city} value={order.city} />
          <Field label={T.address} value={order.address} />
          <Field label={T.carrier} value={order.carrier} />
          <Field label={T.tracking} value={order.tracking_number} />
          <Field label={T.idNumber} value={order.id_number} note={T.idNumberNote} />
        </dl>
        {order.notes && (
          <dl>
            <Field label={T.notes} value={order.notes} />
          </dl>
        )}
      </section>

      <section className="grid gap-2">
        <SectionTitle>{T.noticeTitle}</SectionTitle>
        {notice ? (
          <div
            className={cn(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
              notice.failed
                ? 'border-warning/30 bg-warning/10 text-warning'
                : 'border-border text-foreground',
            )}
          >
            {notice.failed ? (
              <BellOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Bell className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p>{notice.text}</p>
              {notice.reason && <p className="text-xs">{T.noticeReason(notice.reason)}</p>}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{T.noNotice}</p>
        )}
      </section>

      <section className="grid gap-2">
        <SectionTitle>{T.timeline}</SectionTitle>
        <dl className="grid gap-1 text-sm">
          {timeline
            .filter(([, at]) => at)
            .map(([label, at]) => (
              <div key={label} className="flex flex-wrap justify-between gap-x-4">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-foreground">{formatOrderDate(at, 'long')}</dd>
              </div>
            ))}
        </dl>
      </section>
    </div>
  )
}

export function OrderDetailDialog({
  order,
  accountId,
  onClose,
}: {
  /** Pedido de la lista (sin cédula); null = cerrado. */
  order: PanelOrder | null
  accountId: string | null
  onClose: () => void
}) {
  const [state, setState] = useState<DetailState>({ orderId: null, kind: 'loading' })
  const orderId = order?.id ?? null
  // Cambia cuando el pedido de la lista cambió (acción hecha mientras tanto).
  const version = order ? `${order.status}:${order.payment_status}:${order.last_notice ?? ''}:${order.last_notice_error ?? ''}` : ''

  useEffect(() => {
    if (!orderId || !accountId) return
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ orderId, kind: 'loading' })
    fetchOrderDetail(createClient(), accountId, orderId)
      .then(({ order: detail }) => {
        if (!alive) return
        setState(detail ? { orderId, kind: 'ready', order: detail } : { orderId, kind: 'failed' })
      })
      .catch(() => {
        if (alive) setState({ orderId, kind: 'failed' })
      })
    return () => {
      alive = false
    }
  }, [orderId, accountId, version])

  // Un estado de otro pedido cuenta como "cargando": nunca se ve el cuerpo anterior.
  const current: DetailState =
    state.orderId === orderId ? state : { orderId, kind: 'loading' }

  return (
    <Dialog open={order !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg">
        {order && (
          <>
            <DialogHeader>
              <DialogTitle>{T.title(order.number)}</DialogTitle>
              <DialogDescription>
                <OrderStatusBadges order={order} />
              </DialogDescription>
            </DialogHeader>
            {current.kind === 'loading' && (
              <p className="text-sm text-muted-foreground">{VENTAS_TEXTS.loading}</p>
            )}
            {current.kind === 'failed' && (
              <Alert variant="destructive">
                <AlertDescription>{T.loadFailed}</AlertDescription>
              </Alert>
            )}
            {current.kind === 'ready' && <OrderDetailBody order={current.order} />}
            <DialogFooter>
              <Button type="button" variant="outline" className="max-sm:h-11" onClick={onClose}>
                {T.close}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
