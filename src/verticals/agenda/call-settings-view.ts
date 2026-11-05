// ============================================================
// Lo que la tarjeta "Llamadas" recibe de /api/verticals/agenda/call-settings.
//
// Es `CallSettingsResponse` con una diferencia: `usage` puede ser null. Pasa
// solo en la respuesta del PATCH cuando el cambio YA quedó guardado pero falló
// la lectura de lo usado del mes: decir "no se pudo guardar" sería mentira, así
// que se responde éxito sin el uso y la pantalla conserva el que ya tenía. El
// GET sigue devolviendo siempre el uso (si no puede leerlo, responde 500).
// ============================================================

import type { CallSettingsResponse } from './voice/call-settings-payload'

export type CallSettingsView = Omit<CallSettingsResponse, 'usage'> & {
  /** Llamadas salientes del robot en el mes de Bogotá; null si no se pudo leer. */
  usage: CallSettingsResponse['usage'] | null
}
