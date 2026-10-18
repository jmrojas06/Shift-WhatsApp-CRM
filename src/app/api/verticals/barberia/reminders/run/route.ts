import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { runBarberiaReminders } from '@/verticals/barberia/agent/reminders'
import { sendBarberiaReminder } from '@/verticals/barberia/agent/reminders-send'

/**
 * Runner de recordatorios del vertical de barbería (Fase 3).
 *
 * Pensado para golpearse cada 10–15 min (Vercel Cron / pinger
 * externo). Misma protección que los crons del CRM: header
 * `x-cron-secret` contra `AUTOMATION_CRON_SECRET`.
 *
 * La idempotencia no depende del cron: cada señal se reclama con un
 * UPDATE condicional antes de enviar, así que dos invocaciones
 * simultáneas no duplican mensajes.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const summary = await runBarberiaReminders({
      db: supabaseAdmin(),
      send: sendBarberiaReminder,
    })
    return NextResponse.json(summary)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'runner failed' },
      { status: 500 },
    )
  }
}
