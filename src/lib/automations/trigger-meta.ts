import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

/**
 * The user-visible trigger name lives in the message catalogue
 * (`Automations.builder.triggers.<id>.label`); this module only carries
 * the styling so it stays free of React and of locale.
 *
 * Calm, token-based pills: the trigger name already says what it is, so
 * every pill shares one neutral style (no rainbow of hues).
 */
const NEUTRAL_PILL = 'border-border bg-muted text-muted-foreground'

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: { pillClass: NEUTRAL_PILL },
  first_inbound_message: { pillClass: NEUTRAL_PILL },
  keyword_match: { pillClass: NEUTRAL_PILL },
  new_contact_created: { pillClass: NEUTRAL_PILL },
  conversation_assigned: { pillClass: NEUTRAL_PILL },
  tag_added: { pillClass: NEUTRAL_PILL },
  time_based: { pillClass: NEUTRAL_PILL },
  interactive_reply: { pillClass: NEUTRAL_PILL },
}

export function isKnownTrigger(t: string): t is AutomationTriggerType {
  return Object.prototype.hasOwnProperty.call(TRIGGER_META, t)
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return TRIGGER_META[t as AutomationTriggerType] ?? { pillClass: NEUTRAL_PILL }
}

export type RelativeTimeKey = 'never' | 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo'

/**
 * Translator for the `Automations.relative` namespace. Typed loosely so
 * next-intl's `useTranslations("Automations.relative")` result can be
 * passed straight in without this module importing React or next-intl.
 */
export type RelativeTimeTranslator = (key: RelativeTimeKey, values?: { n: number }) => string

export function formatRelative(
  iso: string | null | undefined,
  t: RelativeTimeTranslator,
): string {
  if (!iso) return t('never')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('never')
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('justNow')
  if (diffSec < 3600) return t('minutesAgo', { n: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('hoursAgo', { n: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('daysAgo', { n: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
