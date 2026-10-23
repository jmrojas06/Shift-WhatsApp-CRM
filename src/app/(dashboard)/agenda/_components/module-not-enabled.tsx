// ============================================================
// Estado vacío tranquilo para cuando la cuenta no tiene el módulo
// agenda (alguien entró por URL directa). Lo comparten /agenda y
// /agenda/configuracion.
// ============================================================

import { CalendarOff } from 'lucide-react'

import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

export function ModuleNotEnabled() {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted">
        <CalendarOff className="size-6 text-muted-foreground" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-[15px] font-semibold text-foreground">
        {T.notEnabledTitle}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {T.notEnabledBody}
      </p>
    </div>
  )
}
