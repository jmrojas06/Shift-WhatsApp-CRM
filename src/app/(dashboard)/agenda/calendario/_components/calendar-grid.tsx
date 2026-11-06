'use client'

// ============================================================
// Cuadrícula del calendario: la vista de día (una columna por
// profesional) y la de semana (una columna por día).
//
// Solo dibuja: recibe las columnas ya armadas (calendar-columns.ts) y
// avisa qué se tocó. No lee la base ni llama a la API, así la vista
// previa de desarrollo la puede mostrar con datos falsos.
//
//   - Clic en un hueco libre: onSlotClick (ese profesional, esa hora).
//   - Clic en una cita: onAppointmentClick.
//   - Celular: el día se desplaza en horizontal por columnas y la
//     semana pasa a una lista por día (WeekList).
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import { ChevronRight, Lock, Plus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDayLabel, formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts, zonedTimeToUtc } from '@/verticals/agenda/agent/time'
import type { CalendarColumn, CalendarView } from '@/verticals/agenda/calendar-columns'
import type { CalendarAppointment } from '@/verticals/agenda/calendar-data'
import { appointmentTitle } from '@/verticals/agenda/calendar-data'
import {
  formatClock,
  formatHourLabel,
  hourLabels,
  intervalBand,
  layoutDay,
  offHoursBands,
  pointPosition,
  type Band,
  type HourRange,
} from '@/verticals/agenda/calendar-layout'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import type { AgendaLabels } from '@/verticals/agenda/labels'

import { STATUS_VISUAL, StatusIcon } from './calendar-status'

export interface SlotClick {
  staffId: string | null
  startsAt: Date
}

interface CalendarGridProps {
  view: CalendarView
  columns: CalendarColumn[]
  range: HourRange
  labels: AgendaLabels
  /** Nombre de cada profesional, para mostrarlo en la semana con "todos". */
  staffNames: ReadonlyMap<string, string>
  now: Date
  /** Puede crear citas haciendo clic en un hueco. */
  canWrite: boolean
  /** Cambia cuando hay que volver a ubicar el desplazamiento (otro día, otra vista). */
  scrollKey: string
  /** La carga está en curso: la cuadrícula se atenúa pero no desaparece. */
  busy?: boolean
  onSlotClick: (slot: SlotClick) => void
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onOpenDay: (dateKey: string) => void
}

const SLOT_MINUTES = 30
/** Mismo borde de las líneas del horario, en modo claro y oscuro. */
const LINES =
  'linear-gradient(to bottom, var(--border) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--border) 45%, transparent) 1px, transparent 1px)'
const HATCH_OFF =
  'repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in oklab, var(--foreground) 7%, transparent) 7px 8px)'
const HATCH_BLOCKED =
  'repeating-linear-gradient(135deg, color-mix(in oklab, var(--foreground) 5%, transparent) 0 6px, color-mix(in oklab, var(--foreground) 13%, transparent) 6px 12px)'

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.replace(/^[^\p{L}]+/u, '').charAt(0).toUpperCase())
    .join('')

const bandStyle = (band: Band) => ({ top: `${band.top}%`, height: `${band.height}%` })

export function CalendarGrid(props: CalendarGridProps) {
  const { view, columns, range, labels, now, scrollKey, busy } = props

  const hours = range.endHour - range.startHour
  const bodyHeight = `calc(var(--hour-h) * ${hours})`
  const dayColumns = view === 'day'
  const colMin = dayColumns ? 'min(18rem, 80vw)' : '7rem'

  const scrollerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)

  const hourMarks = useMemo(() => hourLabels(range), [range])

  // Al cambiar de día o de vista, deja a la vista lo que importa: "ahora" si es
  // hoy, si no la primera cita del día. Recargar tras guardar no mueve nada.
  useEffect(() => {
    const scroller = scrollerRef.current
    const body = bodyRef.current
    if (!scroller || !body || scrolledFor.current === scrollKey) return
    scrolledFor.current = scrollKey

    // La hora (entera) que queda arriba: dos horas antes de "ahora" si es hoy; si
    // no, una hora antes de la primera cita. Siempre en el borde de una hora.
    const hourAt = (percent: number) => range.startHour + (percent / 100) * hours
    let focusHour: number | null = null
    const today = columns.find((c) => c.isToday)
    if (today) {
      const nowPercent = pointPosition(now, today.dateKey, range)
      if (nowPercent !== null) focusHour = Math.floor(hourAt(nowPercent)) - 2
    }
    if (focusHour === null) {
      const firsts = columns
        .map((c) => layoutDay(c.appointments, range)[0]?.top)
        .filter((top): top is number => top !== undefined)
      if (firsts.length > 0) focusHour = Math.floor(hourAt(Math.min(...firsts))) - 1
    }
    const percent = focusHour === null ? 0 : Math.min(100, Math.max(0, ((focusHour - range.startHour) / hours) * 100))
    scroller.scrollTop = (body.offsetHeight * percent) / 100
    scroller.scrollLeft = 0
  }, [scrollKey, columns, range, hours, now])

  return (
    <>
      <div
        ref={scrollerRef}
        role="region"
        aria-label={T.gridLabel(labels)}
        aria-busy={busy || undefined}
        tabIndex={0}
        className={cn(
          'relative max-h-[calc(100dvh-15rem)] min-h-[24rem] md:max-h-[calc(100dvh-17rem)] md:min-h-[26rem] snap-x snap-proximity overflow-auto overscroll-contain rounded-xl bg-card ring-1 ring-border outline-none scroll-pt-20 scroll-pl-[var(--gutter)]',
          '[--gutter:3.25rem] [--hour-h:4rem] md:[--hour-h:3.5rem]',
          'focus-visible:ring-2 focus-visible:ring-ring/60',
          'transition-opacity duration-150',
          busy && 'opacity-70',
          !dayColumns && 'max-md:hidden',
        )}
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `var(--gutter) repeat(${columns.length}, minmax(${colMin}, 1fr))`,
            minWidth: `calc(var(--gutter) + ${columns.length} * ${colMin})`,
            width: '100%',
          }}
        >
          {/* Cabecera pegada arriba */}
          <div className="sticky top-0 left-0 z-30 border-b border-border bg-card" aria-hidden="true" />
          {columns.map((column) => (
            <ColumnHeader
              key={`h-${column.key}`}
              column={column}
              view={view}
              labels={labels}
              onOpenDay={props.onOpenDay}
            />
          ))}

          {/* Columna de horas, pegada a la izquierda */}
          <div
            ref={bodyRef}
            className="sticky left-0 z-20 border-r border-border bg-card"
            style={{ height: bodyHeight }}
            aria-hidden="true"
          >
            {hourMarks.map((mark) => (
              <span
                key={mark.hour}
                className="absolute right-2 translate-y-0.5 text-[11px] leading-none text-muted-foreground tabular-nums"
                style={{ top: `${mark.top}%` }}
              >
                {formatHourLabel(mark.hour)}
              </span>
            ))}
          </div>

          {columns.map((column) => (
            <DayColumn
              key={column.key}
              column={column}
              range={range}
              hours={hours}
              bodyHeight={bodyHeight}
              labels={labels}
              staffNames={props.staffNames}
              now={now}
              view={view}
              canWrite={props.canWrite}
              onSlotClick={props.onSlotClick}
              onAppointmentClick={props.onAppointmentClick}
            />
          ))}
        </div>
      </div>

      {!dayColumns && (
        <WeekList
          columns={columns}
          labels={labels}
          onAppointmentClick={props.onAppointmentClick}
          onOpenDay={props.onOpenDay}
        />
      )}
    </>
  )
}

// ------------------------------------------------------------
// Cabecera de columna
// ------------------------------------------------------------

function ColumnHeader({
  column,
  view,
  labels,
  onOpenDay,
}: {
  column: CalendarColumn
  view: CalendarView
  labels: AgendaLabels
  onOpenDay: (dateKey: string) => void
}) {
  const count = column.appointments.length
  const base =
    'sticky top-0 z-20 snap-start border-b border-l border-border bg-card first:border-l-0'

  if (view === 'day') {
    const name = column.staffName ?? T.noStaffAssigned
    return (
      <div className={cn(base, 'flex items-center gap-2.5 px-3 py-2.5')}>
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary"
        >
          {column.staffName ? initialsOf(column.staffName) : '?'}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {count === 0 ? T.noAppointmentsDay(labels) : T.countOf(count, labels)}
          </span>
        </span>
      </div>
    )
  }

  const day = Number(column.dateKey.split('-')[2])
  const short = formatDayLabel(column.dateKey).split(' ')[0]
  return (
    <button
      type="button"
      onClick={() => onOpenDay(column.dateKey)}
      aria-label={T.openDay(formatDayLabel(column.dateKey))}
      aria-current={column.isToday ? 'date' : undefined}
      className={cn(
        base,
        'flex flex-col items-center gap-0.5 py-2 text-center transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
      )}
    >
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{short}</span>
      <span
        className={cn(
          'grid size-8 place-items-center rounded-full text-sm font-semibold tabular-nums',
          column.isToday && 'bg-primary text-primary-foreground',
        )}
      >
        {day}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {count === 0 ? T.noAppointmentsDay(labels) : T.countOf(count, labels)}
      </span>
    </button>
  )
}

// ------------------------------------------------------------
// Una columna: líneas de hora, sombreados, huecos y citas
// ------------------------------------------------------------

function DayColumn({
  column,
  range,
  hours,
  bodyHeight,
  labels,
  staffNames,
  now,
  view,
  canWrite,
  onSlotClick,
  onAppointmentClick,
}: {
  column: CalendarColumn
  range: HourRange
  hours: number
  bodyHeight: string
  labels: AgendaLabels
  staffNames: ReadonlyMap<string, string>
  now: Date
  view: CalendarView
  canWrite: boolean
  onSlotClick: (slot: SlotClick) => void
  onAppointmentClick: (appointment: CalendarAppointment) => void
}) {
  const positioned = useMemo(() => layoutDay(column.appointments, range), [column.appointments, range])
  const offBands = useMemo(
    () => (column.workBlocks ? offHoursBands(column.workBlocks, range) : []),
    [column.workBlocks, range],
  )
  const timeOffBands = useMemo(
    () =>
      column.timeOff.flatMap((off) => {
        const band = intervalBand(off.startsAt, off.endsAt, column.dateKey, range)
        return band ? [{ band, off }] : []
      }),
    [column.timeOff, column.dateKey, range],
  )
  const nowTop = column.isToday ? pointPosition(now, column.dateKey, range) : null

  const cells = useMemo(() => {
    const total = hours * (60 / SLOT_MINUTES)
    return Array.from({ length: total }, (_, i) => {
      const minute = range.startHour * 60 + i * SLOT_MINUTES
      const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
      const startsAt = zonedTimeToUtc(column.dateKey, time)
      const parts = zonedParts(startsAt)
      return { time, startsAt, label: formatTimeLabel(parts) }
    })
  }, [column.dateKey, hours, range.startHour])

  const ariaName = column.staffName
    ? `${column.staffName}, ${T.countOf(column.appointments.length, labels)}`
    : T.countOf(column.appointments.length, labels)

  return (
    <div
      role="group"
      aria-label={ariaName}
      className="relative snap-start border-l border-border"
      style={{
        height: bodyHeight,
        backgroundImage: LINES,
        backgroundSize: '100% var(--hour-h), 100% calc(var(--hour-h) / 2)',
      }}
    >
      {/* Fuera de horario: franjas diagonales, no solo un tono distinto */}
      {offBands.map((band, i) => (
        <div
          key={`off-${i}`}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bg-muted/55"
          style={{ ...bandStyle(band), backgroundImage: HATCH_OFF }}
        />
      ))}

      {timeOffBands.map(({ band, off }) => (
        <div
          key={off.id}
          title={off.reason ? T.timeOffWithReason(off.reason) : T.timeOff}
          className="pointer-events-none absolute inset-x-0 z-[1] overflow-hidden border-y border-border/70 bg-muted/80"
          style={{ ...bandStyle(band), backgroundImage: HATCH_BLOCKED }}
        >
          <span className="m-1 inline-flex max-w-full items-center gap-1 rounded bg-card/90 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{off.reason ? off.reason : T.timeOff}</span>
          </span>
        </div>
      ))}

      {/* Huecos de media hora: son botones solo para el puntero (fuera del orden del tabulador y
          ocultos al lector de pantalla); quien usa teclado o lector crea con "Nueva cita". */}
      <div className="absolute inset-0 flex flex-col" aria-hidden="true">
        {cells.map((cell) => {
          const open = canWrite && cell.startsAt.getTime() >= now.getTime()
          return open ? (
            <button
              key={cell.time}
              type="button"
              tabIndex={-1}
              title={T.freeSlot(cell.label)}
              onClick={() => onSlotClick({ staffId: column.staffId, startsAt: cell.startsAt })}
              className="group flex h-[calc(var(--hour-h)/2)] w-full shrink-0 cursor-pointer items-start px-1 pt-0.5 text-left outline-none transition-colors hover:bg-primary-soft focus-visible:bg-primary-soft"
            >
              <span className="hidden items-center gap-0.5 rounded bg-primary-soft-2 px-1 py-px text-[11px] font-medium text-primary group-hover:flex group-focus-visible:flex">
                <Plus className="size-3" aria-hidden="true" />
                {cell.label}
              </span>
            </button>
          ) : (
            <div key={cell.time} className="h-[calc(var(--hour-h)/2)] shrink-0" />
          )
        })}
      </div>

      {positioned.map((block) => (
        <AppointmentBlock
          key={block.item.id}
          block={block}
          staffName={
            view === 'week' && column.staffId === null && block.item.staffId
              ? (staffNames.get(block.item.staffId) ?? null)
              : null
          }
          onClick={onAppointmentClick}
        />
      ))}

      {nowTop !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-[15] h-0.5 bg-info"
          style={{ top: `${nowTop}%` }}
        >
          <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-info" />
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------
// Una cita dentro de la cuadrícula
// ------------------------------------------------------------

function AppointmentBlock({
  block,
  staffName,
  onClick,
}: {
  block: ReturnType<typeof layoutDay<CalendarAppointment>>[number]
  /** Quién atiende, cuando la columna no lo dice (semana con "todos"). */
  staffName: string | null
  onClick: (appointment: CalendarAppointment) => void
}) {
  const a = block.item
  const visual = STATUS_VISUAL[a.status]
  const who = appointmentTitle(a, T.noName)
  const start = formatClock(a.startsAt)
  const range = `${start} - ${formatClock(a.endsAt)}`
  const crowded = block.lanes >= 3
  // Cuántas líneas caben: 30 min = una, 45 = dos, 60 = tres, 90 o más = cuatro.
  const lines = crowded ? 1 : block.heightMinutes >= 85 ? 4 : block.heightMinutes >= 55 ? 3 : block.heightMinutes >= 40 ? 2 : 1
  const confirmedByPatient = a.patientConfirmed && (a.status === 'confirmed' || a.status === 'pending')
  const statusText = confirmedByPatient ? `${visual.label}, ${T.patientConfirmed.toLowerCase()}` : visual.label
  const detail = [range, a.serviceName, staffName, statusText].filter(Boolean).join(' · ')

  const aria = T.appointmentAria({
    who,
    time: formatTimeLabel(zonedParts(a.startsAt)),
    status: statusText,
    extra: a.serviceName ?? undefined,
  })

  return (
    <button
      type="button"
      onClick={() => onClick(a)}
      aria-label={aria}
      title={`${who} · ${detail}`}
      className={cn(
        'absolute z-10 flex flex-col overflow-hidden rounded-md px-1.5 py-1 text-left text-xs leading-tight outline-none',
        'shadow-(--shadow-card) transition-[box-shadow,transform] duration-150',
        'hover:z-20 hover:shadow-md focus-visible:z-20 focus-visible:ring-3 focus-visible:ring-ring/60 active:translate-y-px',
        visual.block,
      )}
      style={{
        top: `${block.top}%`,
        height: `calc(${block.height}% - 2px)`,
        left: `calc(${(block.lane / block.lanes) * 100}% + 2px)`,
        width: `calc(${100 / block.lanes}% - 4px)`,
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <StatusIcon status={a.status} patientConfirmed={a.patientConfirmed} className="size-3 shrink-0" />
        {lines === 1 && !crowded && <span className="shrink-0 tabular-nums">{start}</span>}
        <span className="truncate font-semibold">{crowded ? (who.split(' ')[0] ?? who) : who}</span>
      </span>
      {lines >= 2 && (
        <span className="mt-0.5 truncate text-[11px] opacity-85">
          <span className="tabular-nums">{range}</span>
          {a.serviceName ? ` · ${a.serviceName}` : ''}
        </span>
      )}
      {lines >= 3 && (
        <span className="mt-0.5 truncate text-[11px] opacity-85">{staffName ?? statusText}</span>
      )}
      {lines >= 4 && staffName && <span className="mt-0.5 truncate text-[11px] opacity-85">{statusText}</span>}
    </button>
  )
}

// ------------------------------------------------------------
// Semana en celular: una lista por día
// ------------------------------------------------------------

function WeekList({
  columns,
  labels,
  onAppointmentClick,
  onOpenDay,
}: {
  columns: CalendarColumn[]
  labels: AgendaLabels
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onOpenDay: (dateKey: string) => void
}) {
  return (
    <ol className="space-y-3 md:hidden" aria-label={T.gridLabel(labels)}>
      {columns.map((column) => (
        <li
          key={column.key}
          className="overflow-hidden rounded-xl bg-card ring-1 ring-border"
          aria-current={column.isToday ? 'date' : undefined}
        >
          <button
            type="button"
            onClick={() => onOpenDay(column.dateKey)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <span className="min-w-0">
              <span
                className={cn(
                  'text-sm font-semibold first-letter:uppercase',
                  column.isToday && 'text-primary',
                )}
              >
                {formatDayLabel(column.dateKey)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {column.appointments.length === 0
                  ? T.emptyWeekDay(labels)
                  : T.countOf(column.appointments.length, labels)}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
          {column.appointments.length > 0 && (
            <ul className="divide-y divide-border">
              {column.appointments.map((a) => {
                const visual = STATUS_VISUAL[a.status]
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onAppointmentClick(a)}
                      className={cn(
                        'flex w-full items-start gap-3 border-l-[3px] px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                        visual.rail,
                      )}
                    >
                      <span className="w-[4.75rem] shrink-0 pt-px text-sm font-semibold whitespace-nowrap tabular-nums">
                        {formatTimeLabel(zonedParts(a.startsAt))}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-sm font-medium',
                            a.status === 'cancelled' && 'text-muted-foreground line-through',
                          )}
                        >
                          {appointmentTitle(a, T.noName)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {a.serviceName ?? T.noService}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <StatusIcon status={a.status} patientConfirmed={a.patientConfirmed} className="size-3.5" />
                        {visual.label}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
