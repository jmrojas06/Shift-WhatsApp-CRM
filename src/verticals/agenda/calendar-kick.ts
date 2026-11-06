// ============================================================
// Aviso "hay citas por copiar a Google Calendar".
//
// Las rutas del panel lo llaman (con `after()`, ya respondida la
// petición) después de cada escritura que guardó: crear, mover,
// cancelar o cambiar el estado de una cita. Copia en el momento las
// citas marcadas por el trigger `google_dirty` (migración 056); el cron
// de cada 5 minutos sigue siendo la red de seguridad.
//
// Contrato: NUNCA lanza (corre en segundo plano). Una cuenta sin Google
// conectado no hace nada más que leer su conexión.
// ============================================================

import { kickCalendarSyncNow } from './calendar-sync'

export async function kickCalendarSync(accountId: string): Promise<void> {
  try {
    await kickCalendarSyncNow(accountId)
  } catch (err) {
    // kickCalendarSyncNow ya traga sus errores; esto es solo por contrato.
    console.error('[agenda] copia a Google Calendar falló:', err instanceof Error ? err.name : 'error')
  }
}
