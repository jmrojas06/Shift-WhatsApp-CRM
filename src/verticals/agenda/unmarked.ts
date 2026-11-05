// ============================================================
// Sección "Sin marcar" de /agenda (diseño §7.3): las citas de hoy que ya
// empezaron y siguen como pendientes o confirmadas, es decir, a las que
// nadie les ha dicho todavía "Atendió" o "No vino".
//
// Puro: la página lo aplica a las citas de hoy que ya cargó, sin una lectura
// más. La página carga las citas al abrir, así que pasada la medianoche de
// Bogotá lo que tiene en memoria es de ayer: aquí "hoy" es siempre el día de
// Bogotá de `now`, nunca el de la carga, y las citas de otro día no salen.
// ============================================================

import { ACTIVE_STATUSES } from './active-statuses'
import { zonedDateKey } from './agent/time'

export function selectUnmarked<T extends { starts_at: string; status: string }>(
  appointments: readonly T[],
  now: Date,
): T[] {
  const todayKey = zonedDateKey(now)
  return appointments
    .filter((appointment) => {
      if (!ACTIVE_STATUSES.includes(appointment.status)) return false
      const startsAt = new Date(appointment.starts_at)
      return startsAt.getTime() <= now.getTime() && zonedDateKey(startsAt) === todayKey
    })
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
}
