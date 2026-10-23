'use client'

// ============================================================
// /ventas — pestaña de pedidos del módulo Ventas (diseño §3.4).
//
// Solo para cuentas con el módulo ventas: el sidebar ya la oculta para
// el resto y aquí además se bloquea el contenido por si alguien entra
// por URL directa (mismo patrón que /agenda).
//
// Lecturas con el cliente del usuario (queries.ts; RLS: los miembros
// leen); los cambios de estado y los ajustes van por
// /api/modules/ventas/*. La cédula no se lee en la lista: solo en el
// detalle.
//
// Enlaces: `?pedido=1001` abre el detalle de ese pedido; `?contacto=<uuid>`
// muestra solo los pedidos de ese contacto (el inbox enlaza así, nunca con
// el teléfono en la URL). `?q=` todavía llena la búsqueda si llega, pero
// ningún enlace lo genera.
// ============================================================

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NoticeResultAlert } from '@/components/ventas/notice-result'
import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'
import { hasModule } from '@/lib/verticals/registry'
import { ventasApi } from '@/modules/ventas/api-client'
import type { OrderAction } from '@/modules/ventas/orders'
import {
  actionOutcome,
  contactFilterFrom,
  contactFilterLabel,
  filterOrders,
  ventasUrlWithout,
  salesSummary,
  type ActionFeedback,
  type OrderFilter,
  type PanelOrder,
} from '@/modules/ventas/panel'
import {
  fetchOrderByNumber,
  fetchPanelOrders,
  fetchSalesSettings,
  fetchSummaryRows,
  type SummaryRow,
} from '@/modules/ventas/queries'
import type { SalesSettings } from '@/modules/ventas/repo'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'
import { isMissingMigrationError } from '@/verticals/agenda/panel'

import { NoticeSettings } from './_components/notice-settings'
import { CancelOrderDialog, ShipOrderDialog, type ShipExtra } from './_components/order-dialogs'
import { OrderDetailDialog } from './_components/order-detail-dialog'
import { OrderList, OrderToolbar, orderTitleId } from './_components/order-list'
import { SalesSummaryTiles } from './_components/sales-summary'

/** Pedidos que se traen para la lista (los más recientes). */
const LIST_LIMIT = 500

const FEEDBACK_ID = 'ventas-feedback'

const DEFAULT_SETTINGS: SalesSettings = {
  notify_paid: true,
  notify_shipped: true,
  notify_delivered: true,
}

type LoadState = 'loading' | 'ready' | 'failed' | 'migration'

interface SummaryState {
  rows: SummaryRow[] | null
  truncated: boolean
  loading: boolean
  failed: boolean
}

/** Lleva el foco al título del pedido o, si ya no está en la lista, al mensaje. */
function focusAfterAction(orderId: string) {
  window.setTimeout(() => {
    const target =
      document.getElementById(orderTitleId(orderId)) ?? document.getElementById(FEEDBACK_ID)
    target?.focus()
  }, 0)
}

export default function VentasPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">{T.loading}</p>}>
      <VentasPageInner />
    </Suspense>
  )
}

function VentasPageInner() {
  const { account, accountId, canSendMessages, canEditSettings, defaultCurrency } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const deepLinkNumber = Number(searchParams.get('pedido')) || null
  const contactId = contactFilterFrom(searchParams)
  const supabase = useMemo(() => createClient(), [])

  const isVentas = hasModule(account, 'ventas')
  const currency = account?.default_currency ?? defaultCurrency

  const [orders, setOrders] = useState<PanelOrder[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [summaryState, setSummaryState] = useState<SummaryState>({
    rows: null,
    truncated: false,
    loading: true,
    failed: false,
  })
  const [settings, setSettings] = useState<SalesSettings>(DEFAULT_SETTINGS)
  const [settingsFailed, setSettingsFailed] = useState(false)

  const [filter, setFilter] = useState<OrderFilter>('all')
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '')
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null)

  const [shipTarget, setShipTarget] = useState<PanelOrder | null>(null)
  const [cancelTarget, setCancelTarget] = useState<PanelOrder | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  // Pedido del enlace `?pedido=` que no estaba entre los cargados.
  const [linkedOrder, setLinkedOrder] = useState<PanelOrder | null>(null)
  const deepLinkHandled = useRef(false)

  // Solo la última petición de cada lectura se pinta (respuestas viejas se descartan).
  const ordersReq = useRef(0)
  const summaryReq = useRef(0)
  const settingsReq = useRef(0)

  /** `reset`: la lista cambia de alcance (entrar o salir del filtro de contacto). */
  const loadOrders = useCallback(async (opts: { reset?: boolean } = {}) => {
    if (!accountId || !isVentas) return
    const request = ++ordersReq.current
    if (opts.reset) setLoadState('loading')
    const { data, error } = await fetchPanelOrders(supabase, accountId, {
      limit: LIST_LIMIT,
      ...(contactId ? { contactId } : {}),
    })
    if (request !== ordersReq.current) return
    if (error) {
      setLoadState(isMissingMigrationError(error) ? 'migration' : 'failed')
      return
    }
    setOrders(data ?? [])
    setLoadState('ready')
  }, [accountId, isVentas, supabase, contactId])

  const loadSummary = useCallback(async () => {
    if (!accountId || !isVentas) return
    const request = ++summaryReq.current
    setSummaryState((prev) => ({ ...prev, loading: true }))
    const { rows, truncated, error } = await fetchSummaryRows(supabase, accountId, new Date())
    if (request !== summaryReq.current) return
    setSummaryState({ rows, truncated, loading: false, failed: Boolean(error) })
  }, [accountId, isVentas, supabase])

  const loadSettings = useCallback(async () => {
    if (!accountId || !isVentas) return
    const request = ++settingsReq.current
    const res = await fetchSalesSettings(supabase, accountId)
    if (request !== settingsReq.current) return
    setSettingsFailed(Boolean(res.error))
    setSettings(res.settings)
  }, [accountId, isVentas, supabase])

  useEffect(() => {
    // Los setState corren tras las respuestas asíncronas de Supabase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOrders({ reset: true })
  }, [loadOrders])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSummary()
    void loadSettings()
  }, [loadSummary, loadSettings])

  // `?pedido=1001`: abre el detalle una sola vez cuando la lista cargó; si
  // el pedido no está entre los cargados, se busca por su número.
  useEffect(() => {
    if (deepLinkHandled.current || loadState !== 'ready' || !deepLinkNumber || !accountId) return
    deepLinkHandled.current = true
    const match = orders.find((o) => o.number === deepLinkNumber)
    if (match) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetailId(match.id)
      return
    }
    void fetchOrderByNumber(supabase, accountId, deepLinkNumber).then(({ order }) => {
      if (!order) return
      setLinkedOrder(order)
      setDetailId(order.id)
    })
  }, [deepLinkNumber, loadState, orders, accountId, supabase])

  const summary = useMemo(
    () => (summaryState.rows ? salesSummary(summaryState.rows, new Date(), currency) : null),
    [summaryState.rows, currency],
  )
  const visible = useMemo(() => filterOrders(orders, filter, query), [orders, filter, query])
  const detailOrder = detailId
    ? (orders.find((o) => o.id === detailId) ??
      (linkedOrder?.id === detailId ? linkedOrder : null))
    : null

  const closeDetail = useCallback(() => {
    setDetailId(null)
    // Cerrar el detalle quita `?pedido=` (y solo eso: `contacto` y `q` se
    // quedan) para que recargar no lo vuelva a abrir.
    if (searchParams.get('pedido')) router.replace(ventasUrlWithout(searchParams, 'pedido'))
  }, [router, searchParams])

  /**
   * Cambia el estado de un pedido. Lo que se hace con la respuesta lo
   * decide `actionOutcome` (pura, probada en panel.test.ts). Devuelve el
   * error a mostrar dentro del diálogo, o null si el diálogo puede cerrar.
   */
  const runAction = useCallback(
    async (
      order: PanelOrder,
      action: OrderAction,
      extra: Partial<ShipExtra> = {},
      inDialog = false,
    ): Promise<string | null> => {
      const setBusy = (busy: boolean) =>
        setBusyIds((prev) => {
          const next = new Set(prev)
          if (busy) next.add(order.id)
          else next.delete(order.id)
          return next
        })

      setBusy(true)
      setFeedback(null)
      const res = await ventasApi.updateOrder(order.id, action, extra)
      setBusy(false)

      const outcome = actionOutcome(res, { inDialog })
      if (outcome.ok) {
        setOrders((prev) => prev.map((o) => (o.id === outcome.order.id ? outcome.order : o)))
        setLinkedOrder((prev) => (prev?.id === outcome.order.id ? outcome.order : prev))
        void loadSummary()
      } else if (outcome.reload) {
        await Promise.all([loadOrders(), loadSummary()])
      }
      if (outcome.feedback) setFeedback(outcome.feedback)
      if (outcome.closeDialog) focusAfterAction(order.id)
      return outcome.ok ? null : outcome.dialogError
    },
    [loadOrders, loadSummary],
  )

  const handleAction = useCallback(
    (order: PanelOrder, action: OrderAction) => {
      if (action === 'mark_shipped') setShipTarget(order)
      else if (action === 'cancel') setCancelTarget(order)
      else void runAction(order, action)
    },
    [runAction],
  )

  // Mientras el contexto de cuenta carga no se sabe si el módulo aplica.
  if (!account) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{T.loading}</p>
      </div>
    )
  }

  const header = (
    <div>
      <h1 className="text-2xl font-bold text-foreground">{T.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{T.subtitle}</p>
    </div>
  )

  if (!isVentas) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardHeader>
            <CardTitle>{T.notEnabledTitle}</CardTitle>
            <CardDescription>{T.notEnabledBody}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (loadState === 'migration') {
    return (
      <div className="space-y-6">
        {header}
        <Alert role="alert">
          <AlertDescription>{T.errors.migrationMissing}</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}

      <SalesSummaryTiles
        summary={summary}
        currency={currency}
        loading={summaryState.loading}
        failed={summaryState.failed}
        truncated={summaryState.truncated}
        onRetry={() => void loadSummary()}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{T.ordersTitle}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {contactId && (
            <div className="flex">
              <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted py-1 pr-1 pl-3 text-sm text-foreground">
                <span className="truncate">
                  {loadState === 'ready' ? contactFilterLabel(orders) : T.contactFilter.fallback}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 rounded-full sm:size-7"
                  aria-label={T.contactFilter.remove}
                  title={T.contactFilter.remove}
                  onClick={() => router.replace(ventasUrlWithout(searchParams, 'contacto'))}
                >
                  <X aria-hidden="true" />
                </Button>
              </span>
            </div>
          )}

          <OrderToolbar
            orders={orders}
            filter={filter}
            onFilterChange={setFilter}
            query={query}
            onQueryChange={setQuery}
          />

          {/* Regiones vivas siempre presentes: solo cambia su contenido. */}
          <p className="sr-only" role="status">
            {busyIds.size > 0 ? T.actions.working : ''}
          </p>
          <div
            id={FEEDBACK_ID}
            role="status"
            aria-live="polite"
            tabIndex={-1}
            className="outline-none empty:hidden"
          >
            {feedback?.kind === 'notice' && (
              <NoticeResultAlert result={feedback.result} live={false} />
            )}
            {feedback?.kind === 'error' && (
              <Alert variant="destructive" role="none">
                <AlertDescription>{feedback.text}</AlertDescription>
              </Alert>
            )}
          </div>

          {loadState === 'loading' ? (
            <p className="py-6 text-sm text-muted-foreground">{T.loading}</p>
          ) : loadState === 'failed' ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {T.errors.loadFailed}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-11 sm:h-8"
                  onClick={() => void loadOrders()}
                >
                  {T.actions.retry}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {T.resultsCount(visible.length)}
                {orders.length >= LIST_LIMIT && ` · ${T.listLimited(LIST_LIMIT)}`}
              </p>
              <OrderList
                orders={visible}
                hasAny={orders.length > 0}
                hasQuery={query.trim().length > 0}
                canAct={canSendMessages}
                busyIds={busyIds}
                onAction={handleAction}
                onOpenDetail={(order) => setDetailId(order.id)}
              />
            </>
          )}
        </CardContent>
      </Card>

      {canEditSettings && (
        <NoticeSettings settings={settings} loadFailed={settingsFailed} onSaved={setSettings} />
      )}

      <ShipOrderDialog
        order={shipTarget}
        onClose={() => setShipTarget(null)}
        onSubmit={async (order, extra) => {
          const error = await runAction(order, 'mark_shipped', extra, true)
          if (!error) setShipTarget(null)
          return error
        }}
      />
      <CancelOrderDialog
        order={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={async (order) => {
          const error = await runAction(order, 'cancel', {}, true)
          if (!error) setCancelTarget(null)
          return error
        }}
      />
      <OrderDetailDialog order={detailOrder} accountId={accountId} onClose={closeDetail} />
    </div>
  )
}
