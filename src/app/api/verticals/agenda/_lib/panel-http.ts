// ============================================================
// Utilidades HTTP de las rutas de citas del panel (crear, mover y
// cancelar). Las dos rutas comparten el mismo contrato:
//
//   - Toda respuesta de error lleva `{ error, code }`: `error` es el
//     texto que ve la recepción y `code` lo que la pantalla usa para
//     decidir (p. ej. `outside_hours` pregunta "¿Agendar igual?").
//   - Una regla de agenda rota (panel-booking.ts) se traduce a su
//     status aquí, en un solo lugar.
//   - Después de cada escritura que guardó se avisa a la copia de
//     Google Calendar, con `after()`: la respuesta no espera.
// ============================================================

import { after, NextResponse } from 'next/server'

import { kickCalendarSync } from '@/verticals/agenda/calendar-kick'
import type { AgendaLabels } from '@/verticals/agenda/labels'
import { panelBookingMessage, type PanelBookingMessageCode } from '@/verticals/agenda/panel-booking'

/**
 * 400: lo que se pidió no tiene sentido (hora pasada, profesional que no
 * atiende). 409: la agenda en este momento no lo permite (horario, sillones,
 * choque) y la recepción puede reintentar con otra hora o confirmando.
 */
export const PANEL_REJECTION_STATUS: Record<PanelBookingMessageCode, number> = {
  invalid_input: 400,
  past: 400,
  staff_not_for_service: 400,
  outside_hours: 409,
  not_editable: 409,
  chairs_full: 409,
  slot_taken: 409,
  stale: 409,
}

export function panelError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status })
}

/** Una regla de agenda rota → respuesta con el texto en las palabras de la cuenta. */
export function panelRejection(code: PanelBookingMessageCode, labels: AgendaLabels): NextResponse {
  return panelError(PANEL_REJECTION_STATUS[code], code, panelBookingMessage(code, labels))
}

/**
 * Programa el aviso a Google Calendar para después de responder. Nunca
 * lanza: un fallo de la copia no puede tumbar una cita que ya se guardó.
 */
export function scheduleCalendarKick(accountId: string): void {
  after(async () => {
    try {
      await kickCalendarSync(accountId)
    } catch (err) {
      console.error(
        '[agenda panel] no se pudo avisar a Google Calendar:',
        err instanceof Error ? err.message : 'error',
      )
    }
  })
}
