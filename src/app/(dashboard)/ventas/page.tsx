'use client'

// ============================================================
// /ventas — pestaña de pedidos del módulo Ventas (diseño §3.4).
//
// Solo para cuentas con el módulo ventas: el sidebar ya la oculta para
// el resto y aquí además se bloquea el contenido por si alguien entra
// por URL directa (mismo patrón que /agenda).
//
// Lecturas con el cliente del usuario (RLS: los miembros leen); los
// cambios de estado y los ajustes van por /api/modules/ventas/*. La
// cédula no se lee en la lista: solo en el detalle.
//
// `?pedido=1001` abre el detalle de ese pedido (enlace desde el inbox).
// ============================================================

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

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
  PANEL_ORDER_COLUMNS,
  SUMMARY_ORDER_COLUMNS,
  filterOrders,
  isOrderFilter,
  noticeResult,
  salesMonthStart,
  salesSummary,
  type NoticeResult,
  type OrderFilter,
  type PanelOrder,
} from '@/modules/ventas/panel'
import type { SalesSettings } from '@/modules/ventas/repo'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'
import { isMissingMigrationError } from '@/verticals/agenda/panel'

import { NoticeSettings } from './_components/notice-settings'
import { CancelOrderDialog, ShipOrderDialog, type ShipExtra } from './_components/order-dialogs'
import { OrderDetailDialog } from './_components/order-detail-dialog'
import { OrderList, OrderToolbar } from './_components/order-list'
import { SalesSummaryTiles } from './_components/sales-summary'

/** Pedidos que se traen para la lista (los más recientes). */
const LIST_LIMIT = 500

const DEFAULT_SETTINGS: SalesSettings = {
  notify_paid: true,
  notify_shipped: true,
  notify_delivered: true,
}

type SummaryRow = Pick<
  PanelOrder,
  'status' | 'payment_status' | 'total' | 'currency' | 'paid_at' | 'created_at'
>

type LoadState = 'loading' | 'ready' | 'failed' | 'migration'

type Feedback = { kind: 'notice'; result: NoticeResult } | { kind: 'error'; text: string }

/** Columnas de la lista tomadas de la respuesta del PATCH (que trae la fila completa). */
function toPanelOrder(row: PanelOrder): PanelOrder {
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

export default function VentasPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">{T.loading}</p>}>
      <VentasPageInner />
    </Suspense>
  )
}

function VentasPageInner() {
  const { account, accountId, canSendMessages, canEditSettings, defaultCurrency } = useAuth()
  const searchParams = useSearchParams()
  const deepLinkNumber = Number(searchParams.get('pedido')) || null
  const supabase = useMemo(() => createClient(), [])

  const isVentas = hasModule(account, 'ventas')
  const currency = account?.default_currency ?? defaultCurrency

  const [orders, setOrders] = useState<PanelOrder[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [summaryRows, setSummaryRows] = useState<SummaryRow[] | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [settings, setSettings] = useState<SalesSettings>(DEFAULT_SETTINGS)
  const [settingsFailed, setSettingsFailed] = useState(false)

  const [filter, setFilter] = useState<OrderFilter>('all')
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const [shipTarget, setShipTarget] = useState<PanelOrder | null>(null)
  const [cancelTarget, setCancelTarget] = useState<PanelOrder | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const deepLinkHandled = useRef(false)

  const loadOrders = useCallback(async () => {
    if (!accountId || !isVentas) return
    const { data, error } = await supabase
      .from('orders')
      .select(PANEL_ORDER_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT)
    if (error) {
      setLoadState(isMissingMigrationError(error) ? 'migration' : 'failed')
      return
    }
    setOrders((data ?? []) as unknown as PanelOrder[])
    setLoadState('ready')
  }, [accountId, isVentas, supabase])

  /**
   * Filas del resumen: pagadas o creadas desde el inicio del mes (hora de
   * Colombia) y todas las pendientes de cobro. La suma la hace
   * `salesSummary` (pura), que vuelve a filtrar por mes y estado.
   */
  const loadSummary = useCallback(async () => {
    if (!accountId || !isVentas) return
    setSummaryLoading(true)
    const since = salesMonthStart(new Date()).toISOString()
    const { data, error } = await supabase
      .from('orders')
      .select(SUMMARY_ORDER_COLUMNS)
      .eq('account_id', accountId)
      .or(
        `paid_at.gte."${since}",created_at.gte."${since}",and(payment_status.eq.pending,status.neq.cancelled)`,
      )
    setSummaryRows(error ? null : ((data ?? []) as unknown as SummaryRow[]))
    setSummaryLoading(false)
  }, [accountId, isVentas, supabase])

  const loadSettings = useCallback(async () => {
    if (!accountId || !isVentas) return
    const { data, error } = await supabase
      .from('sales_settings')
      .select('notify_paid, notify_shipped, notify_delivered')
      .eq('account_id', accountId)
      .maybeSingle()
    setSettingsFailed(Boolean(error))
    const row = data as Partial<SalesSettings> | null
    // Sin fila los avisos están prendidos (igual que en la base).
    setSettings({
      notify_paid: row?.notify_paid ?? true,
      notify_shipped: row?.notify_shipped ?? true,
      notify_delivered: row?.notify_delivered ?? true,
    })
  }, [accountId, isVentas, supabase])

  useEffect(() => {
    // Los setState corren dentro de los callbacks asíncronos de Supabase.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOrders()
    void loadSummary()
    void loadSettings()
  }, [loadOrders, loadSummary, loadSettings])

  // `?pedido=1001`: abre el detalle una sola vez, cuando la lista ya cargó.
  useEffect(() => {
    if (deepLinkHandled.current || loadState !== 'ready' || !deepLinkNumber) return
    deepLinkHandled.current = true
    const match = orders.find((o) => o.number === deepLinkNumber)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (match) setDetailId(match.id)
  }, [deepLinkNumber, loadState, orders])

  const summary = useMemo(
    () => (summaryRows ? salesSummary(summaryRows, new Date(), currency) : null),
    [summaryRows, currency],
  )
  const visible = useMemo(() => filterOrders(orders, filter, query), [orders, filter, query])
  const detailOrder = detailId ? (orders.find((o) => o.id === detailId) ?? null) : null

  /**
   * Cambia el estado de un pedido. Devuelve null si salió bien o el
   * mensaje de un error de datos (para mostrarlo dentro del diálogo).
   * El resto de errores se muestran arriba de la lista; si el pedido
   * cambió por otro lado (`stale`), se recarga la lista.
   */
  const runAction = useCallback(
    async (order: PanelOrder, action: OrderAction, extra: Partial<ShipExtra> = {}) => {
      setBusyId(order.id)
      setFeedback(null)
      const res = await ventasApi.updateOrder(order.id, action, extra)
      setBusyId(null)

      if (!res.ok) {
        if (res.code === 'invalid') return res.message
        if (res.code === 'stale' || res.code === 'invalid_transition' || res.code === 'not_found') {
          await Promise.all([loadOrders(), loadSummary()])
        }
        setFeedback({ kind: 'error', text: res.message })
        return null
      }

      const updated = toPanelOrder(res.data.order)
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)))
      void loadSummary()
      const notice = noticeResult(res.data.notice, updated)
      const done = T.actions.updated(updated.number)
      setFeedback({
        kind: 'notice',
        result:
          notice?.tone === 'warning'
            ? notice
            : { tone: 'success', text: notice ? `${done} ${notice.text}` : done },
      })
      return null
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
        <p className="text-sm text-muted-foreground" role="status">
          {T.loading}
        </p>
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

      <SalesSummaryTiles summary={summary} currency={currency} loading={summaryLoading} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{T.ordersTitle}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <OrderToolbar
            orders={orders}
            filter={filter}
            onFilterChange={(next) => isOrderFilter(next) && setFilter(next)}
            query={query}
            onQueryChange={setQuery}
          />

          {/* Resultado de la última acción: aviso tranquilo o error. */}
          {feedback?.kind === 'notice' && <NoticeResultAlert result={feedback.result} />}
          {feedback?.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>{feedback.text}</AlertDescription>
            </Alert>
          )}

          {loadState === 'loading' ? (
            <p className="py-6 text-sm text-muted-foreground" role="status">
              {T.loading}
            </p>
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
                busyId={busyId}
                onAction={handleAction}
                onOpenDetail={(order) => setDetailId(order.id)}
              />
            </>
          )}
        </CardContent>
      </Card>

      {canEditSettings && (
        <NoticeSettings
          settings={settings}
          loadFailed={settingsFailed}
          canEdit={canEditSettings}
          onSaved={setSettings}
        />
      )}

      <ShipOrderDialog
        order={shipTarget}
        onClose={() => setShipTarget(null)}
        onSubmit={async (order, extra) => {
          const error = await runAction(order, 'mark_shipped', extra)
          if (!error) setShipTarget(null)
          return error
        }}
      />
      <CancelOrderDialog
        order={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={async (order) => {
          const error = await runAction(order, 'cancel')
          if (!error) setCancelTarget(null)
          return error
        }}
      />
      <OrderDetailDialog order={detailOrder} onClose={() => setDetailId(null)} />
    </div>
  )
}
