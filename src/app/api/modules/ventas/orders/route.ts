import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { requireModule, toModuleErrorResponse } from '@/lib/modules/require-module'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { validateOrderCreate } from '@/modules/ventas/orders'
import { createOrder } from '@/modules/ventas/repo'

import { badRequest, deliverNotice, readJsonBody, salesErrorResponse } from '../_lib/http'

// ============================================================
// POST /api/modules/ventas/orders — crea un pedido.
//
// Guardas, en orden: sesión con rol agent o más, módulo Ventas activo
// (409 si no), validación del cuerpo (400). El contacto y la
// conversación deben ser de la cuenta: lo comprueba create_order() en
// la base (404 si no).
//
// El total NUNCA se toma del cuerpo: un `total` o `subtotal` enviado se
// ignora y lo calcula la base a partir de las líneas y el envío.
//
// Respuesta 201: `{ order, notice }`. `notice` es el resultado del aviso
// de pago ('sent' | 'skipped' | 'failed') si el pedido nace pagado, o
// null si no había aviso que mandar. Un fallo de envío nunca deshace el
// pedido.
// ============================================================

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    await requireModule(ctx, 'ventas')

    const parsed = validateOrderCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const db = supabaseAdmin()
    const order = await createOrder(db, ctx, parsed.value)
    const notice = order.payment_status === 'paid' ? await deliverNotice(db, order, 'paid') : null

    return NextResponse.json({ order, notice }, { status: 201 })
  } catch (err) {
    return salesErrorResponse(err) ?? toModuleErrorResponse(err)
  }
}
