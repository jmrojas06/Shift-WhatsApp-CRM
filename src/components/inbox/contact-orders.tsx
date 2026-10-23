'use client'

// ============================================================
// Ventas de un contacto (diseño §3.3): sus últimos pedidos y "Crear
// pedido". Se usa en el panel lateral del inbox (escritorio) y en la
// hoja "Pedido" del encabezado de la conversación (móvil).
//
// Solo aparece si la cuenta tiene el módulo Ventas. El botón es para
// agent o más (`canSendMessages`, el mismo criterio de la ruta:
// requireRole('agent')); un viewer ve la lista y nada más. Los pedidos
// se leen con el cliente del usuario y sin la cédula.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Plus, ShoppingBag } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { OrderStatusBadges } from '@/components/ventas/order-badges'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { hasModule } from '@/lib/verticals/registry'
import type { PanelOrder } from '@/modules/ventas/panel'
import { fetchPanelOrders } from '@/modules/ventas/queries'
import { VENTAS_TEXTS, formatMoney } from '@/modules/ventas/texts'
import { isMissingMigrationError } from '@/verticals/agenda/panel'

import { CreateOrderDialog } from './create-order-dialog'

const T = VENTAS_TEXTS

/** Cuántos pedidos recientes se listan aquí (el resto, en /ventas). */
const CONTACT_ORDERS_LIMIT = 5

export interface ContactOrdersProps {
  contactId: string
  contactName: string
  /** Teléfono del contacto: "Ver en Ventas" abre /ventas filtrado por él. */
  contactPhone?: string | null
  conversationId: string | null
  /** Separador superior propio (panel lateral). En la hoja móvil no va. */
  withDivider?: boolean
}

type LoadState = 'loading' | 'ready' | 'failed' | 'migration'

/**
 * Estado al empezar una carga. La normal (primera vez o cambio de
 * contacto) muestra "cargando"; el refresco silencioso tras crear un
 * pedido deja la lista que había hasta que llega la nueva (sin parpadeo).
 */
export function nextLoadState(current: LoadState, silent: boolean): LoadState {
  return silent && current === 'ready' ? 'ready' : 'loading'
}

/** Enlace a /ventas con la búsqueda puesta en el teléfono del contacto. */
export function salesLinkForContact(phone: string | null | undefined): string {
  const q = phone?.trim()
  return q ? `/ventas?q=${encodeURIComponent(q)}` : '/ventas'
}

export function ContactOrders({
  contactId,
  contactName,
  contactPhone = null,
  conversationId,
  withDivider = true,
}: ContactOrdersProps) {
  const { account, accountId, canSendMessages, defaultCurrency } = useAuth()
  const enabled = hasModule(account, 'ventas')

  const [orders, setOrders] = useState<PanelOrder[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [dialogOpen, setDialogOpen] = useState(false)
  // Solo la respuesta de la última petición se pinta: si el contacto
  // cambia mientras carga, la respuesta vieja se descarta.
  const requestRef = useRef(0)

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!enabled || !accountId) return
    const request = ++requestRef.current
    setState((current) => nextLoadState(current, Boolean(opts.silent)))
    const { data, error } = await fetchPanelOrders(createClient(), accountId, {
      contactId,
      limit: CONTACT_ORDERS_LIMIT,
    })
    if (request !== requestRef.current) return
    if (error) {
      setState(isMissingMigrationError(error) ? 'migration' : 'failed')
      return
    }
    setOrders(data ?? [])
    setState('ready')
  }, [enabled, accountId, contactId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return () => {
      // Al desmontar o cambiar de contacto, cualquier respuesta en vuelo queda vieja.
      requestRef.current += 1
    }
  }, [load])

  if (!enabled) return null

  const canCreate = canSendMessages && state !== 'migration'
  const headingId = `contact-orders-${contactId}`

  return (
    <>
      {withDivider && <div className="my-4 border-t border-border" />}
      <section aria-labelledby={headingId} aria-busy={state === 'loading'}>
        <h4
          id={headingId}
          className="flex items-center gap-2 px-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
        >
          <ShoppingBag className="h-3 w-3" aria-hidden="true" />
          {T.contactOrders.title}
        </h4>

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
            <p className="px-1 text-xs text-muted-foreground">{T.loading}</p>
          ) : state === 'migration' ? (
            <p className="px-1 text-xs text-muted-foreground">{T.errors.migrationMissing}</p>
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
                    className="block min-h-11 rounded-lg bg-muted px-3 py-2 transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
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
              href={salesLinkForContact(contactPhone)}
              className={cn(
                'inline-flex min-h-11 items-center gap-1 px-1 text-xs font-medium text-primary underline-offset-4 hover:underline',
                withDivider && 'lg:min-h-0',
              )}
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
            onCreated={() => void load({ silent: true })}
          />
        )}
      </section>
    </>
  )
}
