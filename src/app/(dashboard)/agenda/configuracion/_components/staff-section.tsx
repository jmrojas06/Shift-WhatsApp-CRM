'use client'

// ============================================================
// Pestaña del equipo (quien atiende): crear, editar, activar/desactivar,
// reordenar y marcar qué servicios atiende cada uno
// (PUT /staff/[id]/services, aplicado por diff en el servidor).
// ============================================================

import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Loader2,
  Pencil,
  Plus,
  Users,
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
import { Checkbox } from '@/components/ui/checkbox'
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
import type { AgendaLabels } from '@/verticals/agenda/labels'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { ServiceRow, StaffRow, StaffServicesMap } from './types'

interface Draft {
  /** null = integrante nuevo. */
  id: string | null
  name: string
  bio: string
  serviceIds: string[]
}

interface StaffSectionProps {
  staff: StaffRow[]
  services: ServiceRow[]
  staffServices: StaffServicesMap
  labels: AgendaLabels
  canEdit: boolean
  reload: () => Promise<void>
}

export function StaffSection({
  staff,
  services,
  staffServices,
  labels,
  canEdit,
  reload,
}: StaffSectionProps) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  function openCreate() {
    setFormError(null)
    setDraft({ id: null, name: '', bio: '', serviceIds: [] })
  }

  function openEdit(row: StaffRow) {
    setFormError(null)
    setDraft({
      id: row.id,
      name: row.name,
      bio: row.bio ?? '',
      serviceIds: [...(staffServices[row.id] ?? [])],
    })
  }

  function toggleService(serviceId: string) {
    if (!draft) return
    const has = draft.serviceIds.includes(serviceId)
    setDraft({
      ...draft,
      serviceIds: has
        ? draft.serviceIds.filter((id) => id !== serviceId)
        : [...draft.serviceIds, serviceId],
    })
  }

  async function saveDraft() {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setFormError(T.config.validation.nameRequired)
      return
    }

    setSaving(true)
    setFormError(null)
    const bio = draft.bio.trim() || null

    if (draft.id) {
      const res = await agendaConfigApi.updateStaff(draft.id, { name, bio })
      if (!res.ok) {
        setFormError(res.error)
        setSaving(false)
        return
      }
      const links = await agendaConfigApi.setStaffServices(
        draft.id,
        draft.serviceIds,
      )
      if (!links.ok) {
        setFormError(links.error)
        setSaving(false)
        return
      }
    } else {
      const res = await agendaConfigApi.createStaff({ name, bio })
      if (!res.ok) {
        setFormError(res.error)
        setSaving(false)
        return
      }
      if (draft.serviceIds.length > 0) {
        const links = await agendaConfigApi.setStaffServices(
          res.data.staff.id,
          draft.serviceIds,
        )
        if (!links.ok) {
          setFormError(links.error)
          setSaving(false)
          return
        }
      }
    }

    setSaving(false)
    setDraft(null)
    await reload()
  }

  async function toggleActive(row: StaffRow) {
    setBusyId(row.id)
    setListError(null)
    const res = await agendaConfigApi.updateStaff(row.id, {
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
    if (target < 0 || target >= staff.length) return
    const ids = staff.map((s) => s.id)
    const swap = ids[index]
    ids[index] = ids[target]
    ids[target] = swap

    setBusyId(staff[index].id)
    setListError(null)
    const res = await agendaConfigApi.reorderStaff(ids)
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
        <CardTitle>{T.config.staff.title(labels)}</CardTitle>
        <CardAction>
          <Button
            size="sm"
            onClick={openCreate}
            disabled={!canEdit || busyId !== null}
            title={canEdit ? undefined : T.config.viewerGate}
          >
            <Plus className="h-4 w-4" />
            {T.config.staff.add(labels)}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {listError && (
          <Alert variant="destructive">
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}

        {staff.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Users className="mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {T.config.staff.empty(labels)}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {staff.map((member, index) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {member.name}
                    <Badge
                      variant={member.is_active ? 'default' : 'outline'}
                      className="ml-2"
                    >
                      {member.is_active
                        ? T.config.staff.active
                        : T.config.staff.inactive}
                    </Badge>
                  </p>
                  {member.bio && (
                    <p className="text-xs text-muted-foreground">
                      {member.bio}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {T.config.staff.servicesTitle}:{' '}
                    {(staffServices[member.id] ?? []).length}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void move(index, -1)}
                    disabled={!canEdit || busyId !== null || index === 0}
                    aria-label={T.config.services.moveUp}
                    title={T.config.services.moveUp}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void move(index, 1)}
                    disabled={
                      !canEdit || busyId !== null || index === staff.length - 1
                    }
                    aria-label={T.config.services.moveDown}
                    title={T.config.services.moveDown}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEdit(member)}
                    disabled={!canEdit || busyId !== null}
                  >
                    <Pencil className="h-4 w-4" />
                    {T.config.actions.edit}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void toggleActive(member)}
                    disabled={!canEdit || busyId !== null}
                  >
                    {busyId === member.id && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    {member.is_active
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
                ? T.config.staff.editTitle(labels)
                : T.config.staff.createTitle(labels)}
            </DialogTitle>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="staff-name">{T.config.staff.name}</Label>
                <Input
                  id="staff-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  disabled={saving}
                  maxLength={80}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="staff-bio">{T.config.staff.bio}</Label>
                <Textarea
                  id="staff-bio"
                  value={draft.bio}
                  onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                  placeholder={T.config.staff.bioPlaceholder}
                  disabled={saving}
                  maxLength={300}
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">
                  {T.config.staff.bioHint}
                </p>
              </div>

              <div className="space-y-2">
                <Label>{T.config.staff.servicesTitle}</Label>
                <p className="text-xs text-muted-foreground">
                  {T.config.staff.servicesHint}
                </p>
                {services.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {T.config.staff.noServicesAvailable(labels)}
                  </p>
                ) : (
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border p-3">
                    {services.map((service) => (
                      <div
                        key={service.id}
                        className="flex items-center gap-3"
                      >
                        <Checkbox
                          id={`staff-svc-${service.id}`}
                          checked={draft.serviceIds.includes(service.id)}
                          onCheckedChange={() => toggleService(service.id)}
                          disabled={saving}
                        />
                        <label
                          htmlFor={`staff-svc-${service.id}`}
                          className="text-sm"
                        >
                          {service.name}
                          {!service.is_active && (
                            <Badge variant="outline" className="ml-2">
                              {T.config.services.inactive}
                            </Badge>
                          )}
                        </label>
                      </div>
                    ))}
                  </div>
                )}
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
              {saving ? T.config.saving : T.config.staff.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
