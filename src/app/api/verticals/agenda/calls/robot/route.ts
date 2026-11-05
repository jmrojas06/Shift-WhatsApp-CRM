import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { isUuid } from '@/verticals/agenda/panel-booking-input'
import { requestRobotCallNow } from '@/verticals/agenda/voice/call-requests'
import { voiceProviderFromEnv } from '@/verticals/agenda/voice/provider'

// ============================================================
// POST /api/verticals/agenda/calls/robot
//
// "Llamar con el robot ahora": la recepción lo toca en la lista Para llamar y el
// robot hace un intento más de la llamada de confirmación a esa cita.
//
//   Cuerpo: { appointment_id }
//   200 { ok: true, call_id, attempt }
//   400 cuerpo inválido · 404 la cita no existe · 409 una regla lo impide
//   (ventana, festivo, baja, autorización, tope del mes, ya confirmada…) ·
//   502 el proveedor no aceptó la llamada · 503 faltan las variables de voz.
//
// Guardas:
//   - requireRole('agent'): un viewer solo lee.
//   - La cuenta sale de la sesión, nunca del cuerpo; toda lectura y escritura va
//     acotada a ella (el service role se salta la RLS, por eso es explícito).
//   - Las mismas reglas que la llamada automática (ver voice/call-requests.ts).
// Los textos de error no llevan el teléfono ni el nombre del paciente.
// ============================================================

const NOT_CONFIGURED = 'Las llamadas todavía no están configuradas. Avísale a Shift.'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as { appointment_id?: unknown } | null
    const appointmentId = body && typeof body === 'object' ? body.appointment_id : undefined
    if (!isUuid(appointmentId)) {
      return NextResponse.json(
        { error: 'La cita elegida no es válida.', code: 'invalid_appointment' },
        { status: 400 },
      )
    }

    const voice = voiceProviderFromEnv()
    if (!voice.ok) {
      return NextResponse.json({ error: NOT_CONFIGURED, code: 'not_configured' }, { status: 503 })
    }

    const result = await requestRobotCallNow({
      db: supabaseAdmin(),
      provider: voice.provider,
      accountId: ctx.accountId,
      userId: ctx.userId,
      appointmentId,
      now: new Date(),
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
    }
    return NextResponse.json({ ok: true, call_id: result.callId, attempt: result.attempt })
  } catch (err) {
    return toErrorResponse(err)
  }
}
