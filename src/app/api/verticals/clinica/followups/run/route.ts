import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { notifyAlert } from '@/lib/ops/alert'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { runClinicFollowups } from '@/modules/clinica/followups'
import { sendClinicFollowup } from '@/modules/clinica/followups-send'

/**
 * Runner de los seguimientos después de la cita (clínicas, Fase 3).
 *
 * Pensado para golpearse cada 10 min. Siembra los seguimientos de las citas
 * atendidas, envía los vencidos (cuidados, "¿cómo sigues?" y calificación) y, desde
 * las 20:00, avisa al dueño el cierre del día. Acepta el secreto por `x-cron-secret`
 * (pinger externo, cron del host) o por `Authorization: Bearer <secreto>` (el que
 * agrega Vercel Cron cuando existe la env `CRON_SECRET`); ambos se comparan contra
 * `AUTOMATION_CRON_SECRET`.
 *
 * Si la corrida lanza o queda con fallos, avisa por ALERT_WEBHOOK_URL (opcional:
 * sin la env es un no-op). Las alertas nunca lanzan.
 *
 * La idempotencia no depende del cron: la siembra ignora los duplicados, cada
 * seguimiento se reclama con un UPDATE condicional antes de enviar y el cierre del
 * día se reclama con la llave (cuenta, día), así que dos invocaciones simultáneas no
 * duplican mensajes ni avisos.
 */

// Una corrida puede mandar hasta 50 seguimientos y cada envío hace varias
// consultas más una llamada a Meta. El límite por defecto de la plataforma se
// queda corto; Vercel lo recorta al techo del plan.
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
    const summary = await runClinicFollowups({
      db: supabaseAdmin(),
      send: sendClinicFollowup,
    })
    const failed = summary.failed ?? 0
    const errorCount = summary.errors?.length ?? 0
    if (failed > 0 || errorCount > 0) {
      // Los errores llevan ids y el mensaje de la base, nunca datos de un paciente.
      console.error('[clinica followups] corrida con fallos:', summary.errors)
      await notifyAlert(
        `Seguimientos clínica: ${failed} fallo(s) y ${errorCount} error(es) en la corrida. Revisa los logs.`,
      )
    }
    return NextResponse.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'runner failed'
    console.error('[clinica followups] runner failed:', message)
    await notifyAlert(`Seguimientos clínica: el runner falló — ${message}`)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
