'use client'

// ============================================================
// El calendario completo: barra de herramientas, cuadrícula y diálogos.
//
// Es de presentación: recibe los datos ya cargados y avisa cuándo
// necesita otro rango (`onRangeChange`) o recargar (`onChanged`). No sabe
// de Supabase; la página real le pasa lo leído con RLS y la vista previa
// de desarrollo le pasa datos falsos y una API en memoria.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, RotateCw } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { addDaysToKey, zonedDateKey } from '@/verticals/agenda/agent/time'
import { formatLongDate } from '@/verticals/agenda/agent/format'
import type { CalendarApi } from '@/verticals/agenda/calendar-api'
import { buildColumns, type CalendarView } from '@/verticals/agenda/calendar-columns'
import {
  rangeKeys,
  type CalendarAppointment,
  type CalendarData,
  type ContactSource,
} from '@/verticals/agenda/calendar-data'
import { formatWeekRange, startOfWeekKey } from '@/verticals/agenda/calendar-layout'
import { buildCalendarSearch } from '@/verticals/agenda/calendar-url'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import type { AgendaLabels } from '@/verticals/agenda/labels'

import { AppointmentDetailDialog } from './appointment-detail-dialog'
import { CalendarGrid, type SlotClick } from './calendar-grid'
import { CalendarToolbar } from './calendar-toolbar'
import { NewAppointmentDialog, type NewAppointmentInitial } from './new-appointment-dialog'

export interface CalendarWorkspaceProps {
  /** null mientras llega la primera carga. */
  data: CalendarData | null
  loading: boolean
  loadError: 'generic' | 'migration' | null
  labels: AgendaLabels
  clinic: boolean
  /** Agent o más. Un viewer ve el calendario sin botones de escritura. */
  canWrite: boolean
  api: CalendarApi
  contacts: ContactSource
  /** Reloj fijo (vista previa). Sin él se usa la hora real y se refresca cada minuto. */
  fixedNow?: Date
  initialView?: CalendarView
  initialDateKey?: string
  /** Profesional elegido al abrir (por ejemplo, desde el enlace). */
  initialStaffId?: string | null
  /** Escribe la vista, el día y el profesional en la dirección (la página real; la vista previa no). */
  syncUrl?: boolean
  conversationHref?: (conversationId: string) => string
  /** La vista pide otro rango de días: [fromKey, toKey). */
  onRangeChange: (range: { fromKey: string; toKey: string }) => void
  /** Se guardó algo: hay que volver a leer las citas. */
  onChanged: () => void
  onRetry: () => void
}

export function CalendarWorkspace(props: CalendarWorkspaceProps) {
  const { data, labels, canWrite, onRangeChange } = props

  const [clock, setClock] = useState(() => props.fixedNow ?? new Date())
  const now = props.fixedNow ?? clock
  useEffect(() => {
    if (props.fixedNow) return
    const timer = setInterval(() => setClock(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [props.fixedNow])
  const todayKey = zonedDateKey(now)

  const [view, setView] = useState<CalendarView>(props.initialView ?? 'day')
  const [dateKey, setDateKey] = useState(props.initialDateKey ?? todayKey)
  const [rawStaffFilter, setStaffFilter] = useState<string | null>(props.initialStaffId ?? null)
  // Un profesional de un enlace viejo que ya no existe se trata como "todos".
  const staffFilter =
    rawStaffFilter && data?.staff.some((s) => s.id === rawStaffFilter) ? rawStaffFilter : null
  const [showCancelled, setShowCancelled] = useState(false)
  const [newDialog, setNewDialog] = useState<{ initial: NewAppointmentInitial; nonce: number } | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  // La vista, el día y el profesional quedan en la dirección: recargar o compartir el enlace los conserva.
  const { syncUrl } = props
  useEffect(() => {
    if (!syncUrl) return
    const search = buildCalendarSearch({ view, dateKey, staffId: staffFilter }, todayKey)
    if (window.location.search !== search) {
      window.history.replaceState(null, '', `${window.location.pathname}${search}`)
    }
  }, [syncUrl, view, dateKey, staffFilter, todayKey])

  // Pide a la página los días que la vista necesita.
  const { fromKey, toKey } = rangeKeys(view, dateKey, startOfWeekKey(dateKey))
  useEffect(() => {
    onRangeChange({ fromKey, toKey })
  }, [fromKey, toKey, onRangeChange])

  const built = useMemo(
    () => (data ? buildColumns({ view, dateKey, data, staffFilter, showCancelled, now }) : null),
    [data, view, dateKey, staffFilter, showCancelled, now],
  )
  const staffNames = useMemo(() => new Map((data?.staff ?? []).map((s) => [s.id, s.name])), [data?.staff])

  const step = view === 'day' ? 1 : 7
  const title =
    view === 'day'
      ? formatLongDate(dateKey)
      : formatWeekRange(dateKey, { includeSunday: (built?.columns.length ?? 6) === 7 })

  const openNew = useCallback(
    (initial: NewAppointmentInitial) => setNewDialog({ initial, nonce: Date.now() }),
    [],
  )

  const detail: CalendarAppointment | null =
    detailId && data ? (data.appointments.find((a) => a.id === detailId) ?? null) : null

  const activeStaff = (data?.staff ?? []).filter((s) => s.isActive)
  const noTeam = data !== null && activeStaff.length === 0 && data.appointments.length === 0

  return (
    <div className="space-y-4">
      <CalendarToolbar
        view={view}
        onViewChange={setView}
        title={title}
        dateKey={dateKey}
        onDateChange={setDateKey}
        onPrev={() => setDateKey((key) => addDaysToKey(key, -step))}
        onNext={() => setDateKey((key) => addDaysToKey(key, step))}
        onToday={() => setDateKey(todayKey)}
        isToday={dateKey === todayKey}
        staff={activeStaff}
        staffFilter={staffFilter}
        onStaffFilterChange={setStaffFilter}
        showCancelled={showCancelled}
        onShowCancelledChange={setShowCancelled}
        hiddenCancelled={built?.hiddenCancelled ?? 0}
        labels={labels}
        canWrite={canWrite}
        onNew={() => openNew({ staffId: staffFilter, startsAt: null, dateKey })}
      />

      {props.loadError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{props.loadError === 'migration' ? T.migrationMissing : T.loadError}</span>
            {props.loadError === 'generic' && (
              <Button size="sm" variant="outline" onClick={props.onRetry}>
                <RotateCw aria-hidden="true" />
                {T.retry}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {!data || !built ? (
        props.loadError ? null : <CalendarSkeleton />
      ) : noTeam ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-card px-6 py-14 text-center ring-1 ring-border">
          <span className="grid size-12 place-items-center rounded-full bg-muted">
            <CalendarDays className="size-6 text-muted-foreground" aria-hidden="true" />
          </span>
          <p className="max-w-sm text-sm text-muted-foreground">{T.noStaff(labels)}</p>
          <Link href="/agenda/configuracion" className={buttonVariants({ variant: 'outline' })}>
            {T.goToConfig}
          </Link>
        </div>
      ) : (
        <CalendarGrid
          view={view}
          columns={built.columns}
          range={built.range}
          labels={labels}
          staffNames={staffNames}
          now={now}
          canWrite={canWrite}
          scrollKey={`${view}:${view === 'day' ? dateKey : startOfWeekKey(dateKey)}:${staffFilter ?? 'all'}`}
          busy={props.loading}
          onSlotClick={(slot: SlotClick) =>
            openNew({ staffId: slot.staffId, startsAt: slot.startsAt, dateKey })
          }
          onAppointmentClick={(appointment) => setDetailId(appointment.id)}
          onOpenDay={(key) => {
            setDateKey(key)
            setView('day')
          }}
        />
      )}

      {data && newDialog && (
        <NewAppointmentDialog
          key={newDialog.nonce}
          data={data}
          labels={labels}
          clinic={props.clinic}
          api={props.api}
          contacts={props.contacts}
          initial={newDialog.initial}
          todayKey={todayKey}
          onClose={() => setNewDialog(null)}
          onSaved={props.onChanged}
        />
      )}

      {data && detail && (
        <AppointmentDetailDialog
          key={detail.id}
          appointment={detail}
          data={data}
          labels={labels}
          canWrite={canWrite}
          api={props.api}
          now={now}
          todayKey={todayKey}
          conversationHref={props.conversationHref}
          onClose={() => setDetailId(null)}
          onChanged={props.onChanged}
        />
      )}
    </div>
  )
}

/** Mientras llega la primera carga: la misma forma que la cuadrícula, sin datos. */
function CalendarSkeleton() {
  return (
    <div
      role="status"
      aria-label={T.loading}
      className="min-h-[26rem] animate-pulse overflow-hidden rounded-xl bg-card ring-1 ring-border motion-reduce:animate-none"
    >
      <div className="flex gap-3 border-b border-border p-3">
        <span className="size-9 rounded-full bg-muted" />
        <span className="grid flex-1 gap-1.5">
          <span className="h-3.5 w-32 rounded bg-muted" />
          <span className="h-3 w-20 rounded bg-muted/70" />
        </span>
      </div>
      <div className="grid gap-6 p-4">
        {[28, 52, 20, 40].map((w, i) => (
          <span key={i} className="h-10 rounded-md bg-muted/60" style={{ width: `${w + 40}%`, marginLeft: `${i * 6}%` }} />
        ))}
      </div>
    </div>
  )
}
