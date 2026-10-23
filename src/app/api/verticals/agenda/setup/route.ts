import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { requireModule, toModuleErrorResponse } from '@/lib/modules/require-module'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { installAgendaTemplate } from '@/verticals/agenda/install'
import { isPresetKey, type PresetKey } from '@/verticals/agenda/presets'

import { badRequest } from '../_lib/http'

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
//   - La cuenta debe tener el módulo agenda activo (`modules` de la
//     migración 053 o, mientras esté vacío, `vertical_key` 'agenda' /
//     la clave anterior 'barberia'). Si no se puede leer la cuenta,
//     cuenta como sin módulo: 409, nunca se instala a ciegas.
//   - La instalación escribe con service-role, pero SIEMPRE acotada
//     a `ctx.accountId`; el rol humano se valida antes.
//
// Idempotente: repetir la llamada no duplica ni sobrescribe datos
// del dueño (ver install.ts).
// ============================================================

const INVALID_PRESET = 'Ese punto de partida no existe.'
const INVALID_BODY = 'El cuerpo no es JSON válido.'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    // Cuerpo vacío = sin preferencia (el botón de siempre sigue funcionando).
    // Con cuerpo, tiene que ser un objeto JSON; un JSON roto es 400, no "usa
    // el valor por defecto". La clave, si viene, tiene que existir.
    const raw = await request.text()
    let presetKey: PresetKey | undefined
    if (raw.trim() !== '') {
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return badRequest(INVALID_BODY)
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return badRequest(INVALID_BODY)
      }
      const requested = (body as Record<string, unknown>).preset_key
      if (requested !== undefined && requested !== null) {
        if (!isPresetKey(requested)) return badRequest(INVALID_PRESET)
        presetKey = requested
      }
    }

    await requireModule(ctx, 'agenda')

    const report = await installAgendaTemplate({
      db: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
      presetKey,
    })

    return NextResponse.json({ report })
  } catch (err) {
    return toModuleErrorResponse(err)
  }
}
