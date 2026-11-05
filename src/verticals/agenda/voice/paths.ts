// Rutas de los webhooks de voz (sin barra inicial), para armar las URL firmadas
// con `voiceUrl`. Una sola fuente: las rutas y quienes arman las URL las comparten.

export const OUTBOUND_WEBHOOK_PATH = 'api/voice/telnyx/outbound'
export const STATUS_WEBHOOK_PATH = 'api/voice/telnyx/status'
export const DIAL_RESULT_PATH = 'api/voice/telnyx/dial-result'
export const INBOUND_WEBHOOK_PATH = 'api/voice/telnyx/inbound'
