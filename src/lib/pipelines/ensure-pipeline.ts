import type { SupabaseClient } from '@supabase/supabase-js'

export interface PipelineStageSeed {
  name: string
  color: string
}

export interface EnsurePipelineArgs {
  accountId: string
  userId: string
  name: string
  stages: PipelineStageSeed[]
}

export interface EnsuredPipeline {
  pipelineId: string
  /** Id de cada etapa pedida, con el nombre tal como se pidió. */
  stageIdByName: Record<string, string>
}

const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase()

function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error
  return result.data
}

/**
 * Deja listo un pipeline de la cuenta (nombre sin importar mayúsculas ni
 * espacios) con sus etapas. Idempotente y respetuoso: crea lo que falta,
 * nunca renombra, mueve ni borra lo que el dueño ya tiene (las etapas
 * propias se quedan; las que faltan se agregan al final).
 *
 * Determinista: con varios pipelines del mismo nombre gana el más antiguo
 * (created_at, id) y con etapas repetidas la de menor posición
 * (position, created_at, id).
 *
 * Límite conocido: sin una restricción única en la base, dos llamadas
 * simultáneas podrían crear dos pipelines iguales. Es raro, no pierde
 * datos, el orden de arriba hace que ambas usen el mismo, y se ve y se
 * arregla desde el CRM.
 *
 * Escribe con el cliente que reciba: quien pase el service-role decide
 * antes si la persona tiene permiso, porque RLS reserva los pipelines
 * para admin.
 */
export async function ensurePipeline(
  db: SupabaseClient,
  { accountId, userId, name, stages }: EnsurePipelineArgs,
): Promise<EnsuredPipeline> {
  const pipelines = unwrap(
    await db
      .from('pipelines')
      .select('id, name')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ) as { id: string; name: string }[] | null
  const found = (pipelines ?? []).find((row) => norm(row.name) === norm(name))

  let pipelineId = found?.id
  if (!pipelineId) {
    pipelineId = crypto.randomUUID()
    unwrap(
      await db.from('pipelines').insert({ id: pipelineId, account_id: accountId, user_id: userId, name }),
    )
  }

  const existing = unwrap(
    await db
      .from('pipeline_stages')
      .select('id, name, position')
      .eq('pipeline_id', pipelineId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ) as { id: string; name: string; position: number | null }[] | null

  const idByNormName = new Map<string, string>()
  let nextPosition = 0
  for (const stage of existing ?? []) {
    if (!idByNormName.has(norm(stage.name))) idByNormName.set(norm(stage.name), stage.id)
    nextPosition = Math.max(nextPosition, (stage.position ?? -1) + 1)
  }

  const missing = stages.filter((stage) => !idByNormName.has(norm(stage.name)))
  if (missing.length > 0) {
    const rows = missing.map((stage, index) => {
      const id = crypto.randomUUID()
      idByNormName.set(norm(stage.name), id)
      return {
        id,
        pipeline_id: pipelineId,
        name: stage.name,
        position: nextPosition + index,
        color: stage.color,
      }
    })
    unwrap(await db.from('pipeline_stages').insert(rows))
  }

  const stageIdByName = Object.fromEntries(
    stages.map((stage) => [stage.name, idByNormName.get(norm(stage.name)) as string]),
  )
  return { pipelineId, stageIdByName }
}
