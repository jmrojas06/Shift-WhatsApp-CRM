'use client'

// ============================================================
// Día y hora de una cita: el día, las horas libres que calcula el
// servidor (las mismas que ofrece el bot) y "Otra hora" para escribir
// una a mano. La usan Nueva cita y Mover.
//
// No decide si la hora vale: eso lo hace la ruta al guardar. Aquí solo
// se ofrece lo libre y se deja escribir otra hora si la recepción lo
// necesita (la ruta avisa si queda fuera del horario).
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import { Clock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts } from '@/verticals/agenda/agent/time'
import type { CalendarApi, SlotOption } from '@/verticals/agenda/calendar-api'
import { CALENDAR_TEXTS as T } from '@/verticals/agenda/calendar-texts'
import { cn } from '@/lib/utils'

/** Lo que se leyó para UNA combinación de atención, profesional y día. */
type SlotsResult = { key: string; ok: true; slots: SlotOption[] } | { key: string; ok: false }
type SlotsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; slots: SlotOption[] }

export interface SlotPickerProps {
  /** Para ligar etiquetas y campos (ids únicos si hay dos pickers a la vez). */
  idPrefix: string
  api: CalendarApi
  serviceId: string | null
  /** null = cualquiera de los que atienden. */
  staffId: string | null
  /** La cita que se está moviendo: ni ella ni su sillón cuentan como ocupados. */
  excludeId?: string | null
  dateKey: string
  onDateChange: (dateKey: string) => void
  /** 'HH:MM' local, o '' si aún no hay hora. */
  time: string
  /** `staffIds` son quienes están libres a esa hora; null si se escribió a mano. */
  onTimeChange: (time: string, staffIds: string[] | null) => void
  minDateKey: string
  /** Texto que reemplaza a las horas cuando aún falta elegir algo. */
  waitingFor?: string | null
}

const hhmm = (iso: string): string => {
  const { hour, minute } = zonedParts(new Date(iso))
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function SlotPicker(props: SlotPickerProps) {
  const { idPrefix, api, serviceId, staffId, excludeId, dateKey, time, waitingFor } = props
  const { onTimeChange } = props
  const [result, setResult] = useState<SlotsResult | null>(null)
  const [manual, setManual] = useState(false)

  const queryKey = `${serviceId}|${dateKey}|${staffId ?? ''}|${excludeId ?? ''}`

  useEffect(() => {
    if (!serviceId) return
    let cancelled = false
    void api.listSlots({ serviceId, dateKey, staffId, excludeId }).then((res) => {
      if (cancelled) return
      setResult(res.ok ? { key: queryKey, ok: true, slots: res.data.slots } : { key: queryKey, ok: false })
    })
    return () => {
      cancelled = true
    }
  }, [api, serviceId, dateKey, staffId, excludeId, queryKey])

  // Lo leído solo vale si es de la combinación actual; si no, se está buscando.
  const state = useMemo<SlotsState>(
    () =>
      !serviceId
        ? { status: 'idle' }
        : result?.key !== queryKey
          ? { status: 'loading' }
          : result.ok
            ? { status: 'ready', slots: result.slots }
            : { status: 'error' },
    [serviceId, result, queryKey],
  )

  const slots = useMemo(() => (state.status === 'ready' ? state.slots : []), [state])
  const chosenInList = slots.some((s) => hhmm(s.startsAt) === time)
  // Una hora que no está entre las libres (viene de un clic en el calendario o
  // se escribió) se muestra como "Otra hora", no se pierde.
  const showManual = manual || state.status === 'error' || (time !== '' && state.status === 'ready' && !chosenInList)

  const groups = useMemo(() => {
    const morning = slots.filter((s) => zonedParts(new Date(s.startsAt)).hour < 12)
    const afternoon = slots.filter((s) => zonedParts(new Date(s.startsAt)).hour >= 12)
    return [
      { id: 'am', title: 'Mañana', items: morning },
      { id: 'pm', title: 'Tarde', items: afternoon },
    ].filter((g) => g.items.length > 0)
  }, [slots])

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-day`}>{T.newDialog.dayLabel}</Label>
        <Input
          id={`${idPrefix}-day`}
          type="date"
          min={props.minDateKey}
          value={dateKey}
          onChange={(event) => {
            if (event.target.value) props.onDateChange(event.target.value)
          }}
        />
      </div>

      <div className="space-y-2" role="group" aria-labelledby={`${idPrefix}-time-label`}>
        <p id={`${idPrefix}-time-label`} className="text-sm leading-none font-medium">
          {T.newDialog.timeLabel}
        </p>

        {waitingFor ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">{waitingFor}</p>
        ) : state.status === 'loading' ? (
          <div role="status" aria-label={T.newDialog.slotsLoading} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="h-9 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            ))}
          </div>
        ) : state.status === 'error' ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {T.newDialog.slotsFailed}
          </p>
        ) : state.status === 'ready' && slots.length === 0 ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">{T.newDialog.slotsEmpty}</p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.id} className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{group.title}</p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {group.items.map((slot) => {
                    const value = hhmm(slot.startsAt)
                    const selected = value === time
                    return (
                      <button
                        key={slot.startsAt}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setManual(false)
                          onTimeChange(value, slot.staffIds)
                        }}
                        className={cn(
                          'h-9 rounded-lg border text-sm whitespace-nowrap tabular-nums transition-[color,background-color,border-color] duration-150 outline-none pointer-coarse:h-11',
                          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px',
                          selected
                            ? 'border-primary bg-primary-soft-2 font-semibold text-foreground'
                            : 'border-border bg-background hover:bg-muted',
                        )}
                      >
                        {formatTimeLabel(zonedParts(new Date(slot.startsAt)))}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {!waitingFor && (
          <div className="space-y-2 pt-1">
            {!showManual ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground"
                onClick={() => setManual(true)}
              >
                <Clock aria-hidden="true" />
                {T.newDialog.otherTime}
              </Button>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-manual`}>{T.newDialog.otherTime}</Label>
                <Input
                  id={`${idPrefix}-manual`}
                  type="time"
                  step={300}
                  value={time}
                  onChange={(event) => onTimeChange(event.target.value, null)}
                  aria-describedby={`${idPrefix}-manual-hint`}
                  className="w-40"
                />
                <p id={`${idPrefix}-manual-hint`} className="text-xs text-muted-foreground">
                  {T.newDialog.otherTimeHint}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {state.status === 'ready' && !waitingFor
          ? slots.length === 1
            ? '1 hora libre'
            : `${slots.length} horas libres`
          : ''}
      </span>
    </div>
  )
}
