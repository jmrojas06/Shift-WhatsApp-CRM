import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { readTelnyxConfig } from '@/lib/voice/telnyx'
import {
  callSettingsToPayload,
  type CallSettingsResponse,
} from '@/verticals/agenda/voice/call-settings-payload'
import {
  CALL_SETTINGS_COLUMNS,
  callSettingsFromRow,
  callSettingsToRow,
  loadCallSettings,
  mergeAndValidateWindow,
  validateCallSettingsPatch,
  type CallSettings,
} from '@/verticals/agenda/voice/settings'
import { bogotaMonthRange, countMonthlyRobotCalls } from '@/verticals/agenda/voice/usage'

import { badRequest, readJsonBody } from '../_lib/http'

// ============================================================
// /api/verticals/agenda/call-settings
//
//   GET   — la configuración de llamadas de la cuenta, lo usado en el mes
//           y si el servidor tiene las variables de Telnyx. Cualquier
//           miembro (RLS: los miembros leen).
//   PATCH — guarda cambios parciales (owner/admin). El cuerpo lleva las
//           claves como las columnas (`outbound_enabled`, `window_start`…)
//           y se valida con `validateCallSettingsPatch`.
//
// Guardas:
//   - requireRole('admin') en el PATCH. Se escribe con el cliente RLS del
//     usuario (el admin puede escribir; aquí no hay service role) y la base
//     tiene un trigger (056) que rechaza cambiar las cuatro columnas de Shift.
//   - `provider`, `monthly_limit`, `inbound_number` y `caller_id` no se
//     aceptan: el validador rechaza el parche entero con un mensaje claro.
//   - Las llamadas no se pueden PRENDER si falta Telnyx en el servidor o el
//     número que Shift asigna: se puede guardar todo lo demás, y apagar
//     siempre se puede. Mandar "prendido" cuando ya estaba prendido no es
//     prender.
//   - La respuesta nunca lleva valores de las variables de Telnyx: solo si
//     están todas puestas.
// ============================================================

const TEXTS = {
  telnyxMissing:
    'Las llamadas todavía no están listas en este servidor: falta un paso de Shift. Puedes guardar tu configuración y prenderlas cuando Shift lo confirme.',
  outboundNeedsNumber:
    'Para prender las llamadas salientes, Shift primero debe asignarte un número que marque. Escríbenos y lo dejamos listo.',
  inboundNeedsNumber:
    'Para prender las llamadas entrantes, Shift primero debe asignarte un número. Escríbenos y lo dejamos listo.',
  shiftColumns:
    'Esa parte de la configuración la controla Shift y no se puede cambiar desde el panel. Si necesitas cambiarla, pídeselo a Shift.',
  saveFailed: 'No se pudo guardar la configuración de llamadas.',
} as const

/** Lo que `usage` y `telnyx` agregan a la configuración en las dos respuestas. */
async function buildResponse(
  db: Parameters<typeof countMonthlyRobotCalls>[0],
  accountId: string,
  settings: CallSettings,
): Promise<CallSettingsResponse> {
  const now = new Date()
  const used = await countMonthlyRobotCalls(db, accountId, now)
  return {
    settings: callSettingsToPayload(settings),
    usage: { month: bogotaMonthRange(now).month, used },
    telnyx: { configured: readTelnyxConfig().ok },
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('viewer')

    const settings = await loadCallSettings(ctx.supabase, ctx.accountId)
    return NextResponse.json(await buildResponse(ctx.supabase, ctx.accountId, settings))
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const parsed = validateCallSettingsPatch(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)
    const patch = parsed.value

    const stored = await loadCallSettings(ctx.supabase, ctx.accountId)

    // Con una sola hora en el parche se revisa contra la guardada, y se
    // escriben las dos juntas: la fila propuesta del upsert (INSERT … ON
    // CONFLICT) también pasa por el CHECK `window_end > window_start`.
    const window = mergeAndValidateWindow(stored, patch)
    if (!window.ok) return badRequest(window.message)
    if (patch.windowStart !== undefined || patch.windowEnd !== undefined) {
      patch.windowStart = window.value.windowStart
      patch.windowEnd = window.value.windowEnd
    }

    const turningOnOutbound = patch.outboundEnabled === true && !stored.outboundEnabled
    const turningOnInbound = patch.inboundEnabled === true && !stored.inboundEnabled
    if (turningOnOutbound || turningOnInbound) {
      if (!readTelnyxConfig().ok) {
        return NextResponse.json({ error: TEXTS.telnyxMissing }, { status: 409 })
      }
      if (turningOnOutbound && !(stored.callerId ?? stored.inboundNumber)) {
        return NextResponse.json({ error: TEXTS.outboundNeedsNumber }, { status: 409 })
      }
      if (turningOnInbound && !stored.inboundNumber) {
        return NextResponse.json({ error: TEXTS.inboundNeedsNumber }, { status: 409 })
      }
    }

    const { data, error } = await ctx.supabase
      .from('booking_call_settings')
      .upsert({ account_id: ctx.accountId, ...callSettingsToRow(patch) }, { onConflict: 'account_id' })
      .select(CALL_SETTINGS_COLUMNS)
      .maybeSingle()
    if (error) {
      // 42501: el trigger de la 056 (o la RLS) rechazó la escritura.
      if (error.code === '42501') {
        return NextResponse.json({ error: TEXTS.shiftColumns }, { status: 403 })
      }
      throw new Error(`${TEXTS.saveFailed} ${error.message}`)
    }
    if (!data) throw new Error(TEXTS.saveFailed)

    const saved = callSettingsFromRow(data as unknown as Record<string, unknown>)
    return NextResponse.json(await buildResponse(ctx.supabase, ctx.accountId, saved))
  } catch (err) {
    return toErrorResponse(err)
  }
}
