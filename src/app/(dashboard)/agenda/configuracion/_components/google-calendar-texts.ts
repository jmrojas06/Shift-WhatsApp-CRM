// ============================================================
// Textos y utilidades puras de la tarjeta "Google Calendar" y del
// selector de calendario por profesional.
//
// Viven aparte de `verticals/agenda/texts.ts` para no mezclarse con
// el resto de la configuración. Español sencillo; sin guiones largos.
// ============================================================

import type { AgendaLabels } from '@/verticals/agenda/labels'

/** Motivos de error que manda el callback en `?google=error&reason=...`. */
export type GoogleReturnReason =
  | 'denied'
  | 'state'
  | 'code'
  | 'scopes'
  | 'no_refresh_token'
  | 'google'
  | 'config'
  | 'save'

export const GOOGLE_TEXTS = {
  title: 'Google Calendar',
  description: 'Copia tus citas a un calendario de Google para verlas también en tu celular.',

  statusConnected: 'Conectado',
  statusProblem: 'Con problemas',
  statusRevoked: 'Desconectado',
  statusNotConnected: 'Sin conectar',

  intro:
    'Cada cita nueva, movida o cancelada se actualiza sola en tu calendario. La copia va en un solo sentido: de Shift a Google.',
  privacy: 'Los eventos no incluyen teléfonos ni notas.',

  connect: 'Conectar Google Calendar',
  reconnect: 'Reconectar',
  disconnect: 'Desconectar',

  notConfigured:
    'Falta un paso de Shift para activar Google Calendar en este servidor. Escríbenos y lo dejamos listo.',
  loadFailed: 'No pudimos revisar el estado de Google Calendar.',
  retry: 'Reintentar',
  loading: 'Revisando Google Calendar...',

  account: 'Cuenta de Google',
  accountUnknown: 'Cuenta conectada',
  lastSync: 'Última copia de citas',
  neverSynced: 'Todavía no se copia ninguna cita',

  calendarLabel: 'Calendario general',
  calendarHint: (labels: AgendaLabels) =>
    // "tus" sirve para cualquier palabra del negocio (cita, turno, sesión).
    `Aquí se copian tus ${labels.citas}. Si quieres, cada ${labels.profesional} puede tener su propio calendario: se elige al editarlo.`,
  calendarsLoading: 'Buscando tus calendarios...',
  calendarsFailed: 'No pudimos traer tus calendarios.',
  calendarSaving: 'Guardando...',
  calendarSaved: 'Calendario guardado.',
  calendarSaveFailed: 'No se pudo guardar el calendario.',
  calendarMissing: 'Un calendario que ya no aparece en tu cuenta',
  calendarPrimarySuffix: 'principal',

  lastErrorTitle: 'Último problema',
  revokedTitle: 'Google dejó de dar permiso',
  revokedBody: 'Las citas ya no se copian a tu calendario. Vuelve a conectar para seguir.',

  disconnectTitle: 'Desconectar Google Calendar',
  disconnectBody:
    'Dejaremos de copiar tus citas. Los eventos que ya están en tu calendario se quedan ahí.',
  disconnectConfirm: 'Sí, desconectar',
  disconnectCancel: 'Cancelar',
  disconnecting: 'Desconectando...',
  disconnected: 'Google Calendar se desconectó.',
  disconnectFailed: 'No se pudo desconectar. Intenta de nuevo.',

  viewConnections: 'Abrir los permisos de mi cuenta de Google',
  dismiss: 'Cerrar aviso',

  returnOk: 'Listo. Google Calendar quedó conectado y tus citas se copiarán en unos minutos.',
  returnGeneric: 'No se pudo conectar Google Calendar. Intenta de nuevo.',
  returnReasons: {
    denied: 'Cancelaste la conexión en Google. Cuando quieras, vuelve a intentarlo.',
    state: 'La conexión venció o no se pudo verificar. Vuelve a intentarlo.',
    code: 'Google no terminó la conexión. Vuelve a intentarlo.',
    scopes:
      'Faltó aceptar un permiso. Vuelve a conectar y deja marcados todos los permisos de calendario.',
    no_refresh_token:
      'Google no dejó guardar el permiso. Quita el acceso de Shift en tu cuenta de Google y vuelve a conectar.',
    google: 'Google no respondió bien. Intenta de nuevo en un momento.',
    config:
      'Google Calendar todavía no está listo en este servidor. Avísale a Shift para que lo active.',
    save: 'No se pudo guardar la conexión. Intenta de nuevo.',
  } satisfies Record<GoogleReturnReason, string>,

  // Selector en la ficha de cada profesional.
  staffTitle: 'Calendario de Google',
  staffGeneral: 'Usar el calendario general',
  staffHint: 'Lo que agende esta persona se copia a este calendario.',
  staffNotConnected: 'Conecta Google Calendar en la pestaña Negocio para elegir un calendario propio.',
  staffLoading: 'Buscando tus calendarios...',
  staffFailed: 'No pudimos traer tus calendarios. Cierra y vuelve a abrir esta ventana para reintentar.',
  staffCalendarNotSaved:
    'La persona quedó creada, pero no se pudo guardar su calendario de Google. Edítala para elegirlo.',
} as const

const REASONS = Object.keys(GOOGLE_TEXTS.returnReasons) as GoogleReturnReason[]

export interface ReturnFeedback {
  kind: 'success' | 'error'
  message: string
  /** Motivo conocido del error (null si fue éxito o no se reconoce). */
  reason: GoogleReturnReason | null
}

/**
 * Lee `?google=ok` / `?google=error&reason=...` de la URL. Solo se muestran
 * mensajes escritos aquí: nunca texto que venga en la dirección.
 */
export function readReturnFeedback(search: string): ReturnFeedback | null {
  const params = new URLSearchParams(search)
  const result = params.get('google')
  if (result === 'ok') {
    return { kind: 'success', message: GOOGLE_TEXTS.returnOk, reason: null }
  }
  if (result !== 'error') return null

  const raw = params.get('reason')
  const reason = REASONS.find((known) => known === raw) ?? null
  return {
    kind: 'error',
    message: reason ? GOOGLE_TEXTS.returnReasons[reason] : GOOGLE_TEXTS.returnGeneric,
    reason,
  }
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "Hace 5 min", "Hace 3 h" o la fecha (hora de Bogotá) si pasó más de un día. */
export function formatLastSync(iso: string | null, now: Date = new Date()): string {
  if (!iso) return GOOGLE_TEXTS.neverSynced
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return GOOGLE_TEXTS.neverSynced

  const elapsed = Math.max(0, now.getTime() - at.getTime())
  if (elapsed < MINUTE_MS) return 'Hace un momento'
  if (elapsed < HOUR_MS) return `Hace ${Math.floor(elapsed / MINUTE_MS)} min`
  if (elapsed < DAY_MS) return `Hace ${Math.floor(elapsed / HOUR_MS)} h`
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'America/Bogota',
  }).format(at)
}

// ------------------------------------------------------------
// Selector de calendario
// ------------------------------------------------------------

export interface CalendarOption {
  id: string
  name: string
  primary: boolean
}

/** Valor del selector de un profesional que usa el calendario general. */
export const GENERAL_CALENDAR_VALUE = '__general__'

const PRIMARY_ALIAS = 'primary'

/**
 * Google llama `primary` al calendario principal, pero en la lista aparece con
 * su id real (el correo). El selector usa el id de la lista.
 */
export function calendarSelectValue(saved: string | null, calendars: CalendarOption[]): string {
  const value = saved ?? PRIMARY_ALIAS
  if (value !== PRIMARY_ALIAS) return value
  return calendars.find((calendar) => calendar.primary)?.id ?? PRIMARY_ALIAS
}

/** Al elegir el calendario principal se guarda el alias `primary` (sigue valiendo si cambia el correo). */
export function calendarValueToSave(value: string, calendars: CalendarOption[]): string {
  const primary = calendars.find((calendar) => calendar.primary)
  return primary && primary.id === value ? PRIMARY_ALIAS : value
}
