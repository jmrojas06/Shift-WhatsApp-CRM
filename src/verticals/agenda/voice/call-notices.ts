// ============================================================
// Avisos en la app que deja el robot de voz al equipo (campana de
// notificaciones). Texto fijo, en español, sin el procedimiento.
//
// "Prioritario" no existe como columna en `notifications`: se nota por el
// título, que empieza siempre con "Llamada:".
// ============================================================

export const CALL_NOTICES = {
  humanTitle: 'Llamada: quiere hablar con alguien del equipo',
  human: (who: string, when: string): string =>
    `${who} marcó 3 en la llamada de confirmación de su cita del ${when}. Llámale cuanto antes.`,

  advisorMissedTitle: 'Llamada: pidió un asesor y nadie contestó',
  advisorMissed: (who: string): string =>
    `${who} pidió hablar con un asesor y nadie contestó. Llámale cuanto antes.`,

  failedTitle: 'Llamada: no se pudo aplicar lo que marcó el paciente',
  failed: (who: string, when: string): string =>
    `${who} contestó la llamada de confirmación de su cita del ${when}, pero no se pudo guardar lo que marcó. Revisa la cita y llámale.`,

  /** Quién, cuando el contacto no tiene nombre ni teléfono. */
  someone: 'Un paciente',
  /** Error que queda en la fila de la llamada. */
  patientNotNotified: (reason: string): string => `No se pudo avisar por WhatsApp: ${reason}`,
  effectFailed: 'No se pudo guardar lo que marcó el paciente.',
  appointmentInactive: 'La cita ya no estaba activa cuando contestaron.',
} as const
