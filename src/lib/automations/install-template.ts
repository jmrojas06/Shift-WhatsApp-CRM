import type { SupabaseClient } from '@supabase/supabase-js'

import { insertSteps, type BuilderStepInput } from './steps-tree'
import type { AutomationTemplateDefinition } from './templates'

interface InstallAutomationArgs {
  accountId: string
  userId: string
  automation: AutomationTemplateDefinition
}

/**
 * Adds an already-resolved `tag_added` automation to the account, active:
 * it has nothing to personalise, and forgetting a switch would silently
 * leave the funnel empty. Nothing fires until the tag is applied, which
 * only happens once the owner activates the draft flow or tags by hand.
 *
 * Skips the install when the account already has an automation on that
 * tag, whatever its name or state: two would create every deal twice, and
 * a paused one stays paused. Returns an error message, or null.
 */
export async function installTagAutomation(
  db: SupabaseClient,
  { accountId, userId, automation }: InstallAutomationArgs,
): Promise<string | null> {
  const { tag_id: tagId } = automation.trigger_config as { tag_id: string }

  const { data: existing, error: readError } = await db
    .from('automations')
    .select('trigger_config')
    .eq('account_id', accountId)
    .eq('trigger_type', automation.trigger_type)
  if (readError) return readError.message
  const rows = (existing ?? []) as { trigger_config: { tag_id?: string } | null }[]
  if (rows.some((row) => row.trigger_config?.tag_id === tagId)) return null

  const automationId = crypto.randomUUID()
  const { error: insertError } = await db.from('automations').insert({
    id: automationId,
    account_id: accountId,
    user_id: userId,
    name: automation.name,
    description: automation.description,
    trigger_type: automation.trigger_type,
    trigger_config: automation.trigger_config,
    is_active: true,
  })
  if (insertError) return insertError.message

  const stepsError = await insertSteps(
    automationId,
    automation.steps as unknown as BuilderStepInput[],
  )
  if (stepsError) {
    // An automation with no steps would pass the check above on a retry
    // and sit there active, doing nothing.
    await db.from('automations').delete().eq('id', automationId)
    return stepsError
  }
  return null
}
