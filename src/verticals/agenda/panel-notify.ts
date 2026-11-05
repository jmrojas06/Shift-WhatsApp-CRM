// ============================================================
// Aviso al paciente cuando la recepción crea, mueve o cancela una
// cita desde el panel.
//
// Esta es la ÚNICA costura entre las rutas del panel y el envío por
// WhatsApp: las rutas llaman `notifyIfRequested` y este archivo delega en
// `notifyPatient` (`notify-patient.ts`), que decide el canal (mensaje libre o
// plantilla) y arma el texto.
//
// Contrato: nunca lanza, y los textos de error no llevan datos del
// paciente (nombre ni teléfono): la pantalla los muestra tal cual.
// ============================================================

import {
  notifyPatient,
  type NotifyPatientArgs,
  type NotifyPatientKind,
  type NotifyPatientResult,
} from './notify-patient'

export type PanelNotifyKind = NotifyPatientKind

/** `db` es el service role: el envío escribe en `messages` y lee la conexión de WhatsApp. */
export type PanelNotifyArgs = NotifyPatientArgs

export type PanelNotifyResult = NotifyPatientResult

const NOTIFY_FAILED = 'No se pudo enviar el aviso por WhatsApp.'

export async function notifyFromPanel(args: PanelNotifyArgs): Promise<PanelNotifyResult> {
  return notifyPatient(args)
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
