// ============================================================
// Uso de llamadas del mes (para el tope `monthly_limit` y para mostrarlo
// en la tarjeta "Llamadas" de la configuración).
//
//   - `bogotaMonthRange` da el mes de calendario en hora de Bogotá: el
//     tope se reinicia el día 1 a las 00:00 de Bogotá, no a las 00:00 UTC
//     (que serían las 7 p. m. del último día del mes anterior).
//   - `countMonthlyRobotCalls` cuenta las llamadas SALIENTES del robot del
//     mes (`direction = 'outbound'`, `channel = 'robot'`); las entrantes y
//     las que se anotan a mano no cuentan para el tope.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { startOfZonedDay, zonedParts } from '@/verticals/agenda/agent/time'

export interface MonthRange {
  /** 'YYYY-MM', mes de Bogotá. */
  month: string
  /** Primer instante del mes (incluido). */
  start: Date
  /** Primer instante del mes siguiente (no incluido). */
  end: Date
}

/** El mes de calendario de Bogotá al que pertenece `now`. */
export function bogotaMonthRange(now: Date): MonthRange {
  const { dateKey } = zonedParts(now)
  const year = Number(dateKey.slice(0, 4))
  const monthNumber = Number(dateKey.slice(5, 7))
  const pad = (value: number): string => String(value).padStart(2, '0')

  const nextYear = monthNumber === 12 ? year + 1 : year
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1

  return {
    month: `${year}-${pad(monthNumber)}`,
    start: startOfZonedDay(`${year}-${pad(monthNumber)}-01`),
    end: startOfZonedDay(`${nextYear}-${pad(nextMonth)}-01`),
  }
}

/**
 * Llamadas salientes del robot que van en el mes de `now` (cualquier estado:
 * cada intento queda en el registro y cuenta contra el tope). Si la lectura
 * falla LANZA: un error de la base no es "0 llamadas".
 */
export async function countMonthlyRobotCalls(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<number> {
  const { start, end } = bogotaMonthRange(now)
  const { count, error } = await db
    .from('booking_calls')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('direction', 'outbound')
    .eq('channel', 'robot')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString())
  if (error) throw new Error(`No se pudieron contar las llamadas del mes: ${error.message}`)
  return count ?? 0
}
