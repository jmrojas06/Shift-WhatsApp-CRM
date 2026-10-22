'use client'

// ============================================================
// Pestaña "Piezas": lo que el negocio usa o no. Cada interruptor
// se guarda al tocarlo (PATCH /api/verticals/agenda/config con la
// columna de la pieza). El cambio se ve al instante (optimista) y se
// revierte si el servidor lo rechaza.
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'
import {
  TOGGLE_COLUMNS,
  TOGGLE_KEYS,
  type AgendaToggleKey,
  type AgendaToggles,
} from '@/verticals/agenda/toggles'

import { agendaConfigApi } from './api'
import type { SettingsRow } from './types'

interface PiecesSectionProps {
  settings: SettingsRow
  canEdit: boolean
  reload: () => Promise<void>
}

export function PiecesSection({
  settings,
  canEdit,
  reload,
}: PiecesSectionProps) {
  // Lo guardado viene de `settings` (se refresca con reload); aquí solo se
  // guarda el cambio optimista de la pieza que se está enviando.
  const [optimistic, setOptimistic] = useState<Partial<AgendaToggles>>({})
  const [saving, setSaving] = useState<AgendaToggleKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggles: AgendaToggles = { ...settings.toggles, ...optimistic }

  async function toggle(key: AgendaToggleKey, next: boolean) {
    setSaving(key)
    setError(null)
    setOptimistic({ [key]: next })
    const res = await agendaConfigApi.patchConfig({
      toggles: { [TOGGLE_COLUMNS[key]]: next },
    })
    if (!res.ok) {
      // Revertir: el cambio no quedó guardado.
      setOptimistic({})
      setSaving(null)
      setError(res.error)
      return
    }
    await reload()
    setOptimistic({})
    setSaving(null)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.config.pieces.title}</CardTitle>
        <CardDescription>{T.config.pieces.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y divide-border">
          {TOGGLE_KEYS.map((key) => {
            const item = T.config.pieces.items[key]
            return (
              <li
                key={key}
                className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p
                    id={`piece-${key}-title`}
                    className="text-sm font-medium text-foreground"
                  >
                    {item.title}
                  </p>
                  <p
                    id={`piece-${key}-hint`}
                    className="mt-1 text-xs text-muted-foreground"
                  >
                    {item.hint(settings.labels)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {saving === key && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <Switch
                    checked={toggles[key]}
                    onCheckedChange={(next) => void toggle(key, next)}
                    disabled={!canEdit || saving !== null}
                    aria-labelledby={`piece-${key}-title`}
                    aria-describedby={`piece-${key}-hint`}
                    title={canEdit ? undefined : T.readOnly(T.config.viewerGate)}
                  />
                </div>
              </li>
            )
          })}
        </ul>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
