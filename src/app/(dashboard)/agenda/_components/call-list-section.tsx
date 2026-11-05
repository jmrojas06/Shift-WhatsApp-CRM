'use client'

// ============================================================
// "Para llamar": las citas de las próximas 48 h que el paciente no ha
// confirmado y a las que le toca llamar a una persona (diseño §4.7).
//
// La lista y las anotaciones van por /api/verticals/agenda/calls; el cliente
// (`api`) se inyecta para que la vista previa de desarrollo use datos de
// ejemplo sin tocar la red. Cada fila deja llamar con un toque (`tel:`) y anotar
// cómo le fue: Confirmó, No contestó, Canceló (con aviso opcional por WhatsApp)
// y, en el menú, Número equivocado y "Llamar con el robot ahora".
//
// Un viewer ve la lista sin botones de acción. Si no hay nada que llamar, la
// sección no ocupa lugar en la página.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Bot,
  CalendarX,
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Phone,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  RefreshCw,
} from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts } from '@/verticals/agenda/agent/time'
import type { CallListApi, RecordedCall } from '@/verticals/agenda/call-list-api'
import type { CallListReason, CallListRow } from '@/verticals/agenda/call-list'
import {
  CALL_LIST_TEXTS as T,
  describeManualResult,
  describeRobotResult,
  formatAgo,
  formatPhoneDisplay,
  relativeDayLabel,
  telHref,
} from '@/verticals/agenda/call-list-texts'
import type { AgendaLabels } from '@/verticals/agenda/labels'
import type { ManualOutcome } from '@/verticals/agenda/manual-calls'

/** Filas que se ven antes de "Ver las demás". */
const VISIBLE_ROWS = 5
/** La lista se vuelve a leer sola cada minuto (el robot tarda en terminar). */
const REFRESH_MS = 60_000

const REASON_BADGE: Record<CallListReason, 'warning' | 'info' | 'outline'> = {
  reminder_unanswered: 'warning',
  robot_human: 'info',
  robot_advisor_missed: 'info',
  robot_no_response: 'warning',
  robot_failed: 'outline',
}

/** Errores después de los cuales lo que muestra la pantalla ya está viejo. */
const STALE_CODES = ['not_active', 'stale', 'already_confirmed', 'not_found']

type RowAction = ManualOutcome | 'robot'

export interface CallListSectionProps {
  api: CallListApi
  labels: AgendaLabels
  /** Quien puede anotar llamadas (owner, admin o agent). Un viewer solo mira. */
  canAct: boolean
  /** La página recarga sus otras listas cuando una cita cambió (confirmó o canceló). */
  onAppointmentChanged?: () => void
  /** Solo la vista previa: congela "ahora" para que las capturas sean iguales. */
  fixedNow?: Date
}

export function CallListSection({ api, labels, canAct, onAppointmentChanged, fixedNow }: CallListSectionProps) {
  const [rows, setRows] = useState<CallListRow[]>([])
  const [outboundEnabled, setOutboundEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  // Sin la migración 056 la sección no existe: no es un error que la recepción pueda arreglar.
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState<{ id: string; action: RowAction } | null>(null)
  const [cancelTarget, setCancelTarget] = useState<CallListRow | null>(null)
  const [cancelNotify, setCancelNotify] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [clock, setClock] = useState(() => fixedNow ?? new Date())
  const now = fixedNow ?? clock

  /** Aplica lo que respondió la lista: las filas, o por qué no se pudo leer. */
  const apply = useCallback((res: Awaited<ReturnType<CallListApi['list']>>) => {
    if (!res.ok) {
      if (res.code === 'migration_missing') setUnavailable(true)
      else setLoadFailed(true)
      setLoading(false)
      return
    }
    setRows(res.data.rows)
    setOutboundEnabled(res.data.outboundEnabled)
    setLoadFailed(false)
    setLoading(false)
  }, [])

  const load = useCallback(async () => {
    apply(await api.list())
  }, [api, apply])

  // La primera lectura; si el cliente cambia o la sección se va, la respuesta vieja se descarta.
  useEffect(() => {
    let alive = true
    void api.list().then((res) => {
      if (alive) apply(res)
    })
    return () => {
      alive = false
    }
  }, [api, apply])

  useEffect(() => {
    if (fixedNow) return
    const timer = setInterval(() => {
      setClock(new Date())
      void load()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [fixedNow, load])

  const announce = (outcome: ManualOutcome, data: RecordedCall) => {
    const description = data.note ?? undefined
    if (outcome === 'cancelled' && data.notified === false && data.notifyError) {
      toast.warning(T.cancelledNotNotified(labels), { description: data.notifyError })
    } else if (outcome === 'cancelled') {
      toast.success(T.done.cancelled(labels), { description })
    } else {
      toast.success(T.done[outcome], { description })
    }
  }

  /** Anota la llamada. true si la ruta lo aceptó. */
  const record = async (row: CallListRow, outcome: ManualOutcome, notify?: boolean): Promise<boolean> => {
    setBusy({ id: row.appointmentId, action: outcome })
    const res = await api.record({ appointmentId: row.appointmentId, outcome, notify })
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error || T.actionFailed)
      if (res.code && STALE_CODES.includes(res.code)) void load()
      return false
    }
    announce(outcome, res.data)
    void load()
    if (outcome === 'confirmed' || outcome === 'cancelled') onAppointmentChanged?.()
    return true
  }

  const callWithRobot = async (row: CallListRow) => {
    setBusy({ id: row.appointmentId, action: 'robot' })
    const res = await api.robotCall(row.appointmentId)
    setBusy(null)
    if (!res.ok) {
      toast.error(res.error || T.actionFailed)
      if (res.code && STALE_CODES.includes(res.code)) void load()
      return
    }
    toast.success(T.done.robot)
    void load()
  }

  if (unavailable) return null
  if (!loading && !loadFailed && rows.length === 0) return null

  const visible = showAll ? rows : rows.slice(0, VISIBLE_ROWS)
  const hidden = rows.length - visible.length

  return (
    <section aria-labelledby="call-list-title" className="min-w-0">
      <Card>
        <CardHeader>
          <CardTitle id="call-list-title" className="flex items-center gap-2.5 text-[15px] font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <PhoneCall className="size-4" aria-hidden="true" />
            </span>
            {T.title}
            {rows.length > 0 && <Badge variant="secondary">{rows.length}</Badge>}
          </CardTitle>
          {rows.length > 0 && (
            <CardDescription>
              {T.description(rows.length, labels)} {T.descriptionHint}
            </CardDescription>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          {loadFailed && (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>{T.loadError}</span>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RefreshCw aria-hidden="true" />
                  {T.retry}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {loading && rows.length === 0 ? (
            <CallListSkeleton />
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((row) => (
                <CallRowItem
                  key={row.appointmentId}
                  row={row}
                  now={now}
                  canAct={canAct}
                  outboundEnabled={outboundEnabled}
                  busyAction={busy?.id === row.appointmentId ? busy.action : null}
                  anyBusy={busy !== null}
                  onConfirmed={() => void record(row, 'confirmed')}
                  onNoResponse={() => void record(row, 'no_response')}
                  onWrongNumber={() => void record(row, 'wrong_number')}
                  onCancel={() => {
                    setCancelNotify(true)
                    setCancelTarget(row)
                  }}
                  onRobot={() => void callWithRobot(row)}
                />
              ))}
            </ul>
          )}

          {rows.length > VISIBLE_ROWS && (
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              aria-expanded={showAll}
              onClick={() => setShowAll((open) => !open)}
            >
              <ChevronDown className={showAll ? 'rotate-180' : undefined} aria-hidden="true" />
              {showAll ? T.showLess : T.showMore(hidden)}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Cancelar no se puede deshacer: se confirma, con la opción de avisar. */}
      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open && busy?.action !== 'cancelled') setCancelTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{T.cancelDialog.title(labels)}</DialogTitle>
            <DialogDescription>
              {cancelTarget && T.cancelDialog.description(cancelSummary(cancelTarget, now))}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
            <Switch id="call-cancel-notify" checked={cancelNotify} onCheckedChange={setCancelNotify} className="mt-0.5" />
            <div className="grid gap-0.5">
              <Label htmlFor="call-cancel-notify" className="cursor-pointer leading-snug">
                {T.cancelDialog.notify}
              </Label>
              <p className="text-xs text-muted-foreground">{T.cancelDialog.notifyHint}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy !== null} onClick={() => setCancelTarget(null)}>
              {T.cancelDialog.back}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                const target = cancelTarget
                if (!target) return
                void record(target, 'cancelled', cancelNotify).then((ok) => {
                  if (ok) setCancelTarget(null)
                })
              }}
            >
              {busy?.action === 'cancelled' && <Loader2 className="animate-spin" aria-hidden="true" />}
              {busy?.action === 'cancelled' ? T.cancelDialog.saving : T.cancelDialog.confirm(labels)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ------------------------------------------------------------
// Fila
// ------------------------------------------------------------

function whoOf(row: CallListRow): string {
  return row.patientName ?? row.contactName ?? (row.phone ? formatPhoneDisplay(row.phone) : T.noName)
}

function cancelSummary(row: CallListRow, now: Date): string {
  const starts = new Date(row.startsAt)
  return `${whoOf(row)}, ${relativeDayLabel(starts, now).toLowerCase()} a las ${formatTimeLabel(zonedParts(starts))}`
}

interface CallRowItemProps {
  row: CallListRow
  now: Date
  canAct: boolean
  outboundEnabled: boolean
  /** La acción de ESTA fila que está en marcha, si hay una. */
  busyAction: RowAction | null
  /** Alguna fila está ocupada: nada más se toca mientras tanto. */
  anyBusy: boolean
  onConfirmed: () => void
  onNoResponse: () => void
  onWrongNumber: () => void
  onCancel: () => void
  onRobot: () => void
}

function CallRowItem(props: CallRowItemProps) {
  const { row, now, canAct, outboundEnabled, busyAction, anyBusy } = props
  const starts = new Date(row.startsAt)
  const who = whoOf(row)
  const speaksWith =
    row.patientName && row.contactName && row.patientName !== row.contactName ? row.contactName : null
  const href = row.phone ? telHref(row.phone) : null

  const robotLine = [
    row.robotAttempts > 0 ? T.attempts.robot(row.robotAttempts) : null,
    row.lastRobot
      ? T.lastResult(describeRobotResult(row.lastRobot), formatAgo(row.lastRobot.at, now))
      : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const manualLine = [
    row.manualAttempts > 0 ? T.attempts.manual(row.manualAttempts) : null,
    row.lastManual
      ? T.lastResult(describeManualResult(row.lastManual), formatAgo(row.lastManual.at, now))
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const robotDisabledReason = row.robotInProgress
    ? T.robotCalling
    : !row.canRobotCall
      ? T.robotNoAttempts
      : null

  return (
    <li className="grid gap-x-3 gap-y-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
      <div className="flex items-baseline gap-2 sm:block">
        <p className="text-sm font-semibold whitespace-nowrap tabular-nums">{formatTimeLabel(zonedParts(starts))}</p>
        <p className="text-xs text-muted-foreground">{relativeDayLabel(starts, now)}</p>
      </div>

      <div className="min-w-0 space-y-2">
        <div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium break-words">
            <span className="min-w-0">{who}</span>
            <Badge variant={REASON_BADGE[row.reason]}>{T.reason[row.reason]}</Badge>
          </p>
          {(speaksWith || row.staffName) && (
            <p className="mt-0.5 text-xs break-words text-muted-foreground">
              {[speaksWith ? T.patientContact(speaksWith) : null, row.staffName].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>

        {href ? (
          <a
            href={href}
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap text-foreground tabular-nums underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:min-h-11"
            aria-label={`${T.callPhone(formatPhoneDisplay(row.phone ?? ''))}: ${who}`}
          >
            <Phone className="size-3.5 text-primary" aria-hidden="true" />
            {formatPhoneDisplay(row.phone ?? '')}
          </a>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <PhoneOff className="size-3.5" aria-hidden="true" />
            {T.noPhone}
          </p>
        )}

        {(robotLine || manualLine || row.robotInProgress) && (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {row.robotInProgress ? (
              <p className="flex items-center gap-1.5 text-info">
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                {T.robotCalling}
              </p>
            ) : (
              robotLine && <p>{robotLine}</p>
            )}
            {manualLine && <p>{manualLine}</p>}
          </div>
        )}

        {canAct && (
          <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:flex-wrap">
            <Button
              variant="outline"
              disabled={anyBusy}
              aria-label={T.actionAria(T.confirmed, who)}
              onClick={props.onConfirmed}
            >
              {busyAction === 'confirmed' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Check className="text-primary" aria-hidden="true" />
              )}
              {T.confirmed}
            </Button>
            <Button
              variant="outline"
              disabled={anyBusy}
              aria-label={T.actionAria(T.noResponse, who)}
              onClick={props.onNoResponse}
            >
              {busyAction === 'no_response' ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <PhoneMissed className="text-muted-foreground" aria-hidden="true" />
              )}
              {T.noResponse}
            </Button>
            <Button
              variant="outline"
              disabled={anyBusy}
              aria-label={T.actionAria(T.cancelled, who)}
              onClick={props.onCancel}
            >
              <CalendarX className="text-destructive" aria-hidden="true" />
              {T.cancelled}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={anyBusy}
                render={<Button variant="outline" aria-label={T.actionAria(T.moreActions, who)} />}
              >
                {busyAction === 'robot' || busyAction === 'wrong_number' ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <MoreHorizontal aria-hidden="true" />
                )}
                {T.more}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-56">
                {outboundEnabled && (
                  <DropdownMenuItem
                    className="pointer-coarse:min-h-11"
                    disabled={robotDisabledReason !== null}
                    onClick={props.onRobot}
                  >
                    <Bot aria-hidden="true" />
                    {robotDisabledReason ?? T.robotNow}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="pointer-coarse:min-h-11" onClick={props.onWrongNumber}>
                  <PhoneOff aria-hidden="true" />
                  {T.wrongNumber}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </li>
  )
}

// ------------------------------------------------------------
// Cargando
// ------------------------------------------------------------

function CallListSkeleton() {
  return (
    <div role="status" aria-label={T.loading} className="space-y-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid gap-x-3 gap-y-2 sm:grid-cols-[5.5rem_minmax(0,1fr)]" aria-hidden="true">
          <div className="space-y-1.5">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-3 w-10 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}
