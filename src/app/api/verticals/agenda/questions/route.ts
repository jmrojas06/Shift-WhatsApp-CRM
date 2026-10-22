import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createQuestion } from '@/verticals/agenda/config-repo'
import { validateQuestionCreate } from '@/verticals/agenda/questions'

import { badRequest, configErrorResponse, readJsonBody } from '../_lib/http'

// ============================================================
// POST /api/verticals/agenda/questions
//
// Crea una pregunta extra del bot (owner/admin), al final del
// orden y en la cuenta de la sesión. Máximo 5 activas: la sexta
// responde 409 (`limit_reached`).
// ============================================================

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const parsed = validateQuestionCreate(await readJsonBody(request))
    if (!parsed.ok) return badRequest(parsed.message)

    const question = await createQuestion(ctx.supabase, ctx.accountId, parsed.value)
    return NextResponse.json({ question })
  } catch (err) {
    return configErrorResponse(err) ?? toErrorResponse(err)
  }
}
