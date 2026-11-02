import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types'
import { getT } from '@/lib/i18n/translate'

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'real_estate_qualified'

export interface TemplateStepSeed {
  step_type: AutomationStepType
  step_config: AutomationStepConfig
  branch?: 'yes' | 'no' | null
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: AutomationTriggerConfig
  steps: TemplateStepSeed[]
}

const t = getT('StarterAutomations')

/** Comma-separated keyword list from the catalogue → trimmed array. */
function keywords(key: string): string[] {
  return t(key)
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}

/**
 * The automation half of the `real_estate` flow template. It's a function
 * because the tag and the stage have per-account ids: the flow install
 * passes the real ones, and the gallery entry below leaves them blank for
 * the owner to pick in the builder.
 */
export function realEstateQualifiedTemplate(ids: {
  tagId: string
  pipelineId: string
  stageId: string
}): AutomationTemplateDefinition {
  return {
    slug: 'real_estate_qualified',
    name: t('real_estate_qualified.name'),
    description: t('real_estate_qualified.description'),
    trigger_type: 'tag_added',
    trigger_config: { tag_id: ids.tagId },
    steps: [
      {
        step_type: 'create_deal',
        step_config: {
          pipeline_id: ids.pipelineId,
          stage_id: ids.stageId,
          title: t('real_estate_qualified.dealTitle'),
        },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  }
}

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  welcome_message: {
    slug: 'welcome_message',
    name: t('welcome_message.name'),
    description: t('welcome_message.description'),
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: t('welcome_message.text'),
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: t('out_of_office.name'),
    description: t('out_of_office.description'),
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: t('out_of_office.text'),
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: t('lead_qualifier.name'),
    description: t('lead_qualifier.description'),
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: keywords('lead_qualifier.keywords'),
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: t('lead_qualifier.text'),
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: t('follow_up_reminder.name'),
    description: t('follow_up_reminder.description'),
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text: t('follow_up_reminder.text'),
        },
      },
    ],
  },
  real_estate_qualified: realEstateQualifiedTemplate({ tagId: '', pipelineId: '', stageId: '' }),
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}
