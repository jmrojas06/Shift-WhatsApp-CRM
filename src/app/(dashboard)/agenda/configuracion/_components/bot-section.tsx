'use client'

// ============================================================
// Pestaña "Bot y recordatorios": textos editables del flujo de
// reservas (overrides en booking_settings.bot_texts; vacío = texto
// por defecto) y el interruptor de la segunda señal de 2 h.
// El recordatorio de 24 h es siempre activo (Fase 3).
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { truncate } from '@/verticals/agenda/agent/format'
import {
  BOT_TEXT_MAX_LENGTH,
  botTextDefault,
  EDITABLE_BOT_TEXT_KEYS,
} from '@/verticals/agenda/bot-texts'
import {
  AGENDA_TEXTS as T,
  type EditableBotTextKey,
} from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { SettingsRow } from './types'

type TextDrafts = Record<EditableBotTextKey, string>

/** Overrides de la fila → borrador por clave (tolera basura). */
function draftsFrom(overrides: Record<string, string>): TextDrafts {
  const out = {} as TextDrafts
  for (const key of EDITABLE_BOT_TEXT_KEYS) {
    const value = overrides[key]
    out[key] = typeof value === 'string' ? value : ''
  }
  return out
}

interface BotSectionProps {
  settings: SettingsRow
  canEdit: boolean
  reload: () => Promise<void>
}

export function BotSection({ settings, canEdit, reload }: BotSectionProps) {
  const [texts, setTexts] = useState<TextDrafts>(() =>
    draftsFrom(settings.bot_texts),
  )
  const [savingTexts, setSavingTexts] = useState(false)
  const [textsError, setTextsError] = useState<string | null>(null)
  const [textsSaved, setTextsSaved] = useState(false)

  const [reminders2h, setReminders2h] = useState(settings.reminders_2h_enabled)
  const [savingToggle, setSavingToggle] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  async function toggle2h(next: boolean) {
    setReminders2h(next)
    setSavingToggle(true)
    setToggleError(null)
    const res = await agendaConfigApi.patchConfig({
      reminders_2h_enabled: next,
    })
    setSavingToggle(false)
    if (!res.ok) {
      // Revertir el switch: el cambio no quedó guardado.
      setReminders2h(!next)
      setToggleError(res.error)
      return
    }
    await reload()
  }

  async function saveTexts() {
    setSavingTexts(true)
    setTextsError(null)
    setTextsSaved(false)

    // Solo se guardan los overrides con contenido: vacío = default.
    const overrides: Record<string, string> = {}
    for (const key of EDITABLE_BOT_TEXT_KEYS) {
      const value = texts[key].trim()
      if (value) overrides[key] = value
    }

    const res = await agendaConfigApi.patchConfig({ bot_texts: overrides })
    setSavingTexts(false)
    if (!res.ok) {
      setTextsError(res.error)
      return
    }
    setTextsSaved(true)
    await reload()
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{T.config.reminders.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">
                {T.config.reminders.alwaysTitle}
              </p>
              <p className="text-xs text-muted-foreground">
                {T.config.reminders.alwaysBody}
              </p>
            </div>
            <Badge>{T.config.services.active}</Badge>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">
                {T.config.reminders.twoHourTitle}
              </p>
              <p className="text-xs text-muted-foreground">
                {T.config.reminders.twoHourBody}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {savingToggle && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
              <Switch
                checked={reminders2h}
                onCheckedChange={(next) => void toggle2h(next)}
                disabled={!canEdit || savingToggle}
              />
            </div>
          </div>

          {toggleError && (
            <Alert variant="destructive">
              <AlertDescription>{toggleError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{T.config.bot.title}</CardTitle>
          <CardDescription>{T.config.bot.hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {EDITABLE_BOT_TEXT_KEYS.map((key) => (
            <div key={key} className="space-y-2">
              <Label htmlFor={`bot-${key}`}>{T.config.bot.labels[key]}</Label>
              <p className="text-xs text-muted-foreground">
                {T.config.bot.hints[key]}
              </p>
              <Textarea
                id={`bot-${key}`}
                value={texts[key]}
                onChange={(e) =>
                  setTexts((prev) => ({ ...prev, [key]: e.target.value }))
                }
                disabled={!canEdit || savingTexts}
                maxLength={BOT_TEXT_MAX_LENGTH}
                rows={3}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {T.config.bot.defaultLabel}{' '}
                  {truncate(botTextDefault(key), 120)}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTexts((prev) => ({ ...prev, [key]: '' }))}
                  disabled={!canEdit || savingTexts || !texts[key]}
                >
                  {T.config.bot.useDefault}
                </Button>
              </div>
            </div>
          ))}

          {textsError && (
            <Alert variant="destructive">
              <AlertDescription>{textsError}</AlertDescription>
            </Alert>
          )}
          {textsSaved && !textsError && (
            <Alert>
              <AlertDescription>{T.config.saved}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end">
            <Button
              onClick={() => void saveTexts()}
              disabled={!canEdit || savingTexts}
            >
              {savingTexts && <Loader2 className="h-4 w-4 animate-spin" />}
              {savingTexts ? T.config.saving : T.config.bot.save}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
