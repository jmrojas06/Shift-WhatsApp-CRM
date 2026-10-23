'use client'

// ============================================================
// Ajustes de Ventas: los tres interruptores de avisos al
// cliente. Cada uno se guarda al tocarlo (PATCH
// /api/modules/ventas/settings), se ve al instante y se revierte si el
// servidor lo rechaza. Mismo patrón que las "Piezas" de la agenda.
// La página solo la muestra a owner/admin (la ruta exige admin).
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { ventasApi } from '@/modules/ventas/api-client'
import type { SalesSettings } from '@/modules/ventas/repo'
import { VENTAS_TEXTS } from '@/modules/ventas/texts'

const T = VENTAS_TEXTS.settings

// Mismas claves que SALES_SETTING_KEYS (repo.ts, solo servidor); el tipo
// las ata a SalesSettings para que no se desalineen.
const SALES_SETTING_KEYS = [
  'notify_paid',
  'notify_shipped',
  'notify_delivered',
] as const satisfies readonly (keyof SalesSettings)[]

type SettingKey = (typeof SALES_SETTING_KEYS)[number]

const ITEMS: Record<SettingKey, { title: string; hint: string }> = {
  notify_paid: { title: T.notifyPaid, hint: T.notifyPaidHint },
  notify_shipped: { title: T.notifyShipped, hint: T.notifyShippedHint },
  notify_delivered: { title: T.notifyDelivered, hint: T.notifyDeliveredHint },
}

export function NoticeSettings({
  settings,
  loadFailed,
  onSaved,
}: {
  settings: SalesSettings
  loadFailed: boolean
  onSaved: (settings: SalesSettings) => void
}) {
  const [optimistic, setOptimistic] = useState<Partial<SalesSettings>>({})
  const [saving, setSaving] = useState<SettingKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const values: SalesSettings = { ...settings, ...optimistic }

  async function toggle(key: SettingKey, next: boolean) {
    setSaving(key)
    setError(null)
    setOptimistic({ [key]: next })
    const res = await ventasApi.saveSettings({ [key]: next })
    setOptimistic({})
    setSaving(null)
    if (!res.ok) {
      setError(res.message || T.saveFailed)
      return
    }
    onSaved(res.data.settings)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{T.title}</h2>
        </CardTitle>
        <CardDescription>{T.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadFailed && (
          <Alert variant="destructive">
            <AlertDescription>{T.loadFailed}</AlertDescription>
          </Alert>
        )}
        <ul className="divide-y divide-border">
          {SALES_SETTING_KEYS.map((key) => {
            const item = ITEMS[key]
            return (
              <li key={key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p id={`ventas-${key}-title`} className="text-sm font-medium text-foreground">
                    {item.title}
                  </p>
                  <p id={`ventas-${key}-hint`} className="mt-1 text-xs text-muted-foreground">
                    {item.hint}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 max-sm:min-h-11 pointer-coarse:min-h-11">
                  {saving === key && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  )}
                  <Switch
                    checked={values[key]}
                    onCheckedChange={(next) => void toggle(key, Boolean(next))}
                    disabled={saving !== null || loadFailed}
                    aria-labelledby={`ventas-${key}-title`}
                    aria-describedby={`ventas-${key}-hint`}
                  />
                </div>
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-muted-foreground">{T.windowNote}</p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
