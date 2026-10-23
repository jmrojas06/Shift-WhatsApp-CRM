// ============================================================
// Resultado del aviso al cliente justo después de guardar: verde si
// salió, ámbar (tranquilo, no rojo) si no. El pedido ya quedó guardado
// en ambos casos, así que nunca se presenta como un error.
// ============================================================

import { CheckCircle2, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import type { NoticeResult } from '@/modules/ventas/panel'

export function NoticeResultAlert({
  result,
  live = true,
  className,
}: {
  result: NoticeResult | null
  /** false cuando ya está dentro de una región viva persistente de la página. */
  live?: boolean
  className?: string
}) {
  if (!result) return null
  const success = result.tone === 'success'
  return (
    <Alert
      role={live ? 'status' : 'none'}
      data-tone={result.tone}
      className={cn(
        success
          ? 'border-emerald-500/40 text-emerald-800 dark:text-emerald-300'
          : 'border-amber-500/50 text-amber-800 dark:text-amber-300',
        className,
      )}
    >
      {success ? <CheckCircle2 aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      <AlertDescription className="text-current">{result.text}</AlertDescription>
    </Alert>
  )
}
