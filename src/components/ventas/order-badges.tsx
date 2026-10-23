// ============================================================
// Insignias de un pedido (pago, estado y aviso fallido). Las comparten
// el panel del inbox y la pestaña /ventas para que se vean igual.
// ============================================================

import { BellOff } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { OrderStatus, PaymentStatus } from '@/modules/ventas/orders'
import type { PanelOrder } from '@/modules/ventas/panel'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

type Variant = 'default' | 'secondary' | 'outline' | 'destructive'

const PAYMENT_VARIANT: Record<PaymentStatus, Variant> = {
  pending: 'outline',
  paid: 'default',
}

const STATUS_VARIANT: Record<OrderStatus, Variant> = {
  new: 'outline',
  shipped: 'secondary',
  delivered: 'secondary',
  cancelled: 'destructive',
}

/** Etiqueta del estado de pago; texto conocido o el valor crudo. */
export function paymentLabel(status: string): string {
  return (T.payment as Record<string, string>)[status] ?? status
}

export function statusLabel(status: string): string {
  return (T.status as Record<string, string>)[status] ?? status
}

export function OrderStatusBadges({
  order,
  className,
}: {
  order: Pick<PanelOrder, 'payment_status' | 'status' | 'last_notice_error'>
  className?: string
}) {
  // Un pedido cancelado no necesita mostrar si estaba pendiente de pago.
  const showPayment = order.status !== 'cancelled' || order.payment_status === 'paid'
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {showPayment && (
        <Badge variant={PAYMENT_VARIANT[order.payment_status] ?? 'outline'}>
          {paymentLabel(order.payment_status)}
        </Badge>
      )}
      <Badge variant={STATUS_VARIANT[order.status] ?? 'outline'}>{statusLabel(order.status)}</Badge>
      {order.last_notice_error && (
        <Badge
          variant="outline"
          className="border-amber-500/50 text-amber-700 dark:text-amber-400"
          title={order.last_notice_error}
        >
          <BellOff aria-hidden="true" />
          {T.notice.failedBadge}
        </Badge>
      )}
    </span>
  )
}
