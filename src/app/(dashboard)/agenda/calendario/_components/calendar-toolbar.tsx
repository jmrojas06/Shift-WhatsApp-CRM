'use client'

import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'

import { Button, buttonVariants } from '@/components/ui/button'
import { GatedButton } from '@/components/ui/gated-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { CalendarView } from '@/verticals/agenda/calendar-columns'
import type { CalendarStaff } from '@/verticals/agenda/calendar-data'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import type { AgendaLabels } from '@/verticals/agenda/labels'

interface CalendarToolbarProps {
  view: CalendarView
  onViewChange: (view: CalendarView) => void
  /** "martes 10 de noviembre de 2026" o "9 al 15 de noviembre de 2026". */
  title: string
  dateKey: string
  onDateChange: (dateKey: string) => void
  onPrev: () => void
  onNext: () => void
  onToday: () => void
  /** El calendario ya está en hoy: "Hoy" no hace falta. */
  isToday: boolean
  staff: CalendarStaff[]
  /** null = todos. */
  staffFilter: string | null
  onStaffFilterChange: (staffId: string | null) => void
  showCancelled: boolean
  onShowCancelledChange: (value: boolean) => void
  hiddenCancelled: number
  labels: AgendaLabels
  canWrite: boolean
  onNew: () => void
}

const ALL = 'all'

export function CalendarToolbar(props: CalendarToolbarProps) {
  const { view, labels } = props

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {/* En el celular el orden es: navegar y crear / título / vista y día / filtros. */}
      <div className="order-1 flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          aria-label={T.prev(view)}
          title={T.prev(view)}
          onClick={props.onPrev}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button variant="outline" onClick={props.onToday} disabled={props.isToday && view === 'day'}>
          {T.today}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={T.next(view)}
          title={T.next(view)}
          onClick={props.onNext}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>

      <h2
        aria-live="polite"
        className="order-3 min-w-0 basis-full font-heading text-lg leading-snug font-semibold first-letter:uppercase sm:order-2 sm:flex-1 sm:basis-48"
      >
        {props.title}
      </h2>

      <div className="order-2 ml-auto sm:order-5 sm:ml-0">
        <GatedButton
          canAct={props.canWrite}
          gateReason={T.newAppointmentGate(labels)}
          onClick={props.onNew}
        >
          <Plus aria-hidden="true" />
          {T.newAppointment(labels)}
        </GatedButton>
      </div>

      <div className="order-4 flex items-center gap-2 sm:order-3">
        {/* Escritorio: el campo de fecha. Celular: un botón con la fecha nativa encima. */}
        <Input
          type="date"
          value={props.dateKey}
          onChange={(event) => {
            if (event.target.value) props.onDateChange(event.target.value)
          }}
          aria-label={T.goToDay}
          className="w-auto max-sm:hidden"
        />
        <span className="relative sm:hidden">
          <span
            aria-hidden="true"
            className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'pointer-events-none')}
          >
            <CalendarDays />
          </span>
          <input
            type="date"
            value={props.dateKey}
            onChange={(event) => {
              if (event.target.value) props.onDateChange(event.target.value)
            }}
            aria-label={T.goToDay}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </span>
        <ViewSwitch view={view} onChange={props.onViewChange} />
      </div>

      <div className="order-6 flex basis-full flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="calendar-staff" className="text-muted-foreground">
            {T.staffFilter(labels)}
          </Label>
          <Select
            value={props.staffFilter ?? ALL}
            onValueChange={(value) => props.onStaffFilterChange(value === ALL || !value ? null : value)}
          >
            <SelectTrigger id="calendar-staff" className="min-w-44">
              <SelectValue>
                {(value: string | null) =>
                  value && value !== ALL
                    ? (props.staff.find((s) => s.id === value)?.name ?? '')
                    : T.allStaff(labels)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              <SelectItem value={ALL}>{T.allStaff(labels)}</SelectItem>
              {props.staff.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="calendar-show-cancelled"
            checked={props.showCancelled}
            onCheckedChange={props.onShowCancelledChange}
          />
          <Label htmlFor="calendar-show-cancelled" className="cursor-pointer">
            {T.showCancelled}
            {!props.showCancelled && props.hiddenCancelled > 0 && (
              <span className="font-normal text-muted-foreground tabular-nums">
                ({props.hiddenCancelled})
              </span>
            )}
          </Label>
        </div>
      </div>
    </div>
  )
}

/** Día / Semana: dos botones de un mismo grupo, el activo se anuncia con aria-pressed. */
function ViewSwitch({ view, onChange }: { view: CalendarView; onChange: (view: CalendarView) => void }) {
  const options: { id: CalendarView; label: string }[] = [
    { id: 'day', label: T.viewDay },
    { id: 'week', label: T.viewWeek },
  ]
  return (
    <div role="group" aria-label={T.viewSwitch} className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={view === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'h-8 rounded-md px-3 text-sm font-medium transition-[color,background-color,box-shadow] duration-150 outline-none pointer-coarse:h-10',
            'focus-visible:ring-3 focus-visible:ring-ring/50',
            view === option.id
              ? 'bg-card text-foreground shadow-(--shadow-card) ring-1 ring-border'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
