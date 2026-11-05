'use client'

// ============================================================
// Detalle de una cita, con sus acciones.
//
// Tres pantallas dentro del mismo diálogo (así en el celular no se
// apilan ventanas):
//   - detalle: datos, estado, Atendida / No vino, Mover, Cancelar y
//     Abrir conversación.
//   - mover:   día, hora y profesional nuevos (+ avisar al paciente).
//   - cancelar: confirmación con motivo y aviso opcionales.
//
// Todo se guarda por las rutas de la API (calendar-api.ts); este
// archivo no escribe en la base. Un viewer ve el detalle sin botones
// de escritura.
// ============================================================

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CalendarClock, CalendarX, Check, CheckCheck, Loader2, MessageSquare, Phone, UserX } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatLongDate, formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts, zonedTimeToUtc } from '@/verticals/agenda/agent/time'
import { canMove } from '@/verticals/agenda/panel-booking'
import type { AppointmentStatus } from '@/verticals/agenda/appointments'
import type { CalendarApi } from '@/verticals/agenda/calendar-api'
import { appointmentTitle, type CalendarAppointment, type CalendarData } from '@/verticals/agenda/calendar-data'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import type { AgendaLabels } from '@/verticals/agenda/labels'

import { STATUS_VISUAL } from './calendar-status'
import { DialogFrame } from './dialog-frame'
import { SlotPicker } from './slot-picker'

interface AppointmentDetailDialogProps {
  appointment: CalendarAppointment
  data: CalendarData
  labels: AgendaLabels
  /** El rol puede escribir (agent o más). Un viewer solo mira. */
  canWrite: boolean
  api: CalendarApi
  now: Date
  todayKey: string
  /** Para la vista previa: el enlace a la conversación no lleva a ningún lado. */
  conversationHref?: (conversationId: string) => string
  onClose: () => void
  /** Se guardó algo: la pantalla debe recargar las citas. */
  onChanged: () => void
}

type Mode = 'detail' | 'move' | 'cancel'

const ANY = 'any'

/** Que "a. m." no se parta en dos renglones: los espacios internos no se rompen. */
const NBSP = String.fromCharCode(160)
const keepTogether = (label: string): string =>
  label.replace(/ ([ap])\. m\./, `${NBSP}$1.${NBSP}m.`)

/** "9:00 a. m. a 9:45 a. m." */
function timeRange(a: CalendarAppointment): string {
  const from = keepTogether(formatTimeLabel(zonedParts(a.startsAt)))
  const to = keepTogether(formatTimeLabel(zonedParts(a.endsAt)))
  return `${from} a ${to}`
}

function summaryOf(a: CalendarAppointment): string {
  const parts = zonedParts(a.startsAt)
  return `${appointmentTitle(a, T.noName)}, ${formatLongDate(parts.dateKey)}, ${keepTogether(formatTimeLabel(parts))}`
}

export function AppointmentDetailDialog(props: AppointmentDetailDialogProps) {
  const { appointment: a } = props
  const [mode, setMode] = useState<Mode>('detail')
  const [busy, setBusy] = useState(false)

  const hasStarted = a.startsAt.getTime() < props.now.getTime()

  // Mientras se guarda no se cierra el diálogo: se perdería el resultado.
  const close = () => {
    if (!busy) props.onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-md">
        {mode === 'detail' && (
          <DetailView
            {...props}
            hasStarted={hasStarted}
            busy={busy}
            setBusy={setBusy}
            onMove={() => setMode('move')}
            onCancel={() => setMode('cancel')}
          />
        )}
        {mode === 'move' && (
          <MoveView {...props} busy={busy} setBusy={setBusy} onBack={() => setMode('detail')} />
        )}
        {mode === 'cancel' && (
          <CancelView
            {...props}
            hasStarted={hasStarted}
            busy={busy}
            setBusy={setBusy}
            onBack={() => setMode('detail')}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------
// Detalle
// ------------------------------------------------------------

function DetailView(
  props: AppointmentDetailDialogProps & {
    hasStarted: boolean
    busy: boolean
    setBusy: (busy: boolean) => void
    onMove: () => void
    onCancel: () => void
  },
) {
  const { appointment: a, data, labels, canWrite, api, busy, setBusy } = props
  const visual = STATUS_VISUAL[a.status]
  const editable = a.status === 'pending' || a.status === 'confirmed'
  const movable = canMove(a.status, a.startsAt, props.now)
  const staffName = data.staff.find((s) => s.id === a.staffId)?.name ?? T.noStaffAssigned
  const [error, setError] = useState<string | null>(null)
  const [pastFor, setPastFor] = useState<AppointmentStatus | null>(null)
  const parts = zonedParts(a.startsAt)
  const who = appointmentTitle(a, T.noName)
  const conversationHref = props.conversationHref ?? ((id: string) => `/inbox?c=${id}`)

  const changeStatus = async (status: AppointmentStatus, confirmPast: boolean) => {
    setError(null)
    setBusy(true)
    const res = await api.setStatus(a.id, status, confirmPast)
    setBusy(false)
    if (!res.ok) {
      if (res.status === 409 && res.code === 'past_confirmation_required') {
        setPastFor(status)
        return
      }
      setError(res.error || T.detail.statusFailed)
      if (res.code === 'stale') props.onChanged()
      return
    }
    toast.success(T.detail.statusDone)
    props.onChanged()
    props.onClose()
  }

  return (
    <DialogFrame
      notice={
        <>
          {pastFor && (
            <Alert role="alert" className="border-warning/40">
              <AlertDescription className="grid gap-2">
                <p className="font-medium text-foreground">{T.detail.pastTitle}</p>
                <p>{T.detail.pastBody}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" disabled={busy} onClick={() => void changeStatus(pastFor, true)}>
                    {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {T.detail.pastConfirm}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setPastFor(null)}>
                    {T.detail.pastBack}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </>
      }
      footer={
        <>
          {a.conversationId && (
            <Link
              href={conversationHref(a.conversationId)}
              className={cn(buttonVariants({ variant: 'outline' }), 'sm:mr-auto')}
            >
              <MessageSquare aria-hidden="true" />
              {T.detail.openConversation}
            </Link>
          )}
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            {T.detail.close}
          </Button>
        </>
      }
    >
      <DialogHeader className="pr-8">
        <DialogTitle className="text-lg leading-snug">{who}</DialogTitle>
        <DialogDescription className="first-letter:uppercase">
          {formatLongDate(parts.dateKey)}, {timeRange(a)}
        </DialogDescription>
      </DialogHeader>

      <dl className="grid gap-3 text-sm">
        <Row label={T.detail.state}>
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={visual.badge}>{visual.label}</Badge>
            {a.patientConfirmed && (a.status === 'confirmed' || a.status === 'pending') && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                <CheckCheck className="size-3.5" aria-hidden="true" />
                {T.patientConfirmed}
              </span>
            )}
          </span>
        </Row>
        {a.patientName && (
          <Row label={T.detail.patient}>{a.patientName}</Row>
        )}
        <Row label={T.detail.who}>
          {a.contactName?.trim() || T.noName}
        </Row>
        {a.contactPhone && (
          <Row label={T.detail.phone}>
            <a
              href={`tel:${a.contactPhone}`}
              className="inline-flex items-center gap-1.5 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Phone className="size-3.5" aria-hidden="true" />
              {a.contactPhone}
            </a>
          </Row>
        )}
        <Row label={T.detail.service(labels)}>{a.serviceName ?? T.noService}</Row>
        <Row label={T.detail.staff(labels)}>{staffName}</Row>
      </dl>

      {!canWrite ? (
        <p className="text-sm text-muted-foreground">{T.detail.readOnly}</p>
      ) : !editable ? (
        <p className="text-sm text-muted-foreground">{T.detail.closedState(visual.label)}</p>
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={() => void changeStatus('completed', false)}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              {T.detail.complete}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void changeStatus('no_show', false)}>
              <UserX aria-hidden="true" />
              {T.detail.noShow}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={busy || !movable} onClick={props.onMove}>
              <CalendarClock aria-hidden="true" />
              {T.detail.move}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={props.onCancel}>
              <CalendarX aria-hidden="true" />
              {T.detail.cancel(labels)}
            </Button>
          </div>
          {!movable && <p className="text-xs text-muted-foreground">{T.detail.cannotMovePast}</p>}
        </div>
      )}
    </DialogFrame>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{children}</dd>
    </div>
  )
}

// ------------------------------------------------------------
// Mover
// ------------------------------------------------------------

function MoveView(
  props: AppointmentDetailDialogProps & {
    busy: boolean
    setBusy: (busy: boolean) => void
    onBack: () => void
  },
) {
  const { appointment: a, data, labels, api, busy, setBusy, todayKey } = props
  const current = zonedParts(a.startsAt)

  const staffForService = useMemo(() => {
    if (!a.serviceId) return data.staff.filter((s) => s.id === a.staffId)
    return data.staff.filter(
      (s) => s.isActive && data.staffServices.some((l) => l.staffId === s.id && l.serviceId === a.serviceId),
    )
  }, [data.staff, data.staffServices, a.serviceId, a.staffId])

  const [staffChoice, setStaffChoice] = useState<string>(a.staffId ?? ANY)
  const effectiveChoice =
    staffChoice === ANY || staffForService.some((s) => s.id === staffChoice) ? staffChoice : ANY
  const [dateKey, setDateKey] = useState(current.dateKey < todayKey ? todayKey : current.dateKey)
  const [time, setTime] = useState('')
  const [slotStaff, setSlotStaff] = useState<string[] | null>(null)
  const [notify, setNotify] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [outsidePrompt, setOutsidePrompt] = useState(false)

  const staffName = (id: string | null) => data.staff.find((s) => s.id === id)?.name ?? ''

  const submit = async (outsideHoursOk: boolean) => {
    setError(null)
    if (!time) return setError(T.newDialog.timeRequired)

    let staffId = effectiveChoice
    if (staffId === ANY) {
      const free = slotStaff?.[0]
      if (!free) return setError(T.newDialog.staffPlaceholder)
      staffId = free
    }

    const startsAt = zonedTimeToUtc(dateKey, time)
    if (startsAt.getTime() === a.startsAt.getTime() && staffId === a.staffId) {
      return setError(T.move.sameTime)
    }

    setBusy(true)
    const res = await api.move(a.id, { startsAtIso: startsAt.toISOString(), staffId, notify, outsideHoursOk })
    setBusy(false)

    if (!res.ok) {
      if (res.code === 'outside_hours') {
        setOutsidePrompt(true)
        return
      }
      setOutsidePrompt(false)
      setError(res.error || T.move.failed)
      if (res.code === 'stale') props.onChanged()
      return
    }

    if (res.data.notifyError) {
      toast.warning(T.doneNotifyFailed, { description: res.data.notifyError })
    } else {
      toast.success(T.move.done(labels))
    }
    props.onChanged()
    props.onClose()
  }

  const promptStaff = staffName(effectiveChoice === ANY ? (slotStaff?.[0] ?? null) : effectiveChoice)

  return (
    <DialogFrame
      notice={
        <>
          {outsidePrompt && (
            <Alert role="alert" className="border-warning/40">
              <AlertDescription className="grid gap-2">
                <p className="font-medium text-foreground">
                  {T.newDialog.outsideTitle(promptStaff || T.move.staff(labels).toLowerCase())}
                </p>
                <p>{T.newDialog.outsideBody}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button type="button" size="sm" disabled={busy} onClick={() => void submit(true)}>
                    {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {T.newDialog.outsideConfirm}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setOutsidePrompt(false)}>
                    {T.newDialog.outsideBack}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </>
      }
      onSubmit={() => {
        if (!busy) void submit(false)
      }}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={props.onBack}>
            <ArrowLeft aria-hidden="true" />
            {T.move.back}
          </Button>
          <Button type="submit" disabled={busy || outsidePrompt}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? T.move.saving : T.move.save}
          </Button>
        </>
      }
    >
      <DialogHeader className="pr-8">
        <DialogTitle className="text-lg">{T.move.title(labels)}</DialogTitle>
        <DialogDescription>{T.move.description(summaryOf(a))}</DialogDescription>
      </DialogHeader>

      {staffForService.length > 1 && (
        <div className="grid gap-2">
          <Label htmlFor="move-staff">{T.move.staff(labels)}</Label>
          <Select
            value={effectiveChoice}
            onValueChange={(value) => {
              setStaffChoice(value ?? ANY)
              setOutsidePrompt(false)
            }}
          >
            <SelectTrigger id="move-staff" className="w-full">
              <SelectValue>
                {(value: string | null) =>
                  value && value !== ANY ? staffName(value) : T.newDialog.staffAny
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              <SelectItem value={ANY}>{T.newDialog.staffAny}</SelectItem>
              {staffForService.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <SlotPicker
        idPrefix="move"
        api={api}
        serviceId={a.serviceId}
        staffId={effectiveChoice === ANY ? null : effectiveChoice}
        excludeId={a.id}
        dateKey={dateKey}
        onDateChange={(next) => {
          setDateKey(next)
          setOutsidePrompt(false)
        }}
        time={time}
        onTimeChange={(next, staffIds) => {
          setTime(next)
          setSlotStaff(staffIds)
          setOutsidePrompt(false)
          setError(null)
        }}
        minDateKey={todayKey}
      />
      {effectiveChoice === ANY && slotStaff?.[0] && (
        <p className="-mt-3 text-sm text-muted-foreground">
          {T.move.staff(labels)}: <span className="font-medium text-foreground">{staffName(slotStaff[0])}</span>
        </p>
      )}

      <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
        <Switch id="move-notify" checked={notify} onCheckedChange={setNotify} className="mt-0.5" />
        <div className="grid gap-0.5">
          <Label htmlFor="move-notify" className="cursor-pointer leading-snug">
            {T.move.notify}
          </Label>
          <p className="text-xs text-muted-foreground">{T.move.notifyHint}</p>
        </div>
      </div>
    </DialogFrame>
  )
}

// ------------------------------------------------------------
// Cancelar
// ------------------------------------------------------------

function CancelView(
  props: AppointmentDetailDialogProps & {
    hasStarted: boolean
    busy: boolean
    setBusy: (busy: boolean) => void
    onBack: () => void
  },
) {
  const { appointment: a, labels, api, busy, setBusy, hasStarted } = props
  const [reason, setReason] = useState('')
  // Cancelar algo que ya pasó casi nunca necesita avisarle al paciente.
  const [notify, setNotify] = useState(!hasStarted)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    setBusy(true)
    const res = await api.cancel(a.id, { reason, notify, confirmPast: hasStarted })
    setBusy(false)
    if (!res.ok) {
      setError(res.error || T.cancel.failed)
      if (res.code === 'stale') props.onChanged()
      return
    }
    if (res.data.notifyError) {
      toast.warning(T.doneNotifyFailed, { description: res.data.notifyError })
    } else {
      toast.success(T.cancel.done(labels))
    }
    props.onChanged()
    props.onClose()
  }

  return (
    <DialogFrame
      notice={
        <>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </>
      }
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={props.onBack}>
            <ArrowLeft aria-hidden="true" />
            {T.cancel.back}
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void submit()}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? T.cancel.saving : T.cancel.confirm(labels)}
          </Button>
        </>
      }
    >
      <DialogHeader className="pr-8">
        <DialogTitle className="text-lg">{T.cancel.title(labels)}</DialogTitle>
        <DialogDescription>{T.cancel.description(summaryOf(a))}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor="cancel-reason">{T.cancel.reason}</Label>
        <Textarea
          id="cancel-reason"
          value={reason}
          maxLength={200}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
          placeholder={T.cancel.reasonPlaceholder}
          aria-describedby="cancel-reason-hint"
          className="min-h-16"
        />
        <p id="cancel-reason-hint" className="text-xs text-muted-foreground">
          {T.cancel.reasonHint}
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
        <Switch id="cancel-notify" checked={notify} onCheckedChange={setNotify} className="mt-0.5" />
        <div className="grid gap-0.5">
          <Label htmlFor="cancel-notify" className="cursor-pointer leading-snug">
            {T.cancel.notify}
          </Label>
          <p className="text-xs text-muted-foreground">{T.cancel.notifyHint}</p>
        </div>
      </div>
    </DialogFrame>
  )
}
