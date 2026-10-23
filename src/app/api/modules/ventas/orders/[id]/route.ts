import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { requireModule, toModuleErrorResponse } from '@/lib/modules/require-module'
import { supabaseAdmin } from '@/lib/verticals/admin-client'
import { isOrderAction } from '@/modules/ventas/orders'
import { updateOrderStatus } from '@/modules/ventas/repo'

import {
  badRequest,
  deliverNotice,
  isRecord,
  readJsonBody,
  salesErrorResponse,
} from '../../_lib/http'

// ============================================================
// PATCH /api/modules/ventas/orders/[id] — cambia el estado de un pedido.
//
// Cuerpo: { action: 'mark_paid' | 'mark_shipped' | 'mark_delivered' |
// 'cancel', carrier?, tracking_number?, city?, address? }. Las reglas
// (qué acción vale en qué estado, qué datos exige "enviado") viven en
// src/modules/ventas/orders.ts.
//
// Un id de otra cuenta, o que no es un uuid, se comporta como
// inexistente (404): el repositorio filtra por `account_id`.
//
// Respuesta: `{ order, notice }`. `notice` es el resultado del aviso al
// cliente ('sent' | 'skipped' | 'failed') solo cuando la acción cambió
// algo y tiene aviso (pagado, enviado, entregado); si no, null.
// 'skipped' = el interruptor de ese aviso está apagado. Un fallo de
// envío nunca deshace el cambio.
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('agent')
    await requireModule(ctx, 'ventas')
    const { id } = await params

    const body = await readJsonBody(request)
    if (!isRecord(body)) return badRequest('Los datos no son válidos.')
    if (!isOrderAction(body.action)) return badRequest('La acción no es válida.')

    const db = supabaseAdmin()
    const result = await updateOrderStatus(db, ctx, id, body.action, {
      carrier: body.carrier,
      tracking_number: body.tracking_number,
      city: body.city,
      address: body.address,
    })

    // El pedido que se devuelve ya trae el resultado del aviso (last_notice*).
    const delivered =
      result.changed && result.notice
        ? await deliverNotice(db, result.order, result.notice)
        : null

    return NextResponse.json({
      order: delivered?.order ?? result.order,
      notice: delivered?.notice ?? null,
    })
  } catch (err) {
    return salesErrorResponse(err) ?? toModuleErrorResponse(err)
  }
}
