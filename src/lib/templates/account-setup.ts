import type { SupabaseClient } from '@supabase/supabase-js'

import {
  ensurePipeline,
  type PipelineStageSeed,
} from '@/lib/pipelines/ensure-pipeline'

/**
 * What a template needs to exist in the account before it can run. Flows
 * and automations point at tags and pipeline stages by UUID, and those
 * differ per account, so a template that uses them can't be static JSON:
 * it declares them here and gets their ids at install time.
 */
export interface TemplateSetup {
  /** Keyed by the name the template uses to refer to each tag. */
  tags: Record<string, { name: string; color: string }>
  pipeline: { name: string; stages: PipelineStageSeed[] }
}

export interface TemplateResources {
  /** Same keys as `TemplateSetup.tags`. */
  tagIds: Record<string, string>
  pipelineId: string
  stageIdByName: Record<string, string>
}

interface EnsureTemplateSetupArgs {
  accountId: string
  userId: string
  setup: TemplateSetup
}

/**
 * Creates what's missing and reuses what's there, matching by name without
 * regard to case. Installing twice duplicates nothing, and nothing the
 * owner already has is renamed or removed.
 */
export async function ensureTemplateSetup(
  db: SupabaseClient,
  { accountId, userId, setup }: EnsureTemplateSetupArgs,
): Promise<TemplateResources> {
  const { data, error } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
  if (error) throw error

  const idByName = new Map(
    ((data ?? []) as { id: string; name: string }[]).map((tag) => [tag.name.toLowerCase(), tag.id]),
  )
  const newTags: Record<string, unknown>[] = []
  const tagIds: Record<string, string> = {}
  for (const [key, tag] of Object.entries(setup.tags)) {
    let id = idByName.get(tag.name.toLowerCase())
    if (!id) {
      id = crypto.randomUUID()
      idByName.set(tag.name.toLowerCase(), id)
      newTags.push({ id, account_id: accountId, user_id: userId, name: tag.name, color: tag.color })
    }
    tagIds[key] = id
  }
  if (newTags.length > 0) {
    const { error: insertError } = await db.from('tags').insert(newTags)
    if (insertError) throw insertError
  }

  const { pipelineId, stageIdByName } = await ensurePipeline(db, {
    accountId,
    userId,
    name: setup.pipeline.name,
    stages: setup.pipeline.stages,
  })
  return { tagIds, pipelineId, stageIdByName }
}
