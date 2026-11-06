import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { requestTestCall } from '@/verticals/agenda/voice/call-requests'
import { voiceProviderFromEnv } from '@/verticals/agenda/voice/provider'

// ============================================================
// POST /api/verticals/agenda/calls/test
//
// "Probar llamada" de la tarjeta de llamadas: el robot le llama al número que el
// admin escribe con el guion de ejemplo (marcado como prueba). La fila de
// `booking_calls` no tiene cita ni contacto, así que no toca ninguna cita.
//
//   Cuerpo: { to }   (con el indicativo: "+57 300 123 4567"; es lo que manda la tarjeta
//   de llamadas. También se acepta `phone`.)
//   200 { ok: true, call_id } · 400 número inválido · 409 sin número que marque o
//   tope del mes · 429 otra prueba hace menos de un minuto · 502 el proveedor no
//   la aceptó · 503 faltan las variables de voz.
//
// Guardas: requireRole('admin'); la cuenta sale de la sesión; cuenta para el
// tope del mes. Funciona con las salientes apagadas: es la forma de probar antes
// de prenderlas. La respuesta no repite el número.
// ============================================================

const NOT_CONFIGURED = 'Las llamadas todavía no están configuradas. Avísale a Shift.'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as { to?: unknown; phone?: unknown } | null
    const phone = body && typeof body === 'object' ? (body.to ?? body.phone) : undefined

    const voice = voiceProviderFromEnv()
    if (!voice.ok) {
      return NextResponse.json({ error: NOT_CONFIGURED, code: 'not_configured' }, { status: 503 })
    }

    const result = await requestTestCall({
      db: supabaseAdmin(),
      provider: voice.provider,
      accountId: ctx.accountId,
      userId: ctx.userId,
      phone,
      now: new Date(),
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
    }
    return NextResponse.json({ ok: true, call_id: result.callId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
