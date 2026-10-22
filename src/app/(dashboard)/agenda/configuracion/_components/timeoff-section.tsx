'use client'

// ============================================================
// Pestaña "Bloqueos": rangos puntuales (vacaciones, diligencias)
// por barbero. Se guardan como timestamptz y se capturan/muestran
// en hora de Bogotá: el input datetime-local no conoce la zona, así
// que se convierte con zonedTimeToUtc/zonedParts.
// ============================================================

import { useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatLongDate, formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts, zonedTimeToUtc } from '@/verticals/agenda/agent/time'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

import { agendaConfigApi } from './api'
import type { StaffRow, TimeOffRow } from './types'

/** 'YYYY-MM-DDTHH:MM' de Bogotá → ISO UTC; null si está incompleto. */
function isoFromInputValue(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
  if (!match) return null
  return zonedTimeToUtc(match[1], match[2]).toISOString()
}

/** 'martes 20 de octubre de 2026, 8:00 a. m. → …' en hora de Bogotá. */
function rangeLabel(row: TimeOffRow): string {
  const start = zonedParts(new Date(row.starts_at))
  const end = zonedParts(new Date(row.ends_at))
  return `${formatLongDate(start.dateKey)}, ${formatTimeLabel(start)} → ${formatLongDate(end.dateKey)}, ${formatTimeLabel(end)}`
}

interface TimeOffSectionProps {
  staff: StaffRow[]
  timeOff: TimeOffRow[]
  canEdit: boolean
  reload: () => Promise<void>
}

export function TimeOffSection({
  staff,
  timeOff,
  canEdit,
  reload,
}: TimeOffSectionProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<TimeOffRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const activeStaffId = useMemo(() => {
    if (staff.length === 0) return null
    return staff.some((s) => s.id === selectedId) ? selectedId : staff[0].id
  }, [staff, selectedId])

  const staffName = (id: string) =>
    staff.find((member) => member.id === id)?.name ?? '—'

  // Instante del render para separar próximos de pasados. `new
  // Date()` (a diferencia de Date.now) no la marca el lint de pureza
  // de React y el render no necesita reactividad al reloj.
  const now = new Date().getTime()
  const ordered = useMemo(
    () =>
      [...timeOff].sort(
        (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
      ),
    [timeOff],
  )
  const upcoming = ordered.filter((row) => Date.parse(row.ends_at) >= now)
  const past = ordered
    .filter((row) => Date.parse(row.ends_at) < now)
    .reverse()

  async function handleAdd() {
    if (!activeStaffId) return
    const startsAt = isoFromInputValue(from)
    const endsAt = isoFromInputValue(to)
    if (!startsAt || !endsAt) {
      setError(T.config.validation.invalidDateTime)
      return
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      setError(T.config.validation.endBeforeStart)
      return
    }

    setAdding(true)
    setError(null)
    const res = await agendaConfigApi.createTimeOff({
      staff_id: activeStaffId,
      starts_at: startsAt,
      ends_at: endsAt,
      reason: reason.trim() || null,
    })
    setAdding(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setFrom('')
    setTo('')
    setReason('')
    await reload()
  }

  async function handleDelete() {
    if (!deleting) return
    setDeleteBusy(true)
    const res = await agendaConfigApi.deleteTimeOff(deleting.id)
    setDeleteBusy(false)
    setDeleting(null)
    if (!res.ok) {
      setError(res.error)
      return
    }
    await reload()
  }

  function renderRow(row: TimeOffRow, muted: boolean) {
    return (
      <li
        key={row.id}
        className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
      >
        <div className={muted ? 'min-w-0 text-muted-foreground' : 'min-w-0'}>
          <p className="text-sm font-medium">{staffName(row.staff_id)}</p>
          <p className="text-xs text-muted-foreground">{rangeLabel(row)}</p>
          {row.reason && (
            <p className="text-xs text-muted-foreground">{row.reason}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDeleting(row)}
          disabled={!canEdit || deleteBusy}
          aria-label={T.config.timeOff.delete}
          title={T.config.timeOff.delete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </li>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.config.timeOff.title}</CardTitle>
        <CardDescription>{T.config.timeOff.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {staff.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {T.config.timeOff.pickStaffEmpty}
          </p>
        ) : (
          <>
            <div className="space-y-4 rounded-md border border-border p-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="timeoff-staff">
                    {T.config.timeOff.pickStaff}
                  </Label>
                  <Select
                    value={activeStaffId ?? undefined}
                    onValueChange={setSelectedId}
                    disabled={adding}
                  >
                    <SelectTrigger id="timeoff-staff" className="w-full">
                      <SelectValue>
                        {(value: string | null) => {
                          const member = staff.find((s) => s.id === value)
                          if (!member) return T.config.timeOff.pickStaff
                          return member.is_active
                            ? member.name
                            : `${member.name} (${T.config.staff.inactive})`
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {staff.map((member) => (
                        <SelectItem key={member.id} value={member.id}>
                          {member.name}
                          {!member.is_active && ` (${T.config.staff.inactive})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeoff-from">{T.config.timeOff.from}</Label>
                  <Input
                    id="timeoff-from"
                    type="datetime-local"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    disabled={!canEdit || adding}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeoff-to">{T.config.timeOff.to}</Label>
                  <Input
                    id="timeoff-to"
                    type="datetime-local"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    disabled={!canEdit || adding}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="timeoff-reason">{T.config.timeOff.reason}</Label>
                <Input
                  id="timeoff-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={T.config.timeOff.reasonPlaceholder}
                  disabled={!canEdit || adding}
                  maxLength={120}
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={() => void handleAdd()}
                  disabled={!canEdit || adding}
                >
                  {adding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {T.config.timeOff.add}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {T.config.timeOff.upcoming}
              </p>
              {upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {T.config.timeOff.empty}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {upcoming.map((row) => renderRow(row, false))}
                </ul>
              )}
            </div>

            {past.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {T.config.timeOff.past}
                </p>
                <ul className="divide-y divide-border">
                  {past.map((row) => renderRow(row, true))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{T.config.timeOff.deleteTitle}</DialogTitle>
            <DialogDescription>{T.config.timeOff.deleteBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={deleteBusy}
            >
              {T.config.timeOff.deleteNo}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {T.config.timeOff.deleteYes}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
