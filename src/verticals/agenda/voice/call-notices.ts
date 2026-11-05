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

  // ---- Llamadas entrantes (T14) ----
  urgencyTitle: 'Llamada: urgencia sin atender',
  urgency: (who: string): string =>
    `${who} llamó con una urgencia y no había a quién pasar la llamada. Escríbele o llámale cuanto antes.`,

  inboundFailed: (who: string, when: string | null): string =>
    `${who} llamó para confirmar o cancelar su cita${when ? ` del ${when}` : ''}, pero no se pudo guardar. Revisa la cita y llámale.`,

  /** Errores que quedan en la fila de la llamada entrante. */
  bookingLinkNoNumber: 'No se pudo enviar el WhatsApp para agendar: la llamada no traía un número.',
  bookingLinkNotSent: (reason: string): string => `No se pudo enviar el WhatsApp para agendar: ${reason}`,
  /** Ese número ya había recibido el enlace hace pocos minutos. */
  bookingLinkRepeated: 'No se repitió el WhatsApp para agendar: ya se había enviado a este número hace menos de 10 minutos.',
  /** Motivo (dentro de `bookingLinkNotSent`) cuando la cuenta llegó al tope de enlaces por hora. */
  bookingLinkCapReason: 'se llegó al límite de enlaces por hora de las llamadas entrantes.',
  /** Alerta a operaciones (sin teléfonos): puede ser alguien abusando de la URL del webhook. */
  bookingLinkCapAlert: (accountId: string): string =>
    `Llamadas entrantes: la cuenta ${accountId} llegó al límite de 30 WhatsApp para agendar en una hora y dejó de mandarlos. ` +
    'Revisa el registro de llamadas: puede ser alguien abusando de la URL del webhook entrante.',

  /** Quién, cuando el contacto no tiene nombre ni teléfono. */
  someone: 'Un paciente',
  /** Error que queda en la fila de la llamada. */
  patientNotNotified: (reason: string): string => `No se pudo avisar por WhatsApp: ${reason}`,
  effectFailed: 'No se pudo guardar lo que marcó el paciente.',
  appointmentInactive: 'La cita ya no estaba activa cuando contestaron.',
} as const
