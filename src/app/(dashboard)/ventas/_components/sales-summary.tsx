// ============================================================
// Resumen del mes (diseño §3.4): vendido este mes, pedidos del mes y
// pendiente por cobrar. "Vendido" va resaltado: es la cifra que el
// negocio mira primero.
// ============================================================

import { Banknote, ReceiptText, Wallet } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { SUMMARY_LIMIT, formatAmounts, type SalesSummary } from '@/modules/ventas/panel'
import { VENTAS_TEXTS as T } from '@/modules/ventas/texts'

interface SalesSummaryProps {
  summary: SalesSummary | null
  currency: string
  loading: boolean
  /** No se pudo leer: se muestra un error con "Reintentar" en vez de cifras. */
  failed?: boolean
  /** Se llegó al tope de filas: las cifras pueden estar incompletas. */
  truncated?: boolean
  onRetry?: () => void
}

export function SalesSummaryTiles({
  summary,
  currency,
  loading,
  failed = false,
  truncated = false,
  onRetry,
}: SalesSummaryProps) {
  if (failed && !loading) {
    return (
      <section aria-label={T.summary.label}>
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {T.summary.loadFailed}
            {onRetry && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="max-sm:h-11 pointer-coarse:h-11"
                onClick={onRetry}
              >
                {T.actions.retry}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </section>
    )
  }

  const value = (text: string) => (loading || !summary ? '…' : text)

  const tiles = [
    {
      key: 'sold',
      icon: Banknote,
      label: T.summary.soldThisMonth,
      hint: T.summary.soldHint,
      value: value(formatAmounts(summary?.soldThisMonth ?? [], currency)),
      highlight: true,
    },
    {
      key: 'orders',
      icon: ReceiptText,
      label: T.summary.orders,
      hint: T.summary.ordersHint,
      value: value(String(summary?.ordersThisMonth ?? 0)),
      highlight: false,
    },
    {
      key: 'pending',
      icon: Wallet,
      label: T.summary.pending,
      hint: T.summary.pendingHint,
      value: value(formatAmounts(summary?.pendingToCollect ?? [], currency)),
      highlight: false,
    },
  ]

  return (
    <section aria-label={T.summary.label} aria-busy={loading}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.icon
          return (
            <li key={tile.key} className={cn(tile.highlight && 'col-span-2 sm:col-span-1')}>
              <Card
                size="sm"
                className={cn('h-full', tile.highlight && 'bg-primary/5 ring-primary/25')}
              >
                <CardHeader>
                  <CardDescription className="flex items-center gap-2">
                    <Icon
                      className={cn('h-4 w-4', tile.highlight ? 'text-primary' : 'text-muted-foreground')}
                      aria-hidden="true"
                    />
                    {tile.label}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1">
                  <p
                    className={cn(
                      'text-2xl font-semibold tracking-tight tabular-nums break-words',
                      tile.highlight ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {tile.value}
                  </p>
                  <p className="text-xs text-muted-foreground">{tile.hint}</p>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>
      {truncated && !loading && (
        <p className="mt-2 text-xs text-muted-foreground">{T.summary.truncated(SUMMARY_LIMIT)}</p>
      )}
    </section>
  )
}
