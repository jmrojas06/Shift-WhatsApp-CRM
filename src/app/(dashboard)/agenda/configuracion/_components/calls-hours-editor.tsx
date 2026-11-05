'use client'

// ============================================================
// Horario de atención de la tarjeta "Llamadas": un renglón por día, con
// uno o más tramos (por ejemplo, mañana y tarde con el almuerzo en medio),
// "copiar lunes a martes-viernes" y una vista previa de cómo se lee.
//
// Es solo la parte visual: el estado vive en la tarjeta y las operaciones
// sobre el horario están en `calls-draft.ts`.
// ============================================================

import { Copy, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { MAX_OFFICE_BLOCKS_PER_DAY } from '@/verticals/agenda/voice/settings'

import {
  DAY_NAMES,
  WEEK_DAYS,
  addHoursBlock,
  copyDayToWeekdays,
  previewOfficeHours,
  removeHoursBlock,
  setDayOpen,
  updateHoursBlock,
  type HoursDraft,
} from './calls-draft'
import { CALLS_TEXTS as C } from './calls-texts'

interface HoursEditorProps {
  hours: HoursDraft
  onChange: (next: HoursDraft) => void
  disabled?: boolean
}

export function HoursEditor({ hours, onChange, disabled = false }: HoursEditorProps) {
  const preview = previewOfficeHours(hours)

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1 sm:flex-1">
          <h3 id="calls-hours-title" className="font-heading text-sm font-medium">
            {C.hoursTitle}
          </h3>
          <p className="max-w-[65ch] text-xs text-muted-foreground">{C.hoursHint}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(copyDayToWeekdays(hours, 1))}
        >
          <Copy />
          {C.hoursCopy}
        </Button>
      </div>

      <ul aria-labelledby="calls-hours-title" className="divide-y divide-border rounded-lg ring-1 ring-border">
        {WEEK_DAYS.map((day) => {
          const name = DAY_NAMES[day]
          const blocks = hours[day] ?? []
          const isOpen = blocks.length > 0

          return (
            <li
              key={day}
              className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex items-center justify-between gap-3 sm:w-36 sm:shrink-0 sm:pt-2">
                <span className="text-sm font-medium">{name}</span>
                <Switch
                  checked={isOpen}
                  onCheckedChange={(next) => onChange(setDayOpen(hours, day, next))}
                  disabled={disabled}
                  aria-label={C.hoursOpenAria(name)}
                />
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                {!isOpen ? (
                  <p className="text-sm text-muted-foreground sm:pt-2">{C.hoursClosed}</p>
                ) : (
                  <>
                    {blocks.map((block, index) => (
                      <div key={index} className="flex items-center gap-2">
                        {/* En el celular cada hora va en su renglón; desde sm, todo en una línea. */}
                        <div className="grid min-w-0 flex-1 grid-cols-[1.5rem_1fr] items-center gap-2 sm:flex sm:flex-none sm:flex-wrap">
                          <span className="text-sm text-muted-foreground">{C.hoursFrom}</span>
                          <Input
                            type="time"
                            step={60}
                            value={block.start}
                            onChange={(e) =>
                              onChange(updateHoursBlock(hours, day, index, { start: e.target.value }))
                            }
                            disabled={disabled}
                            aria-label={C.hoursStartAria(name, index + 1)}
                            className="sm:w-40"
                          />
                          <span className="text-sm text-muted-foreground">{C.hoursTo}</span>
                          <Input
                            type="time"
                            step={60}
                            value={block.end}
                            onChange={(e) =>
                              onChange(updateHoursBlock(hours, day, index, { end: e.target.value }))
                            }
                            disabled={disabled}
                            aria-label={C.hoursEndAria(name, index + 1)}
                            className="sm:w-40"
                          />
                        </div>
                        {blocks.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            aria-label={C.hoursRemoveBlock(name, index + 1)}
                            onClick={() => onChange(removeHoursBlock(hours, day, index))}
                          >
                            <X />
                          </Button>
                        )}
                      </div>
                    ))}
                    {blocks.length < MAX_OFFICE_BLOCKS_PER_DAY && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        aria-label={C.hoursAddBlockAria(name)}
                        onClick={() => onChange(addHoursBlock(hours, day))}
                      >
                        <Plus />
                        {C.hoursAddBlock}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        <span className="font-medium text-foreground">{C.hoursPreviewLabel}: </span>
        {preview ? C.hoursPreview(preview) : C.hoursPreviewEmpty}
      </p>
    </div>
  )
}
