import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateConfigPatch } from '@/verticals/agenda/config'
import {
  saveSettings,
  updateAccountCurrency,
} from '@/verticals/agenda/config-repo'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// ============================================================
// PATCH /api/verticals/agenda/config
//
// Ajustes del negocio y del bot desde /agenda/configuracion:
// dirección, moneda, señal de 2 h, textos del bot, palabras del
// negocio (`labels`), piezas prendidas/apagadas (`toggles`, claves
// en snake_case de columna: choose_staff, show_price, ...) y el
// punto de partida (`preset_key`).
//
// `labels`: la UI manda siempre las seis palabras, pero el servidor
// MEZCLA lo recibido con lo ya guardado (saveSettings), así que un
// cuerpo parcial nunca borra el resto. Una palabra enviada como null o
// en blanco vuelve a su valor por defecto (se quita de lo guardado).
// Una pieza que no es true/false
// es 400; nunca se ignora en silencio.
//
// Guardas:
//   - requireRole('admin'): solo owner/admin configuran. La RLS de
//     booking_settings/accounts es la segunda capa.
//   - Cada campo se valida en verticals/agenda/config.ts (mensajes
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
      patch.botTexts !== undefined ||
      patch.labels !== undefined ||
      patch.toggles !== undefined ||
      patch.presetKey !== undefined
    ) {
      settings = await saveSettings(ctx.supabase, ctx.accountId, {
        address: patch.address,
        reminders2hEnabled: patch.reminders2hEnabled,
        botTexts: patch.botTexts,
        labels: patch.labels,
        labelsReset: patch.labelsReset,
        toggles: patch.toggles,
        presetKey: patch.presetKey,
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
