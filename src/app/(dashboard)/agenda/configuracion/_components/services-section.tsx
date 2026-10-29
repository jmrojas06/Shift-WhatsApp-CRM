'use client'

// ============================================================
// Pestaña "Servicios": crear, editar, activar/desactivar y
// reordenar el catálogo. Desactivar nunca borra: la cita guarda su
// propio service_id y el historial queda intacto.
// ============================================================

import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  Loader2,
  Pencil,
  Plus,
} from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import type { AgendaLabels } from '@/verticals/agenda/labels'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { ServiceRow } from './types'

const PRICE_MAX = 99_999_999.99

interface Draft {
  /** null = servicio nuevo. */
  id: string | null
  name: string
  description: string
  duration: string
  price: string
}

const NEW_DRAFT: Draft = {
  id: null,
  name: '',
  description: '',
  duration: '30',
  price: '',
}

interface ServicesSectionProps {
  services: ServiceRow[]
  labels: AgendaLabels
  canEdit: boolean
  reload: () => Promise<void>
}

export function ServicesSection({
  services,
  labels,
  canEdit,
  reload,
}: ServicesSectionProps) {
  const { defaultCurrency } = useAuth()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  function openCreate() {
    setFormError(null)
    setDraft(NEW_DRAFT)
  }

  function openEdit(row: ServiceRow) {
    setFormError(null)
    setDraft({
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      duration: String(row.duration_minutes),
      price: String(row.price),
    })
  }

  async function saveDraft() {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setFormError(T.config.validation.nameRequired)
      return
    }
    const duration = Number(draft.duration)
    if (!Number.isInteger(duration) || duration < 1 || duration > 480) {
      setFormError(T.config.validation.durationInvalid)
      return
    }
    const price = Number(draft.price)
    if (!Number.isFinite(price) || price < 0 || price > PRICE_MAX) {
      setFormError(T.config.validation.priceInvalid)
      return
    }

    setSaving(true)
    setFormError(null)
    const body = {
      name,
      description: draft.description.trim() || null,
      duration_minutes: duration,
      price,
    }
    const res = draft.id
      ? await agendaConfigApi.updateService(draft.id, body)
      : await agendaConfigApi.createService(body)
    setSaving(false)
    if (!res.ok) {
      setFormError(res.error)
      return
    }
    setDraft(null)
    await reload()
  }

  async function toggleActive(row: ServiceRow) {
    setBusyId(row.id)
    setListError(null)
    const res = await agendaConfigApi.updateService(row.id, {
      is_active: !row.is_active,
    })
    setBusyId(null)
    if (!res.ok) {
      setListError(res.error)
      return
    }
    await reload()
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= services.length) return
    const ids = services.map((s) => s.id)
    const swap = ids[index]
    ids[index] = ids[target]
    ids[target] = swap

    setBusyId(services[index].id)
    setListError(null)
    const res = await agendaConfigApi.reorderServices(ids)
    setBusyId(null)
    if (!res.ok) {
      setListError(res.error)
      return
    }
    await reload()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.config.services.title(labels)}</CardTitle>
        <CardAction>
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            onClick={openCreate}
            disabled={!canEdit || busyId !== null}
            title={canEdit ? undefined : T.readOnly(T.config.viewerGate)}
          >
            <Plus className="h-4 w-4" />
            {T.config.services.add(labels)}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {T.config.services.activeHint}
        </p>

        {listError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}

        {services.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <ClipboardList className="mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {T.config.services.empty(labels)}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {services.map((service, index) => (
              <li
                key={service.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 break-words">
                  <p className="text-sm font-medium">
                    {service.name}
                    <Badge
                      variant={service.is_active ? 'default' : 'outline'}
                      className="ml-2"
                    >
                      {service.is_active
                        ? T.config.services.active
                        : T.config.services.inactive}
                    </Badge>
                  </p>
                  {service.description && (
                    <p className="text-xs text-muted-foreground">
                      {service.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(Number(service.price), defaultCurrency)} ·{' '}
                    {service.duration_minutes} min
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="pointer-coarse:size-11"
                    onClick={() => void move(index, -1)}
                    disabled={!canEdit || busyId !== null || index === 0}
                    aria-label={T.config.services.moveUp}
                    title={T.config.services.moveUp}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="pointer-coarse:size-11"
                    onClick={() => void move(index, 1)}
                    disabled={
                      !canEdit ||
                      busyId !== null ||
                      index === services.length - 1
                    }
                    aria-label={T.config.services.moveDown}
                    title={T.config.services.moveDown}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    onClick={() => openEdit(service)}
                    disabled={!canEdit || busyId !== null}
                  >
                    <Pencil className="h-4 w-4" />
                    {T.config.actions.edit}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    onClick={() => void toggleActive(service)}
                    disabled={!canEdit || busyId !== null}
                  >
                    {busyId === service.id && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    {service.is_active
                      ? T.config.actions.deactivate
                      : T.config.actions.activate}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {draft?.id
                ? T.config.services.editTitle(labels)
                : T.config.services.createTitle(labels)}
            </DialogTitle>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="svc-name">{T.config.services.name}</Label>
                <Input
                  id="svc-name"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.target.value })
                  }
                  disabled={saving}
                  maxLength={80}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="svc-desc">
                  {T.config.services.description}
                </Label>
                <Textarea
                  id="svc-desc"
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                  placeholder={T.config.services.descriptionPlaceholder}
                  disabled={saving}
                  maxLength={300}
                  rows={2}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="svc-duration">
                    {T.config.services.duration}
                  </Label>
                  <Input
                    id="svc-duration"
                    type="number"
                    min={1}
                    max={480}
                    step={1}
                    value={draft.duration}
                    onChange={(e) =>
                      setDraft({ ...draft, duration: e.target.value })
                    }
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="svc-price">{T.config.services.price}</Label>
                  <Input
                    id="svc-price"
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.price}
                    onChange={(e) =>
                      setDraft({ ...draft, price: e.target.value })
                    }
                    disabled={saving}
                  />
                </div>
              </div>

              {formError && (
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDraft(null)}
              disabled={saving}
            >
              {T.config.actions.cancel}
            </Button>
            <Button onClick={() => void saveDraft()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? T.config.saving : T.config.services.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
