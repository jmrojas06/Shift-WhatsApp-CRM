import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { isAgendaVerticalKey } from '@/lib/verticals/registry'
import { installAgendaTemplate } from '@/verticals/agenda/install'
import { isPresetKey, type PresetKey } from '@/verticals/agenda/presets'

import { badRequest, readJsonBody } from '../_lib/http'

// ============================================================
// POST /api/verticals/agenda/setup — instala la plantilla de
// la agenda (servicios, profesional, horario, etiquetas, pipeline,
// respuestas rápidas, base de conocimiento, prompt del agente y las
// palabras, piezas, bienvenida y preguntas del punto de partida).
//
// Cuerpo opcional: { "preset_key": "barberia" | "salon" | "salud" |
// "taller" | "clases" | "blanco" }. Sin cuerpo (o sin preset_key) se
// usa el punto de partida de la cuenta, o barbería si no tiene uno.
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

const NOT_ENABLED = 'El módulo de agenda no está habilitado para esta cuenta.'

const INVALID_PRESET = 'Ese punto de partida no existe.'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    // Cuerpo vacío o ilegible = sin preferencia (el botón de siempre sigue
    // funcionando). Con cuerpo, solo se acepta un objeto con una clave válida.
    const body = await readJsonBody(request)
    let presetKey: PresetKey | undefined
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) return badRequest(INVALID_PRESET)
      const requested = (body as Record<string, unknown>).preset_key
      if (requested !== undefined && requested !== null) {
        if (!isPresetKey(requested)) return badRequest(INVALID_PRESET)
        presetKey = requested
      }
    }

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
      presetKey,
    })

    return NextResponse.json({ report })
  } catch (err) {
    return toErrorResponse(err)
  }
}
