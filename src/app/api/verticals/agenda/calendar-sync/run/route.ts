import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { notifyAlert } from '@/lib/ops/alert'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { runCalendarSync } from '@/verticals/agenda/calendar-sync'

/**
 * Runner de la copia de citas a Google Calendar.
 *
 * Pensado para golpearse cada 5 min. Acepta el secreto por `x-cron-secret`
 * (pinger externo, cron del host) o por `Authorization: Bearer <secreto>` (el
 * que agrega Vercel Cron cuando existe la env `CRON_SECRET`); ambos se
 * comparan contra `AUTOMATION_CRON_SECRET`. Igual que el de recordatorios.
 *
 * Avisa por ALERT_WEBHOOK_URL (opcional) solo cuando algo anda mal del lado de
 * Shift: el runner lanza, una cuenta falla al leer la base, o faltan las
 * variables de Google. Un fallo de Google en una cita NO avisa: se anota en la
 * cita, el panel lo muestra y se reintenta en 5 minutos (si no, una caída de
 * Google mandaría una alerta cada 5 minutos). Las alertas nunca lanzan.
 *
 * La idempotencia no depende del cron: el id del evento sale de la cita y la
 * cita solo se limpia si no cambió mientras se copiaba.
 */

// Una corrida copia hasta 50 citas por cuenta, cada una con una o más
// llamadas a Google. El límite por defecto de la plataforma se queda corto;
// Vercel lo recorta al techo del plan.
export const maxDuration = 60

/** Comparación timing-safe, sin filtrar longitud ni contenido. */
function secretMatches(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  return (
    suppliedBuf.length === expectedBuf.length &&
    timingSafeEqual(suppliedBuf, expectedBuf)
  )
}

/** Los secretos presentados, vengan del header que vengan. */
function suppliedSecrets(request: Request): string[] {
  const headerSecret = request.headers.get('x-cron-secret')
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
  return [headerSecret, bearer].filter(
    (value): value is string => Boolean(value),
  )
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (
    !suppliedSecrets(request).some((value) => secretMatches(value, expected))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const summary = await runCalendarSync({
      db: supabaseAdmin(),
      now: new Date(),
    })
    if (summary.errors.length > 0) {
      await notifyAlert(
        `Google Calendar: ${summary.errors.length} error(es) en la corrida. Revisa los logs.`,
      )
    }
    return NextResponse.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'runner failed'
    console.error('[agenda calendar-sync] runner failed:', message)
    await notifyAlert(`Google Calendar: el runner falló — ${message}`)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
