import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { notifyAlert } from '@/lib/ops/alert'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { runOutboundCalls } from '@/verticals/agenda/voice/outbound-runner'
import { voiceProviderFromEnv } from '@/verticals/agenda/voice/provider'

/**
 * Cron de las llamadas de confirmación (diseño §6.2). Pensado para golpearse
 * cada 10 minutos. Mismo secreto que el de los recordatorios: acepta
 * `x-cron-secret` o `Authorization: Bearer <secreto>` y los compara contra
 * `AUTOMATION_CRON_SECRET`.
 *
 * Si faltan las variables de Telnyx o de las URL firmadas, el runner no hace
 * nada y el resumen dice cuáles faltan (`credentialsMissing`); eso no manda
 * alerta, porque con las llamadas apagadas es lo normal. Si la corrida lanza o
 * deja fallos, avisa por ALERT_WEBHOOK_URL (sin la env es un no-op).
 *
 * La idempotencia no depende del cron: cada intento se reclama insertando su fila
 * antes de llamar, así que dos invocaciones a la vez no llaman dos veces.
 */

// Una pasada puede pedir hasta 20 llamadas, cada una con varias consultas y un
// POST a Telnyx. Vercel lo recorta al techo del plan.
export const maxDuration = 60

/** Comparación timing-safe, sin filtrar longitud ni contenido. */
function secretMatches(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  return suppliedBuf.length === expectedBuf.length && timingSafeEqual(suppliedBuf, expectedBuf)
}

/** Los secretos presentados, vengan del header que vengan. */
function suppliedSecrets(request: Request): string[] {
  const headerSecret = request.headers.get('x-cron-secret')
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
  return [headerSecret, bearer].filter((value): value is string => Boolean(value))
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!suppliedSecrets(request).some((value) => secretMatches(value, expected))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const voice = voiceProviderFromEnv()
    const summary = await runOutboundCalls({
      db: supabaseAdmin(),
      provider: voice.ok ? voice.provider : null,
      ...(voice.ok ? {} : { missingCredentials: voice.missing }),
    })

    const failed = summary.failed ?? 0
    const errorCount = summary.errors?.length ?? 0
    if (failed > 0 || errorCount > 0) {
      await notifyAlert(
        `Llamadas agenda: ${failed} fallo(s) y ${errorCount} error(es) en la corrida. Revisa los logs.`,
      )
    }
    return NextResponse.json(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'runner failed'
    console.error('[agenda calls] runner failed:', message)
    await notifyAlert(`Llamadas agenda: el runner falló — ${message}`)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
