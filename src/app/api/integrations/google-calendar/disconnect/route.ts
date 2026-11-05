import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { GoogleError, revokeToken } from '@/lib/google/calendar-api'
import { decrypt } from '@/lib/whatsapp/encryption'

import { clearStaffCalendars, readConnection } from '../_lib/connection'

// ============================================================
// POST /api/integrations/google-calendar/disconnect
//
// Desconecta Google Calendar: solo owner/admin.
//   1. Borra la fila de la conexión (con eso la sincronización para).
//   2. Suelta los calendarios por profesional (eran de esa cuenta).
//   3. Revoca el permiso en Google. Es "lo mejor posible": si Google
//      no responde, la persona queda desconectada igual.
// Los eventos que ya están en el calendario se quedan.
//
// Se borra primero y se revoca después: así la desconexión no depende
// de que Google conteste (revocar puede tardar hasta 10 segundos).
// ============================================================

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()

    const connection = await readConnection(db, ctx.accountId)
    if (!connection) return NextResponse.json({ ok: true })

    const { error } = await db
      .from('agenda_calendar_connections')
      .delete()
      .eq('account_id', ctx.accountId)
    if (error) throw new Error(`No se pudo borrar la conexión de Google: ${error.message}`)

    await clearStaffCalendars(db, ctx.accountId)
    await revokeBestEffort(connection.refresh_token_encrypted)

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function revokeBestEffort(encryptedToken: string): Promise<void> {
  let token: string
  try {
    token = decrypt(encryptedToken)
  } catch {
    return // no hay nada que revocar si no se puede leer
  }
  try {
    await revokeToken({ token })
  } catch (err) {
    // Los errores de calendar-api solo traen códigos cortos.
    console.error(
      '[google-calendar] No se pudo revocar el permiso en Google:',
      err instanceof GoogleError ? err.message : 'error desconocido',
    )
  }
}
