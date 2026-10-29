/**
 * Zona horaria de las cuentas. Hoy es una sola para todas (Colombia);
 * cuando exista zona por cuenta, este es el único lugar que cambia de
 * constante a dato de la cuenta.
 */
export const ACCOUNT_TIME_ZONE = 'America/Bogota'

const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Minutos desde la medianoche local (0–1439) de `instant` en `timeZone`.
 * Se resuelve con Intl, nunca con la zona del proceso: en Vercel el
 * servidor corre en UTC.
 */
export function minutesOfDayInZone(
  instant: Date,
  timeZone: string = ACCOUNT_TIME_ZONE,
): number {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  const parts = f.formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return (get('hour') % 24) * 60 + get('minute')
}
