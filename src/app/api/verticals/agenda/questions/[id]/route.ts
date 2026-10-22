import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { deleteQuestion, updateQuestion } from '@/verticals/agenda/config-repo'
import { validateQuestionCreate } from '@/verticals/agenda/questions'

import { badRequest, configErrorResponse, readJsonBody } from '../../_lib/http'

// ============================================================
// PATCH  /api/verticals/agenda/questions/[id] — reemplaza la definición
// COMPLETA (etiqueta, tipo, obligatoria y opciones): no es un parche
// parcial, así que la interfaz debe mandar todos los campos. Lo que
// falte toma el valor por defecto (p. ej. `required` vuelve a true).
// El orden, la cuenta y el estado activo nunca se cambian por aquí.
// DELETE /api/verticals/agenda/questions/[id] — la desactiva (no se
// borra: las citas guardan sus respuestas por id de pregunta).
//
// Un id de otra cuenta, o de una pregunta ya desactivada, se
// comporta como inexistente (404).
// ============================================================

interface RouteContext {
  // Next 16: los parámetros dinámicos llegan como Promise.
  params: Promise<{ id: string }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const parsed = validateQuestionCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const question = await updateQuestion(ctx.supabase, ctx.accountId, id, parsed.value)
    return NextResponse.json({ question })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    await deleteQuestion(ctx.supabase, ctx.accountId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
