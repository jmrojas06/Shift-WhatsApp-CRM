// ============================================================
// Aviso al paciente cuando la recepción crea, mueve o cancela una
// cita desde el panel.
//
// Esta es la ÚNICA costura entre las rutas del panel y el envío por
// WhatsApp. Mientras no exista `notifyPatient` (T5) devuelve "no se
// envió" con un motivo; T5 solo cambia el cuerpo de `notifyFromPanel`
// para llamarlo. Las rutas no cambian.
//
// Contrato: nunca lanza, y los textos de error no llevan datos del
// paciente (nombre ni teléfono): la pantalla los muestra tal cual.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type PanelNotifyKind = 'booked' | 'moved' | 'cancelled'

export interface PanelNotifyArgs {
  /** Service role: el envío escribe en `messages` y lee la conexión de WhatsApp. */
  db: SupabaseClient
  accountId: string
  appointmentId: string
  kind: PanelNotifyKind
  now: Date
}

export type PanelNotifyResult =
  | { sent: true; channel: 'text' | 'template' }
  | { sent: false; error: string }

export const NOTIFY_UNAVAILABLE = 'El aviso por WhatsApp todavía no está disponible.'
const NOTIFY_FAILED = 'No se pudo enviar el aviso por WhatsApp.'

/** TODO(T5): reemplazar por `notifyPatient(args)`. */
export async function notifyFromPanel(args: PanelNotifyArgs): Promise<PanelNotifyResult> {
  void args
  return { sent: false, error: NOTIFY_UNAVAILABLE }
}

/** Lo que las rutas ponen en la respuesta. */
export interface NotifyOutcome {
  notified: boolean
  notify_error?: string
}

/**
 * Avisa solo si la recepción lo pidió. Los argumentos se arman con una función
 * para no crear el cliente de service role cuando no hay nada que enviar. Un
 * fallo (o una excepción) nunca deshace la cita: se devuelve como
 * `notify_error` para que el panel lo muestre.
 */
export async function notifyIfRequested(
  notify: boolean,
  makeArgs: () => PanelNotifyArgs,
): Promise<NotifyOutcome> {
  if (!notify) return { notified: false }
  try {
    const result = await notifyFromPanel(makeArgs())
    return result.sent ? { notified: true } : { notified: false, notify_error: result.error }
  } catch {
    // Sin el mensaje de la excepción: podría traer datos del paciente.
    console.error('[agenda panel] el aviso al paciente lanzó una excepción')
    return { notified: false, notify_error: NOTIFY_FAILED }
  }
}
