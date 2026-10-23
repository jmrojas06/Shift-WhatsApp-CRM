// ============================================================
// Lista de pedidos de /ventas: filtros, búsqueda y acciones de un clic.
//
// Qué acciones se muestran lo decide `availableOrderActions` (el mismo
// `applyOrderAction` del servidor). La cédula no se lee ni se muestra
// aquí: solo en el detalle.
// ============================================================

import { Ban, Banknote, Eye, Loader2, PackageCheck, Search, ShoppingBag, Truck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OrderStatusBadges } from '@/components/ventas/order-badges'
import { cn } from '@/lib/utils'
import type { OrderAction } from '@/modules/ventas/orders'
import {
  ORDER_FILTERS,
  availableOrderActions,
  formatOrderDate,
  matchesOrderFilter,
  type OrderFilter,
  type PanelOrder,
} from '@/modules/ventas/panel'
import { VENTAS_TEXTS as T, formatMoney } from '@/modules/ventas/texts'

const ACTION_META: Record<
  OrderAction,
  { label: string; icon: LucideIcon; variant: 'outline' | 'ghost' }
> = {
  mark_paid: { label: T.actions.markPaid, icon: Banknote, variant: 'outline' },
  mark_shipped: { label: T.actions.markShipped, icon: Truck, variant: 'outline' },
  mark_delivered: { label: T.actions.markDelivered, icon: PackageCheck, variant: 'outline' },
  cancel: { label: T.actions.cancel, icon: Ban, variant: 'ghost' },
}

const TOUCH = 'h-11 sm:h-8'

// ------------------------------------------------------------
// Filtros y búsqueda
// ------------------------------------------------------------

interface OrderToolbarProps {
  orders: readonly PanelOrder[]
  filter: OrderFilter
  onFilterChange: (filter: OrderFilter) => void
  query: string
  onQueryChange: (query: string) => void
}

export function OrderToolbar({
  orders,
  filter,
  onFilterChange,
  query,
  onQueryChange,
}: OrderToolbarProps) {
  return (
    <div className="space-y-3">
      <div className="relative">
        <Label htmlFor="ventas-search" className="sr-only">
          {T.searchLabel}
        </Label>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="ventas-search"
          name="q"
          type="search"
          spellCheck={false}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={T.searchPlaceholder}
          autoComplete="off"
          className="h-11 pl-9 sm:h-9"
        />
      </div>

      {/* En móvil los filtros se desplazan de lado; en escritorio se envuelven. */}
      <div
        role="group"
        aria-label={T.filtersLabel}
        className="-mx-4 flex gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
      >
        {ORDER_FILTERS.map((key) => {
          const active = key === filter
          const count = orders.filter((o) => matchesOrderFilter(o, key)).length
          return (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={active ? 'default' : 'outline'}
              aria-pressed={active}
              className={cn(TOUCH, 'shrink-0 rounded-full px-3')}
              onClick={() => onFilterChange(key)}
            >
              {T.filters[key]}
              <span className={cn('tabular-nums', active ? 'opacity-80' : 'text-muted-foreground')}>
                {count}
              </span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Lista
// ------------------------------------------------------------

interface OrderListProps {
  orders: readonly PanelOrder[]
  /** Hay pedidos en la cuenta (para distinguir "vacío" de "sin resultados"). */
  hasAny: boolean
  hasQuery: boolean
  canAct: boolean
  busyId: string | null
  onAction: (order: PanelOrder, action: OrderAction) => void
  onOpenDetail: (order: PanelOrder) => void
}

export function OrderList({
  orders,
  hasAny,
  hasQuery,
  canAct,
  busyId,
  onAction,
  onOpenDetail,
}: OrderListProps) {
  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <ShoppingBag className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
        {hasAny ? (
          <p className="text-sm text-muted-foreground">
            {hasQuery ? T.empty.search : T.empty.filtered}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-foreground">{T.empty.title}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{T.empty.body}</p>
          </>
        )}
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {orders.map((order) => {
        const busy = busyId === order.id
        const actions = canAct ? availableOrderActions(order) : []
        const created = formatOrderDate(order.created_at)
        return (
          <li
            key={order.id}
            className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <button
                  type="button"
                  onClick={() => onOpenDetail(order)}
                  className="rounded-sm text-sm font-semibold text-foreground underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {T.detail.title(order.number)}
                </button>
                <span className="min-w-0 truncate text-sm text-foreground">
                  {order.customer_name}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[created, order.customer_phone].filter(Boolean).join(' · ')}
              </p>
              <OrderStatusBadges order={order} className="mt-2" />
            </div>

            <div className="flex flex-col gap-2 sm:items-end">
              <p className="text-base font-semibold tabular-nums text-foreground">
                {formatMoney(Number(order.total), order.currency)}
              </p>
              <div
                role="group"
                aria-label={T.actions.groupLabel(order.number)}
                className="flex flex-wrap gap-2 sm:justify-end"
              >
                {actions.map((action) => {
                  const meta = ACTION_META[action]
                  const Icon = meta.icon
                  return (
                    <Button
                      key={action}
                      type="button"
                      size="sm"
                      variant={meta.variant}
                      disabled={busy}
                      className={cn(
                        TOUCH,
                        action === 'cancel' && 'text-muted-foreground hover:text-destructive',
                      )}
                      onClick={() => onAction(order, action)}
                    >
                      <Icon aria-hidden="true" />
                      {meta.label}
                    </Button>
                  )
                })}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={TOUCH}
                  onClick={() => onOpenDetail(order)}
                  aria-label={`${T.actions.viewDetail}: ${T.detail.title(order.number)}`}
                >
                  <Eye aria-hidden="true" />
                  {T.actions.viewDetail}
                </Button>
              </div>
              {busy && (
                <p
                  role="status"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {T.actions.working}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
