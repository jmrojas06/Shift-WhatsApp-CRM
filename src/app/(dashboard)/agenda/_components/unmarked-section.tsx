'use client'

// ============================================================
// "Sin marcar": las citas de hoy que ya empezaron y siguen como pendientes o
// confirmadas, es decir, a las que nadie les ha dicho todavía si vinieron
// (diseño §7.3). Atendió y No vino usan la misma ruta de estado que la agenda
// del día; esta sección no escribe nada por su cuenta.
//
// La página le pasa las citas de hoy ya filtradas (`selectUnmarked`). Como la
// sección existe justamente para cerrar citas que ya empezaron, sus botones ya
// llevan la confirmación de "la cita ya pasó": no se pregunta dos veces.
//
// Un viewer ve la lista sin botones. Sin citas sin marcar, no ocupa lugar.
// ============================================================

import { Check, ClipboardCheck, Loader2, UserX } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatTimeLabel } from '@/verticals/agenda/agent/format'
import { zonedParts } from '@/verticals/agenda/agent/time'
import { CALL_LIST_TEXTS as T } from '@/verticals/agenda/call-list-texts'

export interface UnmarkedItem {
  id: string
  /** ISO. */
  startsAt: string
  /** Lo que se agendó; null si el servicio ya no existe. */
  serviceName: string | null
  staffName: string | null
  /** Con quién es la cita: nombre, teléfono o un texto de respaldo. */
  personLabel: string
}

export interface UnmarkedSectionProps {
  items: UnmarkedItem[]
  /** Quien puede marcar citas (owner, admin o agent). */
  canAct: boolean
  /** La cita que se está cambiando ahora, si hay una. */
  changingId: string | null
  serviceGone: string
  staffGone: string
  onMark: (id: string, status: 'completed' | 'no_show') => void
}

export function UnmarkedSection({ items, canAct, changingId, serviceGone, staffGone, onMark }: UnmarkedSectionProps) {
  if (items.length === 0) return null

  return (
    <section aria-labelledby="unmarked-title" className="min-w-0">
      <Card>
        <CardHeader>
          <CardTitle id="unmarked-title" className="flex items-center gap-2.5 text-[15px] font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-warning/12 text-warning">
              <ClipboardCheck className="size-4" aria-hidden="true" />
            </span>
            {T.unmarked.title}
            <Badge variant="warning">{items.length}</Badge>
          </CardTitle>
          <CardDescription>{T.unmarked.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const busy = changingId === item.id
              return (
                <li
                  key={item.id}
                  className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 gap-3">
                    <p className="w-[5.5rem] shrink-0 pt-px text-sm font-semibold whitespace-nowrap tabular-nums">
                      {formatTimeLabel(zonedParts(new Date(item.startsAt)))}
                    </p>
                    <div className="min-w-0 break-words">
                      <p className="text-sm font-medium">{item.serviceName ?? serviceGone}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.staffName ?? staffGone} · {item.personLabel}
                      </p>
                    </div>
                  </div>
                  {canAct && (
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                      <Button
                        variant="outline"
                        disabled={changingId !== null}
                        aria-label={T.unmarked.attendedAria(item.personLabel)}
                        onClick={() => onMark(item.id, 'completed')}
                      >
                        {busy ? (
                          <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="text-primary" aria-hidden="true" />
                        )}
                        {T.unmarked.attended}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={changingId !== null}
                        aria-label={T.unmarked.noShowAria(item.personLabel)}
                        onClick={() => onMark(item.id, 'no_show')}
                      >
                        <UserX className="text-muted-foreground" aria-hidden="true" />
                        {T.unmarked.noShow}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </section>
  )
}
