// ============================================================
// Estados en los que una cita sigue viva: pendiente o confirmada. Una sola
// lista para "Para llamar", las llamadas a mano y "Sin marcar", así los tres
// coinciden en qué es una cita activa.
// ============================================================

export const ACTIVE_STATUSES: readonly string[] = ['pending', 'confirmed']
