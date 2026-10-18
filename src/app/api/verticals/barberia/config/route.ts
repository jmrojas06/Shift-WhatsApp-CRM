import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateConfigPatch } from '@/verticals/barberia/config'
import {
  saveSettings,
  updateAccountCurrency,
} from '@/verticals/barberia/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// ============================================================
// PATCH /api/verticals/barberia/config
//
// Ajustes del negocio y del bot desde /barberia/configuracion:
// dirección, moneda, señal de 2 h y textos del bot.
//
// Guardas:
//   - requireRole('admin'): solo owner/admin configuran. La RLS de
//     booking_settings/accounts es la segunda capa.
//   - Cada campo se valida en verticals/barberia/config.ts (mensajes
//     en es-CO); el cuerpo admite cambios parciales — mandar solo la
//     dirección no toca los textos ni la señal.
//   - Las escrituras van con el cliente RLS del usuario y acotadas a
//     `ctx.accountId`; aquí no hay service-role.
// ============================================================

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const parsed = validateConfigPatch(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)
    const patch = parsed.value

    let settings = null
    if (
      patch.address !== undefined ||
      patch.reminders2hEnabled !== undefined ||
      patch.botTexts !== undefined
    ) {
      settings = await saveSettings(ctx.supabase, ctx.accountId, {
        address: patch.address,
        reminders2hEnabled: patch.reminders2hEnabled,
        botTexts: patch.botTexts,
      })
    }

    let currency: string | null = null
    if (patch.currency !== undefined) {
      currency = await updateAccountCurrency(
        ctx.supabase,
        ctx.accountId,
        patch.currency,
      )
    }

    return NextResponse.json({ settings, currency })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
