// ============================================================
// Cupo de sillones de la clínica.
//
// Una clínica con 3 sillas no puede atender 4 citas a la misma hora,
// aunque cada una sea con un profesional distinto y libre. El cupo
// (`clinic_locations.chair_count`) se compara con las citas activas de
// TODA la cuenta que se cruzan con la hora. Lo comparten el bot
// (internal-backend.ts) y las rutas del panel.
//
// Sin cupo puesto (null) no hay límite: es lo que pasa con cualquier
// negocio que no es clínica y con una clínica que aún no lo configura.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ChairInterval {
  startsAt: Date
  endsAt: Date
}

export interface ChairContext {
  /** Sillones de la sede; null = sin límite. */
  chairCount: number | null
  /** Citas activas (pendientes o confirmadas) de toda la cuenta en el rango leído. */
  active: ChairInterval[]
}

/**
 * ¿Queda una silla libre en [startsAt, endsAt)? Cuenta las citas activas que
 * se cruzan con la hora; una que termina justo cuando empieza la otra no se
 * cruza.
 */
export function chairsFreeAt(args: {
  startsAt: Date
  endsAt: Date
  chairCount: number | null
  active: ChairInterval[]
}): boolean {
  if (args.chairCount === null) return true
  const overlapping = args.active.filter(
    (a) => a.startsAt < args.endsAt && a.endsAt > args.startsAt,
  ).length
  return overlapping < args.chairCount
}

/**
 * Lee el cupo de la sede y las citas activas de toda la cuenta que tocan
 * [fromIso, toIso). La sede es la primera activa, la misma que usa el bot
 * (`loadClinicContext`). Sin cupo puesto no lee las citas: no hay nada que
 * comparar.
 *
 * Con `excludeAppointmentId` esa cita no cuenta: al mover una cita, la propia
 * no debe ocupar la silla que va a usar. Sin él, nada cambia.
 *
 * Lanza si no puede leer: ofrecer una hora sin saber si hay silla es peor que
 * no ofrecer ninguna. Los mensajes de error no llevan datos del paciente.
 */
export async function loadChairContext(
  db: SupabaseClient,
  accountId: string,
  fromIso: string,
  toIso: string,
  excludeAppointmentId?: string,
): Promise<ChairContext> {
  const { data: locations, error: locationError } = await db
    .from('clinic_locations')
    .select('chair_count')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
  if (locationError) {
    throw new Error(`No se pudo leer el cupo de sillones: ${locationError.message}`)
  }
  const raw = ((locations ?? []) as { chair_count: number | null }[])[0]?.chair_count
  const chairCount = raw == null ? null : Number(raw)
  if (chairCount === null) return { chairCount: null, active: [] }

  let query = db
    .from('booking_appointments')
    .select('starts_at, ends_at')
    .eq('account_id', accountId)
    .in('status', ['pending', 'confirmed'])
    .lt('starts_at', toIso)
    .gt('ends_at', fromIso)
  if (excludeAppointmentId) query = query.neq('id', excludeAppointmentId)
  const { data: appointments, error: appointmentsError } = await query.order('starts_at')
  if (appointmentsError) {
    throw new Error(`No se pudieron leer las citas: ${appointmentsError.message}`)
  }
  const active = ((appointments ?? []) as { starts_at: string; ends_at: string }[]).map((row) => ({
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
  }))
  return { chairCount, active }
}
