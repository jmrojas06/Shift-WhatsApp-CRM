'use client'

// ============================================================
// Tarjetas de tipo de negocio (puntos de partida). Las comparten el
// asistente de /agenda y la pestaña "Tipo de negocio" de
// Configuración. Cada tarjeta es un <button> real: se alcanza con
// Tab y se activa con Enter o Espacio.
// ============================================================

import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { AGENDA_PRESETS, PRESET_KEYS, type PresetKey } from '@/verticals/agenda/presets'
import { AGENDA_TEXTS as T } from '@/verticals/agenda/texts'

interface PresetCardsProps {
  /** Clave del tipo de negocio que ya usa la cuenta (o null). */
  currentKey: string | null
  disabled?: boolean
  /** Tarjeta que se está aplicando: muestra el spinner. */
  busyKey?: PresetKey | null
  /** Texto del tooltip cuando el usuario no puede editar. */
  disabledReason?: string
  onSelect: (key: PresetKey) => void
  className?: string
}

export function PresetCards({
  currentKey,
  disabled = false,
  busyKey = null,
  disabledReason,
  onSelect,
  className,
}: PresetCardsProps) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {PRESET_KEYS.map((key) => {
        const preset = AGENDA_PRESETS[key]
        const active = currentKey === key
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(key)}
            className={cn(
              'rounded-lg border p-4 text-left transition-colors',
              'hover:border-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              active ? 'border-primary bg-primary/5' : 'border-border',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">{preset.name}</span>
              {busyKey === key && (
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {preset.description}
            </span>
            {active && (
              <span className="mt-2 block text-xs font-medium text-primary">
                {T.config.type.current}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
