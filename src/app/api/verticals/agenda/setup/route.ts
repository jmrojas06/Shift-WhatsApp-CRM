import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { isAgendaVerticalKey } from '@/lib/verticals/registry'
import { installAgendaTemplate } from '@/verticals/agenda/install'

// ============================================================
// POST /api/verticals/agenda/setup — instala la plantilla de
// la agenda (servicios, barbero, horario, etiquetas, pipeline,
// respuestas rápidas, base de conocimiento y prompt del agente).
//
// Guardas:
//   - Sesión con rol owner/admin (requireRole('admin')).
//   - La cuenta debe tener `vertical_key` de la agenda ('agenda' o la
//     clave anterior 'barberia'). Si la
//     columna no existe todavía (migración 047 sin aplicar), la
//     cuenta se trata como sin vertical — nunca se instala a ciegas.
//   - La instalación escribe con service-role, pero SIEMPRE acotada
//     a `ctx.accountId`; el rol humano se valida antes.
//
// Idempotente: repetir la llamada no duplica ni sobrescribe datos
// del dueño (ver install.ts).
// ============================================================

const NOT_ENABLED = 'El módulo de barbería no está habilitado para esta cuenta.'

export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const { data: account, error: accountError } = await ctx.supabase
      .from('accounts')
      .select('vertical_key')
      .eq('id', ctx.accountId)
      .maybeSingle()

    if (accountError) {
      console.error(
        '[agenda setup] no se pudo verificar el vertical de la cuenta:',
        accountError,
      )
    }
    if (accountError || !isAgendaVerticalKey(account?.vertical_key)) {
      return NextResponse.json({ error: NOT_ENABLED }, { status: 409 })
    }

    const report = await installAgendaTemplate({
      db: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
    })

    return NextResponse.json({ report })
  } catch (err) {
    return toErrorResponse(err)
  }
}
