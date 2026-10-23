'use client'

// ============================================================
// Ventas en el panel lateral del contacto (diseño §3.3).
//
// Solo aparece si la cuenta tiene el módulo Ventas. El botón "Crear
// pedido" es para agent o más (`canSendMessages`, el mismo criterio que
// usa la ruta: requireRole('agent')); un viewer ve la lista y nada más.
// Los pedidos se leen con el cliente del usuario (la RLS deja leer a los
// miembros) y sin la cédula.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Plus, ShoppingBag } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { OrderStatusBadges } from '@/components/ventas/order-badges'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { hasModule } from '@/lib/verticals/registry'
import { PANEL_ORDER_COLUMNS, type PanelOrder } from '@/modules/ventas/panel'
import { VENTAS_TEXTS, formatMoney } from '@/modules/ventas/texts'
import { isMissingMigrationError } from '@/verticals/agenda/panel'

import { CreateOrderDialog } from './create-order-dialog'

const T = VENTAS_TEXTS

/** Cuántos pedidos recientes se listan en el panel (el resto, en /ventas). */
const CONTACT_ORDERS_LIMIT = 5

export interface ContactOrdersProps {
  contactId: string
  contactName: string
  conversationId: string | null
}

type LoadState = 'loading' | 'ready' | 'failed' | 'migration'

export function ContactOrders({ contactId, contactName, conversationId }: ContactOrdersProps) {
  const { account, accountId, canSendMessages, defaultCurrency } = useAuth()
  const enabled = hasModule(account, 'ventas')

  const [orders, setOrders] = useState<PanelOrder[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [dialogOpen, setDialogOpen] = useState(false)

  const load = useCallback(async () => {
    if (!enabled || !accountId) return
    const supabase = createClient()
    const { data, error } = await supabase
      .from('orders')
      .select(PANEL_ORDER_COLUMNS)
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(CONTACT_ORDERS_LIMIT)
    if (error) {
      setState(isMissingMigrationError(error) ? 'migration' : 'failed')
      return
    }
    setOrders((data ?? []) as unknown as PanelOrder[])
    setState('ready')
  }, [enabled, accountId, contactId])

  useEffect(() => {
    // setState corre dentro del callback asíncrono de Supabase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  if (!enabled) return null

  const canCreate = canSendMessages && state !== 'migration'

  return (
    <>
      {/* Separador propio: sin el módulo no queda una línea suelta en el panel. */}
      <div className="my-4 border-t border-border" />
      <section aria-labelledby={`contact-orders-${contactId}`}>
        <div className="flex items-center justify-between gap-2 px-1">
          <h4
            id={`contact-orders-${contactId}`}
            className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase"
          >
            <ShoppingBag className="h-3 w-3" aria-hidden="true" />
            {T.contactOrders.title}
          </h4>
        </div>

        {canCreate && (
          <Button
            type="button"
            className="mt-2 h-11 w-full lg:h-9"
            onClick={() => setDialogOpen(true)}
          >
            <Plus aria-hidden="true" />
            {T.createOrder.open}
          </Button>
        )}

        <div className="mt-2 space-y-2">
          {state === 'loading' ? (
            <p className="px-1 text-xs text-muted-foreground" role="status">
              {T.loading}
            </p>
          ) : state === 'migration' ? (
            <p className="px-1 text-xs text-muted-foreground" role="status">
              {T.errors.migrationMissing}
            </p>
          ) : state === 'failed' ? (
            <p className="px-1 text-xs text-destructive" role="alert">
              {T.contactOrders.loadFailed}
            </p>
          ) : orders.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">{T.contactOrders.empty}</p>
          ) : (
            <ul className="space-y-2">
              {orders.map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/ventas?pedido=${order.number}`}
                    className="block rounded-lg bg-muted px-3 py-2 transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {T.detail.title(order.number)}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatMoney(Number(order.total), order.currency)}
                      </span>
                    </span>
                    <OrderStatusBadges order={order} className="mt-1.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {state !== 'migration' && (
            <Link
              href="/ventas"
              className="inline-flex min-h-11 items-center gap-1 px-1 text-xs font-medium text-primary underline-offset-4 hover:underline lg:min-h-0"
            >
              {T.contactOrders.viewAll}
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          )}
        </div>

        {canCreate && (
          <CreateOrderDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            contactId={contactId}
            contactName={contactName}
            conversationId={conversationId}
            currency={account?.default_currency ?? defaultCurrency}
            onCreated={() => void load()}
          />
        )}
      </section>
    </>
  )
}
