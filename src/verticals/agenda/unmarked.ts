// ============================================================
// Sección "Sin marcar" de /agenda (diseño §7.3): las citas de hoy que ya
// empezaron y siguen como pendientes o confirmadas, es decir, a las que
// nadie les ha dicho todavía "Atendió" o "No vino".
//
// Puro y sin dependencias: la página lo aplica a las citas de hoy que ya
// cargó, sin una lectura más.
// ============================================================

/** Estados en los que una cita todavía espera que la marquen. */
const WAITING_STATUSES: readonly string[] = ['pending', 'confirmed']

export function selectUnmarked<T extends { starts_at: string; status: string }>(
  appointments: readonly T[],
  now: Date,
): T[] {
  return appointments
    .filter(
      (appointment) =>
        WAITING_STATUSES.includes(appointment.status) &&
        new Date(appointment.starts_at).getTime() <= now.getTime(),
    )
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
}
