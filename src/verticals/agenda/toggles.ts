// ============================================================
// Piezas de la agenda que cada negocio prende o apaga (051).
// Puro. Una columna ausente o NULL cuenta como prendida: así una
// cuenta sin fila en booking_settings se comporta como hoy.
// ============================================================

export interface AgendaToggles {
  /** Preguntar "¿con quién?". Apagado: se asigna a quien esté libre. */
  chooseStaff: boolean
  /** Mostrar el precio en el menú, el resumen y la confirmación. */
  showPrice: boolean
  /** Mostrar la duración en el menú de servicios. */
  showDuration: boolean
  /** Enviar recordatorios automáticos. */
  remindersEnabled: boolean
  /** El cliente puede reprogramar o cancelar desde el bot. */
  allowReschedule: boolean
}

export type AgendaToggleKey = keyof AgendaToggles

/** Solo un `false` literal apaga una pieza: "false" o 0 cuentan como prendidas (columnas boolean). */
export const DEFAULT_TOGGLES: Readonly<AgendaToggles> = Object.freeze({
  chooseStaff: true,
  showPrice: true,
  showDuration: true,
  remindersEnabled: true,
  allowReschedule: true,
})

export const TOGGLE_COLUMNS: Record<AgendaToggleKey, string> = {
  chooseStaff: 'choose_staff',
  showPrice: 'show_price',
  showDuration: 'show_duration',
  remindersEnabled: 'reminders_enabled',
  allowReschedule: 'allow_reschedule',
}

export const TOGGLE_KEYS = Object.keys(TOGGLE_COLUMNS) as AgendaToggleKey[]

export function togglesFromRow(row: Record<string, unknown> | null | undefined): AgendaToggles {
  const out = { ...DEFAULT_TOGGLES }
  for (const key of TOGGLE_KEYS) {
    if (row?.[TOGGLE_COLUMNS[key]] === false) out[key] = false
  }
  return out
}

export function togglesToRow(patch: Partial<AgendaToggles>): Record<string, boolean> {
  const row: Record<string, boolean> = {}
  for (const key of TOGGLE_KEYS) {
    const value = patch[key]
    if (typeof value === 'boolean') row[TOGGLE_COLUMNS[key]] = value
  }
  return row
}
