'use client'

// ============================================================
// Pestaña "Negocio": nombre (PATCH /api/account, core + RLS),
// dirección y moneda (PATCH /api/verticals/agenda/config).
// La zona horaria es fija (America/Bogota) y solo se muestra.
// ============================================================

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/hooks/use-auth'
import { CURRENCIES } from '@/lib/currency'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { SettingsRow } from './types'

interface BusinessSectionProps {
  settings: SettingsRow
  canEdit: boolean
  reload: () => Promise<void>
}

export function BusinessSection({
  settings,
  canEdit,
  reload,
}: BusinessSectionProps) {
  const { account, defaultCurrency, refreshProfile } = useAuth()

  const [name, setName] = useState(account?.name ?? '')
  const [address, setAddress] = useState(settings.address ?? '')
  const [currency, setCurrency] = useState(defaultCurrency)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(T.config.validation.nameRequired)
      return
    }

    setSaving(true)
    setError(null)
    setSaved(false)

    // El nombre vive en `accounts` (ruta core): se guarda aparte y
    // se refresca el perfil para que el resto de la app lo vea.
    if (trimmedName !== account?.name) {
      const rename = await agendaConfigApi.renameAccount(trimmedName)
      if (!rename.ok) {
        setError(rename.error)
        setSaving(false)
        return
      }
      await refreshProfile()
    }

    const res = await agendaConfigApi.patchConfig({
      address: address.trim() || null,
      currency,
    })
    if (!res.ok) {
      setError(res.error)
      setSaving(false)
      return
    }

    setSaved(true)
    await reload()
    setSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.config.business.title}</CardTitle>
        <CardDescription>{T.config.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="business-name">{T.config.business.name}</Label>
          <Input
            id="business-name"
            value={name}
            onChange={(e) => {
              setSaved(false)
              setName(e.target.value)
            }}
            disabled={!canEdit || saving}
            maxLength={80}
          />
          <p className="text-xs text-muted-foreground">
            {T.config.business.nameHint}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="business-address">
            {T.config.business.address}
          </Label>
          <Input
            id="business-address"
            value={address}
            onChange={(e) => {
              setSaved(false)
              setAddress(e.target.value)
            }}
            placeholder={T.config.business.addressPlaceholder}
            disabled={!canEdit || saving}
            maxLength={200}
          />
          <p className="text-xs text-muted-foreground">
            {T.config.business.addressHint}
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="business-timezone">{T.config.business.timezone}</Label>
            <Input
              id="business-timezone"
              value={T.config.business.timezoneValue}
              disabled
            />
            <p className="text-xs text-muted-foreground">
              {T.config.business.timezoneHint}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="business-currency">
              {T.config.business.currency}
            </Label>
            <Select
              value={currency}
              onValueChange={(value) => {
                if (value) {
                  setSaved(false)
                  setCurrency(value)
                }
              }}
              disabled={!canEdit || saving}
            >
              <SelectTrigger id="business-currency" className="w-full">
                <SelectValue>
                  {(value: string | null) => {
                    const option = CURRENCIES.find((c) => c.code === value)
                    return option
                      ? `${option.code} — ${option.label}`
                      : (value ?? '')
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((option) => (
                  <SelectItem key={option.code} value={option.code}>
                    {option.code} — {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {T.config.business.currencyHint}
            </p>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {saved && !error && (
          <Alert role="status">
            <AlertDescription>{T.config.saved}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end">
          <Button onClick={() => void handleSave()} disabled={!canEdit || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? T.config.saving : T.config.business.save}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
